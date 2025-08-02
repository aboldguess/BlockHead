// Simple full stack app to manage multiple websites using Nginx server blocks
// This server is built with Express and serves EJS templates.
// It allows creating, updating, and deleting website configurations stored in a JSON file
// Each configuration can be used to generate an Nginx server block
// Git operations such as cloning and pulling updates are performed via simple-git

const express = require('express');
const path = require('path');
const fs = require('fs');
const simpleGit = require('simple-git');
const archiver = require('archiver');
const extract = require('extract-zip'); // Used to unpack GoDaddy zip bundles
const multer = require('multer'); // Middleware for handling certificate file uploads
const http = require('http');
// exec runs one-off shell commands while spawn is used below for
// background processes such as starting an app server
const { exec, spawn } = require('child_process');
const os = require('os');

const app = express();
const PORT = 3000; // Change to 80 if running as root for HTTP
const DATA_FILE = path.join(__dirname, 'sites.json');
const SSL_DIR = path.join(__dirname, 'ssl'); // Folder for user-provided SSL certs
// Absolute path to the main nginx configuration file. This is used by the
// new configuration editor so operators can tweak settings directly from the UI.
const NGINX_CONFIG = '/etc/nginx/nginx.conf';

// Configure Multer to store uploaded cert bundles in a temporary directory
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// --------------------------------------
// Simple in-memory log store used by the
// Advanced console panel in the UI. Each
// log entry captures the level, message
// and timestamp. The last 200 entries are
// kept in memory.
// --------------------------------------
const logs = [];
const origLog = console.log;
const origError = console.error;

// Override console methods so that every
// call is recorded for later viewing via
// the /logs endpoint.
console.log = (...args) => {
  origLog(...args);
  logs.push({ level: 'log', message: args.join(' '), time: new Date().toISOString() });
  if (logs.length > 200) logs.shift();
};

console.error = (...args) => {
  origError(...args);
  logs.push({ level: 'error', message: args.join(' '), time: new Date().toISOString() });
  if (logs.length > 200) logs.shift();
};

// Keep track of child processes started via the Run button. Each domain maps
// to a spawned process so we can terminate it later using the Stop button.
const runningProcs = {};

// Determine the IP address used for the "View via IP" links. If the
// SERVER_IP environment variable is set it takes precedence. Otherwise
// we try to detect a non-internal IPv4 address so the user sees the
// correct address for their LAN without manual configuration.
function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  // Fallback to localhost if nothing was detected
  return '127.0.0.1';
}

const SERVER_IP = process.env.SERVER_IP || getLocalIp();

