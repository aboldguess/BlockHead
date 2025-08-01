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
const { exec } = require('child_process');
const os = require('os');

const app = express();
const PORT = 3000; // Change to 80 if running as root for HTTP
const DATA_FILE = path.join(__dirname, 'sites.json');

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

// Utility function to load site data from JSON file
function loadSites() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

// Utility function to save site data to JSON file
function saveSites(sites) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(sites, null, 2));
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

// Show form to create new site
app.get('/new', (req, res) => {
  res.render('new');
});

// Handle creation of new site
app.post('/new', async (req, res) => {
  const { domain, repo, root } = req.body;
  // Log the creation request for debugging purposes
  console.log(`Creating new site ${domain} from ${repo} into ${root}`);

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
    // Attempt to clone the repository to the requested path
    await simpleGit().clone(repo, root);
    // Indicate that cloning completed without errors
    console.log(`Repository cloned successfully for ${domain}`);
  } catch (err) {
    console.error('Clone error:', err);
    // Provide a helpful message along with the git error text
    let message = 'Error cloning repository. ';
    if (err.message) {
      message += err.message;
    }
    message +=
      ' Verify the repository URL and that this process has permission to write to the destination.';
    return res.status(500).send(message);
  }

  const site = { domain, repo, root };
  sites.push(site);
  saveSites(sites);
  generateNginxConfig(site);
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
  const config = `server {\n  listen 80;\n  server_name ${site.domain};\n  root ${site.root};\n  index index.html index.htm;\n  location / {\n    try_files $uri $uri/ =404;\n  }\n}`;
  const outputDir = path.join(__dirname, 'generated_configs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, site.domain), config);
  // Let the operator know the config file was created
  console.log(`Nginx config generated for ${site.domain}`);
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
