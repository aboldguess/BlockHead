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

const app = express();
const PORT = 3000; // Change to 80 if running as root for HTTP
const DATA_FILE = path.join(__dirname, 'sites.json');

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

// List all configured sites
app.get('/', (req, res) => {
  const sites = loadSites();
  res.render('index', { sites });
});

// Show form to create new site
app.get('/new', (req, res) => {
  res.render('new');
});

// Handle creation of new site
app.post('/new', async (req, res) => {
  const { domain, repo, root } = req.body;
  const sites = loadSites();
  const existing = sites.find(s => s.domain === domain);
  if (existing) {
    return res.send('Domain already exists');
  }

  // Clone the repository to the desired root directory
  try {
    await simpleGit().clone(repo, root);
  } catch (err) {
    console.error(err);
    return res.send('Error cloning repository');
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

  try {
    const git = simpleGit(site.root);
    await git.pull('origin', 'main');
  } catch (err) {
    console.error(err);
    return res.send('Failed to pull updates');
  }
  res.redirect('/');
});

// Create a zip backup of a site's root directory and config
app.post('/backup', (req, res) => {
  const { domain } = req.body;
  const sites = loadSites();
  const site = sites.find(s => s.domain === domain);
  if (!site) return res.sendStatus(404);

  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);

  // Archive name formatted as domain-timestamp.zip
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveName = `${domain}-${timestamp}.zip`;
  const archivePath = path.join(backupDir, archiveName);

  const output = fs.createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', () => {
    // Send the zip file for download once archiving is complete
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
  res.redirect('/');
});

// Generate an Nginx server block for a site
function generateNginxConfig(site) {
  const config = `server {\n  listen 80;\n  server_name ${site.domain};\n  root ${site.root};\n  index index.html index.htm;\n  location / {\n    try_files $uri $uri/ =404;\n  }\n}`;
  const outputDir = path.join(__dirname, 'generated_configs');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, site.domain), config);
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