// Validate that a domain contains only expected characters.
// This protects file operations and shell commands from
// malicious input such as path traversal or command injection.
function isValidDomain(domain) {
  return /^[A-Za-z0-9.-]+$/.test(domain);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint used by the front-end advanced panel
// to retrieve recent log messages as JSON.
app.get('/logs', (req, res) => {
  res.json(logs);
});

// --------------------------------------
// Nginx Configuration Editor Endpoints
// --------------------------------------

// Simple mode allows operators to tweak basic settings such as the
// root directory or proxy port for each configured site. The list of
// sites is displayed in a dropdown at the top of the page.
app.get('/nginx', (req, res) => {
  const sites = loadSites();
  const domainQuery = req.query.site;
  // Validate the requested domain, if any, before using it
  if (domainQuery && !isValidDomain(domainQuery)) {
    return res.status(400).send('Invalid domain');
  }
  const domain = domainQuery || (sites[0] && sites[0].domain);
  const site = sites.find(s => s.domain === domain) || null;
  res.render('nginx', {
    sites,
    site,
    saved: Boolean(req.query.saved)
  });
});

// Persist basic settings edited in simple mode and regenerate the
// corresponding nginx server block. After writing the new config the
// helper script is invoked to reload nginx.
app.post('/nginx', async (req, res) => {
  const { domain, root, port } = req.body;
  // Reject domains containing unexpected characters
  if (!isValidDomain(domain)) return res.status(400).send('Invalid domain');
  const sites = loadSites();
  const site = sites.find(s => s.domain === domain);
  if (!site) return res.redirect('/nginx');
  site.root = root;
  site.port = port ? Number(port) : undefined;
  saveSites(sites);
  generateNginxConfig(site);
  try {
    await enableSite(site.domain);
  } catch (err) {
    console.error('Failed to enable site:', err.message);
  }
  res.redirect(`/nginx?site=${domain}&saved=1`);
});

// Expert mode exposes the raw nginx configuration file for advanced
// tweaking. Operators can choose either a site-specific config or the
// global nginx.conf file.
app.get('/nginx/expert', (req, res) => {
  const sites = loadSites();
  const domainQuery = req.query.site;
  // Ensure supplied domain is valid before using it to build a file path
  if (domainQuery && !isValidDomain(domainQuery)) {
    return res.status(400).send('Invalid domain');
  }
  const domain = domainQuery || '';
  let filePath = NGINX_CONFIG;
  if (domain) filePath = path.join(__dirname, 'generated_configs', domain);
  let config = '';
  try {
    config = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error('Unable to read nginx config:', err.message);
  }
  res.render('nginx-expert', {
    config,
    filePath,
    sites,
    domain,
    saved: Boolean(req.query.saved),
    // Pass along any error message from a failed reload so the template can display it
    error: req.query.error || null,
  });
});

// Save changes made in expert mode to the selected configuration file and
// attempt to reload nginx so the new settings take effect immediately.
app.post('/nginx/expert', (req, res) => {
  const { domain, config } = req.body;
  // Validate domain when saving a site-specific configuration
  if (domain && !isValidDomain(domain)) {
    return res.status(400).send('Invalid domain');
  }
  let filePath = NGINX_CONFIG;
  if (domain) {
    // Ensure the directory for generated configs exists before writing
    const dir = path.join(__dirname, 'generated_configs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    filePath = path.join(dir, domain);
  }
  try {
    fs.writeFileSync(filePath, config);
    // Attempt to reload nginx so the operator can immediately test their changes
    exec('nginx -s reload', (err) => {
      if (err) {
        // Failure path: surface the error and notify the UI that the save failed
        console.error('Nginx reload failed:', err.message);
        return res.redirect(`/nginx/expert?site=${domain}&saved=0&error=${encodeURIComponent(err.message)}`);
      }
      // Success path: reload worked, inform the user the configuration was saved
      console.log('Nginx reloaded successfully');
      res.redirect(`/nginx/expert?site=${domain}&saved=1`);
    });
  } catch (err) {
    // Writing the file itself failed before we could attempt a reload
    console.error('Failed to write nginx config:', err.message);
    res.redirect(`/nginx/expert?site=${domain}&saved=0&error=${encodeURIComponent(err.message)}`);
  }
});

// Utility function to load site data from JSON file
// This cached copy stores the most recently parsed site data so that we can
// recover gracefully if the JSON on disk becomes malformed.
let cachedSites = [];

function loadSites() {
  // If the data file doesn't exist yet, treat it as having no sites configured.
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    // Attempt to parse the JSON file and update our cached copy on success.
    const data = JSON.parse(fs.readFileSync(DATA_FILE));
    cachedSites = data;
    return data;
  } catch (err) {
    // Parsing failed: log the error and fall back to the last known good state
    // (an empty array if we've never successfully loaded the file).
    console.error(`Failed to parse site data from ${DATA_FILE}:`, err);
    return cachedSites;
  }
}

// Utility function to save site data to JSON file
function saveSites(sites) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(sites, null, 2));
  // Persist the updated site list in memory as the new last known good state.
  cachedSites = sites;
}

// Run a shell command and return a promise that resolves when it completes.
// Output is logged so the user can troubleshoot install/start failures.
function runCommand(cmd, cwd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd }, (err, stdout, stderr) => {
      if (err) {
        console.error(`Command failed: ${cmd}\n${stderr}`);
        reject(err);
      } else {
        if (stdout) console.log(stdout.trim());
        resolve();
      }
    });
  });
}

