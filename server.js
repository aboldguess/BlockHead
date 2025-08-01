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
const http = require('http');
// exec runs one-off shell commands while spawn is used below for
// background processes such as starting an app server
const { exec, spawn } = require('child_process');
const os = require('os');

const app = express();
const PORT = 3000; // Change to 80 if running as root for HTTP
const DATA_FILE = path.join(__dirname, 'sites.json');

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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint used by the front-end advanced panel
// to retrieve recent log messages as JSON.
app.get('/logs', (req, res) => {
  res.json(logs);
});

// Utility function to load site data from JSON file
function loadSites() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

// Utility function to save site data to JSON file
function saveSites(sites) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(sites, null, 2));
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
  child.unref();
}

// Enable a site at the Nginx level by running the helper script. This copies
// the generated config into /etc/nginx and reloads the server. We run it in the
// background and simply log any output. If the command fails (for example
// because sudo requires a password) the user can run the script manually.
function enableSite(domain) {
  exec(`bash scripts/enable_site.sh ${domain}`,(err, stdout, stderr) => {
    if (err) {
      console.error(`Auto-enable failed for ${domain}:`, stderr.trim());
    } else if (stdout) {
      console.log(stdout.trim());
    }
  });
}

// Spawn a custom command for a site. The command string is split by spaces to
// form the executable and its arguments. The resulting child process is stored
// so it can be terminated later.
function runSiteCommand(domain, cmd, cwd) {
  const [exe, ...args] = cmd.split(' ');
  const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore' });
  child.unref();
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
  const { domain, repo, root, port } = req.body;
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
    // If the target clone directory already exists, ensure it's empty.
    // Git will refuse to clone into a non-empty folder, so we warn early.
    if (fs.existsSync(root)) {
      const files = await fs.promises.readdir(root);
      if (files.length > 0) {
        return res
          .status(400)
          .send(
            `Destination ${root} already exists and is not empty. ` +
              `Remove it or choose a different path.`
          );
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
        console.log(`Starting application for ${domain} on port ${port}`);
        startApp(root, port);
      } catch (installErr) {
        console.error('Automatic start failed:', installErr);
      }
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
  sites.push(site);
  saveSites(sites);
  generateNginxConfig(site);
  // Try to automatically enable the site so nginx starts serving it
  enableSite(site.domain);
  res.redirect('/');
});

// Pull latest changes for a site
app.post('/update', async (req, res) => {
  const { domain } = req.body;
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
  const sites = loadSites();
  const site = sites.find(s => s.domain === domain);
  if (!site) return res.redirect('/');
  runSiteCommand(domain, cmd, site.root);
  res.redirect('/');
});

// Stop a running command started via the Run button.
app.post('/stop', (req, res) => {
  const { domain } = req.body;
  if (domain) stopSiteCommand(domain);
  res.redirect('/');
});

// Serve the generated nginx config for a specific site
app.get('/config/:domain', (req, res) => {
  const { domain } = req.params;
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
  let config;
  if (site.port) {
    // Proxy dynamic applications running on a port
    config = `server {\n  listen 80;\n  server_name ${site.domain};\n  location / {\n    proxy_pass http://127.0.0.1:${site.port};\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n  }\n}`;
  } else {
    // Simple static site configuration
    config = `server {\n  listen 80;\n  server_name ${site.domain};\n  root ${site.root};\n  index index.html index.htm;\n  location / {\n    try_files $uri $uri/ =404;\n  }\n}`;
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