// Perform a basic SSL check using openssl to confirm certificates are served
// correctly. The function resolves with an object describing the outcome so
// callers can log or display the result.
function testSsl(domain) {
  return new Promise((resolve, reject) => {
    exec(`openssl s_client -servername ${domain} -connect ${domain}:443 < /dev/null`, (err, stdout, stderr) => {
      if (err) {
        return reject(stderr || err.message);
      }
      const ok = stdout.includes('Verify return code: 0 (ok)');
      resolve({ ok, output: stdout + stderr });
    });
  });
}

// Start an application using the standard "npm start" script in detached mode.
// The process continues running independently of this Node server.
function startApp(cwd, port) {
  // Pass the PORT environment variable when a port is provided so
  // frameworks that rely on process.env.PORT (like Express) pick it up.
  const env = { ...process.env };
  if (port) env.PORT = port;

  const child = spawn('npm', ['start'], {
    cwd,
    env,
    detached: true,
    stdio: 'ignore',
  });
  // Log failures that occur when spawning the process so the
  // user can diagnose missing binaries or permission issues.
  child.on('error', (err) => {
    console.error(`Failed to start npm app in ${cwd}: ${err.message}`);
  });
  child.unref();
}

// Enable a site at the Nginx level by running the helper script. The command is
// wrapped in a promise so callers can "await" it and handle failures. If nginx
// cannot reload (for example, the service is misconfigured), the promise
// rejects with the stderr output so the caller can surface a clear message to
// the user instead of silently redirecting.
function enableSite(domain) {
  return new Promise((resolve, reject) => {
    // Run the helper script with sudo so it can modify nginx files in /etc.
    // Using cwd ensures the relative script path resolves even if the server
    // is launched from a different directory.
    exec(`sudo bash scripts/enable_site.sh ${domain}`, { cwd: __dirname }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr.trim() || err.message;
        console.error(`Auto-enable failed for ${domain}: ${message}`);
        return reject(new Error(message));
      }
      if (stdout) {
        // Surface any helpful output from the script such as success messages
        console.log(stdout.trim());
      }
      resolve();
    });
  });
}

// Spawn a custom command for a site. The entire command string is executed by
// the system shell rather than manually splitting into executable and
// arguments. The resulting child process is stored so it can be terminated later.
function runSiteCommand(domain, cmd, cwd, port) {
  // Preserve the existing environment but inject PORT if provided so
  // scripts that rely on process.env.PORT still work.
  const env = { ...process.env };
  if (port) env.PORT = port;

  // Use a shell to interpret the complete command string. The `shell: true`
  // option is required for multi-word commands (e.g. "npm run start") to run
  // correctly, but avoid passing untrusted input here since it will be executed
  // by the shell.
  const child = spawn(cmd, {
    cwd,
    env,
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  // Surface spawn errors such as missing executables. Without this
  // feedback it can appear as if the process simply never started.
  child.on('error', (err) => {
    console.error(`Failed to start command "${cmd}" for ${domain}: ${err.message}`);
  });
  child.unref();
  // Track the process so it can be terminated later via /stop
  runningProcs[domain] = child;
  console.log(`Started "${cmd}" for ${domain} (pid ${child.pid})`);
}

// Stop a running command previously started via runSiteCommand. If the process
// is found, kill its process group so any children are also terminated.
function stopSiteCommand(domain) {
  const child = runningProcs[domain];
  if (child) {
    try {
      process.kill(-child.pid);
      console.log(`Stopped command for ${domain}`);
    } catch (err) {
      console.error('Failed to stop process:', err);
    }
    delete runningProcs[domain];
  }
}

// Diagnostic test: check if a site is reachable and properly configured
async function checkSiteStatus(site) {
  const configPath = path.join(__dirname, 'generated_configs', site.domain);

  // Missing root directory or config is treated as an error
  if (!fs.existsSync(site.root) || !fs.existsSync(configPath)) {
    return { level: 'error', message: 'Missing files or config' };
  }

  // Attempt a simple HTTP request to determine reachability
  return new Promise(resolve => {
    const req = http.get(`http://${site.domain}`, res => {
      res.resume();
      if (res.statusCode < 400) {
        resolve({ level: 'ok', message: 'Site reachable' });
      } else {
        resolve({ level: 'warning', message: `HTTP ${res.statusCode}` });
      }
    });

    req.on('error', () => {
      resolve({ level: 'warning', message: 'Request failed' });
    });

    // Treat a 3s timeout as a failed request
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ level: 'warning', message: 'Timeout' });
    });
  });
}

// List all configured sites with diagnostic status information
app.get('/', async (req, res) => {
  const sites = loadSites();

  // Run diagnostics for each site in parallel
  const statuses = await Promise.all(sites.map(checkSiteStatus));
  sites.forEach((site, idx) => {
    site.status = statuses[idx];
  });

  // Pass the server IP so the template can build the "View via IP" links
  res.render('index', { sites, serverIp: SERVER_IP });
});

// Serve a friendly help page with step-by-step setup instructions
app.get('/help', (req, res) => {
  // No dynamic data required, simply render the EJS template
  res.render('help');
});

// Show form to create new site. The server suggests the next available port
// starting at 3001 so users don't have to pick one manually.
app.get('/new', (req, res) => {
  const sites = loadSites();
  const used = sites.map(s => Number(s.port)).filter(Boolean);
  let port = 3001;
  while (used.includes(port)) port++;
  console.log(`Suggested port ${port} for new site form`);
  res.render('new', { defaultPort: port });
});

// Handle creation of new site
app.post('/new', async (req, res) => {
  const { domain, repo, root, port, cmd } = req.body;
  // Reject malformed domains early to avoid unsafe file operations
  if (!isValidDomain(domain)) return res.status(400).send('Invalid domain');
  // Log the creation request for debugging purposes
  console.log(`Creating new site ${domain} from ${repo} into ${root} on port ${port}`);

  const sites = loadSites();
  const existing = sites.find(s => s.domain === domain);
  if (existing) {
    return res.send('Domain already exists');
  }

  // Ensure the target directory is writable and ready for git clone
  // parentDir is where the repository will be created. Many
  // first-time setups fail because /var/www is missing or owned by root.
  const parentDir = path.dirname(root);
  try {
    // Check that the parent directory exists and is writable
    await fs.promises.access(parentDir, fs.constants.W_OK);
  } catch (err) {
    try {
      // Attempt to create the directory if it doesn't exist. This helps
      // beginners who haven't prepared the folder structure yet.
      await fs.promises.mkdir(parentDir, { recursive: true });
      await fs.promises.access(parentDir, fs.constants.W_OK);
    } catch (mkdirErr) {
      // Provide a command hint so the user can easily fix permissions
      return res
        .status(400)
        .send(
          `Cannot write to ${parentDir}. Try running:\n` +
            `sudo mkdir -p ${parentDir} && sudo chown $(whoami):$(whoami) ${parentDir}`
        );
    }
  }

  try {
    // If the target clone directory already exists, handle it before cloning.
    // Git will refuse to clone into a directory with files.
    if (fs.existsSync(root)) {
      const files = await fs.promises.readdir(root);
      if (files.length > 0) {
        if (req.body.overwrite === 'on') {
          // Overwrite option selected - remove the existing files first
          await fs.promises.rm(root, { recursive: true, force: true });
          console.log(`Removed existing directory ${root}`);
        } else {
          return res
            .status(400)
            .send(
              `Destination ${root} already exists and is not empty. ` +
                `Remove it or choose a different path, or check the Overwrite option.`
            );
        }
      }
    }
  } catch (statErr) {
    // Provide details if we can't read the target directory
    return res.status(500).send(`Failed to access ${root}: ${statErr.message}`);
  }

  try {
    // Attempt to clone the repository to the requested path
    await simpleGit().clone(repo, root);
    // Indicate that cloning completed without errors
    console.log(`Repository cloned successfully for ${domain}`);

    // If the cloned project has a package.json, try to install its
    // dependencies and launch the app automatically. This assumes the
    // project defines a standard "start" script.
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      console.log(`Installing dependencies for ${domain}`);
      try {
        await runCommand('npm install', root);
      } catch (installErr) {
        console.error('Install failed:', installErr);
      }
    }

    if (cmd) {
      console.log(`Starting ${domain} with custom command: ${cmd}`);
      runSiteCommand(domain, cmd, root, port);
    } else if (fs.existsSync(pkgPath)) {
      // Fall back to the standard npm start workflow
      console.log(`Starting application for ${domain} on port ${port}`);
      startApp(root, port);
    }
  } catch (err) {
    console.error('Clone error:', err);
    // Provide a helpful message along with the git error text
    let message = 'Error cloning repository. ';
    if (err.message) {
      message += err.message;
    }
    // Special case: git already exists error is common for beginners
    if (err.message && err.message.includes('already exists and is not an empty')) {
      return res
        .status(400)
        .send(
          `Destination ${root} already exists and is not empty. ` +
            `Remove it or pick another directory.`
        );
    }
    message +=
      ' Verify the repository URL and that this process has permission to write to the destination.';
    return res.status(500).send(message);
  }

  const site = { domain, repo, root };
  if (port) site.port = Number(port);
  if (cmd) site.cmd = cmd;
  sites.push(site);
  saveSites(sites);
  generateNginxConfig(site);
  // Try to automatically enable the site so nginx starts serving it. Awaiting
  // the helper ensures we know if nginx rejected the config and can inform the
  // user instead of silently failing.
  try {
    await enableSite(site.domain);
  } catch (err) {
    // Surfacing the error helps operators diagnose problems such as nginx
    // failing to reload.
    return res.status(500).send(`Failed to enable site: ${err.message}`);
  }
  res.redirect('/');
});

// Pull latest changes for a site
app.post('/update', async (req, res) => {
  const { domain } = req.body;
  // Validate domain before performing git operations on the site's directory
  if (!isValidDomain(domain)) return res.status(400).send('Invalid domain');
  const sites = loadSites();
  const site = sites.find(s => s.domain === domain);
  if (!site) return res.sendStatus(404);
  // Notify which site is being updated
  console.log(`Pulling latest for ${domain}`);

  try {
    const git = simpleGit(site.root);
    await git.pull('origin', 'main');
    // Output result of the pull operation
    console.log(`Pull complete for ${domain}`);

    // If a Node.js app is detected, reinstall dependencies (in case package.json
    // changed) and restart the application using the same helper used when
    // cloning. This keeps the running app up to date with minimal effort.
    if (fs.existsSync(path.join(site.root, 'package.json')))
    {
      await runCommand('npm install', site.root);
    }

    if (site.cmd) {
      console.log(`Restarting ${domain} with stored command: ${site.cmd}`);
      runSiteCommand(domain, site.cmd, site.root, site.port);
    } else if (fs.existsSync(path.join(site.root, 'package.json')))
    {
      console.log(`Restarting application for ${domain} on port ${site.port}`);
      startApp(site.root, site.port);
    }
  } catch (err) {
    console.error(err);
    return res.send('Failed to pull updates');
  }
  res.redirect('/');
});

// Create a zip backup of a site's root directory and config
// Create a downloadable archive of a site's files and nginx config
app.post('/backup', (req, res) => {
  const { domain } = req.body;
  // Verify domain is safe before reading files for backup
  if (!isValidDomain(domain)) return res.status(400).send('Invalid domain');
  const sites = loadSites();
  const site = sites.find(s => s.domain === domain);
  if (!site) return res.sendStatus(404);
  // Inform about upcoming backup operation
  console.log(`Preparing backup for ${domain}`);

  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

  // Archive name formatted as domain-timestamp.zip
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveName = `${domain}-${timestamp}.zip`;
  const archivePath = path.join(backupDir, archiveName);
  // Destination path of the generated backup archive
  console.log(`Creating backup for ${domain} at ${archivePath}`);

  const output = fs.createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', () => {
    // Send the zip file for download once archiving is complete
    // Backup archive has been successfully created
    console.log(`Backup created at ${archivePath}`);
    res.download(archivePath, archiveName, err => {
      if (err) console.error(err);
    });
  });

  archive.on('error', err => {
    console.error(err);
    res.sendStatus(500);
  });

  archive.pipe(output);
  // Include site root directory contents in the archive
  archive.directory(site.root, false);

  // Include generated Nginx config if it exists
  const configPath = path.join(__dirname, 'generated_configs', domain);
  if (fs.existsSync(configPath)) {
    archive.file(configPath, { name: `${domain}.nginx` });
  }

  archive.finalize();
});

// Delete a site configuration (does not remove files)
app.post('/delete', (req, res) => {
  const { domain } = req.body;
  // Prevent deletion requests with malformed domain names
  if (!isValidDomain(domain)) return res.status(400).send('Invalid domain');
  let sites = loadSites();
  sites = sites.filter(s => s.domain !== domain);
  saveSites(sites);
  // Acknowledge deletion of site configuration
  console.log(`Removed configuration for ${domain}`);
  res.redirect('/');
});

// Attempt automated repair using the fix_site.sh helper script
app.post('/fix', (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.redirect('/');
  // Avoid passing unvalidated domains to the shell script
  if (!isValidDomain(domain)) return res.status(400).send('Invalid domain');

  exec(`bash scripts/fix_site.sh ${domain}`, (err, stdout, stderr) => {
    if (err) {
      console.error('Fix error:', stderr);
    } else {
      console.log(stdout);
    }
    res.redirect('/');
  });
});

// Run a custom command for a site. The command text is provided by the user via
// the Run button on the main page. The process is started in detached mode so
// it continues running after the request finishes.
app.post('/run', (req, res) => {
  const { domain, cmd } = req.body;
  if (!domain || !cmd) return res.redirect('/');
  // Validate domain before executing arbitrary commands for the site
  if (!isValidDomain(domain)) return res.status(400).send('Invalid domain');
  const sites = loadSites();
  const site = sites.find(s => s.domain === domain);
  if (!site) return res.redirect('/');
  // Pass the site's configured port so the command can reference
  // process.env.PORT if desired.
  runSiteCommand(domain, cmd, site.root, site.port);
  res.redirect('/');
});

// Stop a running command started via the Run button.
app.post('/stop', (req, res) => {
  const { domain } = req.body;
  // If a domain is provided ensure it passes validation before attempting to stop
  if (domain && !isValidDomain(domain)) return res.status(400).send('Invalid domain');
  if (domain) stopSiteCommand(domain);
  res.redirect('/');
});

// Render the SSL configuration form for a specific domain
app.get('/ssl/:domain', (req, res) => {
  const { domain } = req.params;
  // Validate domain used to render SSL configuration form
  if (!isValidDomain(domain)) return res.status(400).send('Invalid domain');
  res.render('ssl', { domain });
});

// Accept certificate and key data then regenerate the Nginx config
app.post('/ssl/:domain', upload.fields([
  { name: 'certFile', maxCount: 1 },
  { name: 'keyFile', maxCount: 1 },
  { name: 'bundle', maxCount: 1 }
]), async (req, res) => {
  const { domain } = req.params;
  // Verify domain to avoid writing certificate files to unexpected locations
  if (!isValidDomain(domain)) return res.status(400).send('Invalid domain');
  let { cert, key } = req.body;

  try {
    // Uploaded individual certificate and key files take precedence over text areas
    if (req.files?.certFile) {
      cert = fs.readFileSync(req.files.certFile[0].path, 'utf8');
      fs.unlinkSync(req.files.certFile[0].path);
    }
    if (req.files?.keyFile) {
      key = fs.readFileSync(req.files.keyFile[0].path, 'utf8');
      fs.unlinkSync(req.files.keyFile[0].path);
    }
    // Handle a GoDaddy-style zip bundle containing the certificate and key
    if (req.files?.bundle) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-'));
      await extract(req.files.bundle[0].path, { dir: tmpDir });
      fs.unlinkSync(req.files.bundle[0].path);
      const files = fs.readdirSync(tmpDir);
      const certCandidate = files.find(f => f.endsWith('.crt') || f.endsWith('.pem'));
      const keyCandidate = files.find(f => f.endsWith('.key') || f.toLowerCase().includes('private'));
      if (certCandidate) cert = fs.readFileSync(path.join(tmpDir, certCandidate), 'utf8');
      if (keyCandidate) key = fs.readFileSync(path.join(tmpDir, keyCandidate), 'utf8');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Failed to process uploaded certificate:', err.message);
  }

  if (!cert || !key) return res.status(400).send('Certificate and key required');

  // Ensure the ssl storage directory exists before writing files
  if (!fs.existsSync(SSL_DIR)) fs.mkdirSync(SSL_DIR);
  fs.writeFileSync(path.join(SSL_DIR, `${domain}.crt`), cert);
  fs.writeFileSync(path.join(SSL_DIR, `${domain}.key`), key);

  // Regenerate nginx configuration with SSL directives and reload the site
  const sites = loadSites();
  const site = sites.find(s => s.domain === domain);
  if (site) {
    generateNginxConfig(site);
    // Enabling the site may fail if nginx cannot reload, so await the helper
    // and surface errors to the client rather than silently logging.
    try {
      await enableSite(site.domain);
    } catch (err) {
      return res.status(500).send(`Failed to enable site: ${err.message}`);
    }
  }

  // Automatically verify the installed certificate and log the result
  try {
    const result = await testSsl(domain);
    if (result.ok) {
      console.log(`SSL test passed for ${domain}`);
    } else {
      console.error(`SSL test failed for ${domain}: ${result.output}`);
    }
  } catch (err) {
    console.error(`SSL test failed for ${domain}:`, err);
  }

  res.redirect('/');
});

// Manual endpoint to trigger the SSL test from the browser
app.get('/ssl/:domain/test', async (req, res) => {
  const { domain } = req.params;
  // Reject invalid domains before running the SSL test command
  if (!isValidDomain(domain)) {
    return res.status(400).json({ ok: false, error: 'Invalid domain' });
  }
  try {
    const result = await testSsl(domain);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.toString() });
  }
});

// Serve the generated nginx config for a specific site
app.get('/config/:domain', (req, res) => {
  const { domain } = req.params;
  // Ensure the domain is well-formed before reading configuration files
  if (!isValidDomain(domain)) return res.status(400).send('Invalid domain');
  const configPath = path.join(__dirname, 'generated_configs', domain);
  // If the config file doesn't exist, inform the user
  if (!fs.existsSync(configPath)) {
    return res.status(404).send('Config not found');
  }
  // Display the config as plain text in the browser
  res.type('text/plain').send(fs.readFileSync(configPath));
});

// Generate an Nginx server block for a site
function generateNginxConfig(site) {
  // Determine if SSL files exist for this domain so we can include them
  const certPath = path.join(SSL_DIR, `${site.domain}.crt`);
  const keyPath = path.join(SSL_DIR, `${site.domain}.key`);
  const hasSsl = fs.existsSync(certPath) && fs.existsSync(keyPath);

  let config;
  if (site.port) {
    // Proxy dynamic applications running on a port
    if (hasSsl) {
      // Include SSL directives when certificate and key are present
      config = `server {\n  listen 80;\n  listen 443 ssl;\n  server_name ${site.domain};\n  ssl_certificate ${certPath};\n  ssl_certificate_key ${keyPath};\n  location / {\n    proxy_pass http://127.0.0.1:${site.port};\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n  }\n}`;
    } else {
      config = `server {\n  listen 80;\n  server_name ${site.domain};\n  location / {\n    proxy_pass http://127.0.0.1:${site.port};\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n  }\n}`;
    }
  } else {
    // Configuration for static files
    if (hasSsl) {
      config = `server {\n  listen 80;\n  listen 443 ssl;\n  server_name ${site.domain};\n  ssl_certificate ${certPath};\n  ssl_certificate_key ${keyPath};\n  root ${site.root};\n  index index.html index.htm;\n  location / {\n    try_files $uri $uri/ =404;\n  }\n}`;
    } else {
      config = `server {\n  listen 80;\n  server_name ${site.domain};\n  root ${site.root};\n  index index.html index.htm;\n  location / {\n    try_files $uri $uri/ =404;\n  }\n}`;
    }
  }
  const outputDir = path.join(__dirname, 'generated_configs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, site.domain), config);
  // Let the operator know the config file was created
  console.log(`Nginx config generated for ${site.domain} (port ${site.port || 'static'})`);
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
