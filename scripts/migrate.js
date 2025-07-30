#!/usr/bin/env node
/**
 * Migrate utility for BlockHead.
 *
 * Usage:
 *   node scripts/migrate.js export <archive.zip>
 *   node scripts/migrate.js import <archive.zip>
 *
 * The export command creates a zip containing sites.json, generated configs,
 * and all site directories. The import command extracts the archive to the
 * current project directory.
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const extract = require('extract-zip');

// Paths used throughout the script
const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'sites.json');
const GENERATED_DIR = path.join(ROOT, 'generated_configs');

/**
 * Create a full backup archive of BlockHead data.
 * @param {string} target Path to the zip file to create
 */
async function exportBackup(target) {
  const sites = fs.existsSync(DATA_FILE)
    ? JSON.parse(fs.readFileSync(DATA_FILE))
    : [];

  const output = fs.createWriteStream(target);
  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.pipe(output);

  // Include site metadata
  if (fs.existsSync(DATA_FILE)) {
    archive.file(DATA_FILE, { name: 'sites.json' });
  }

  // Include generated nginx configs
  if (fs.existsSync(GENERATED_DIR)) {
    archive.directory(GENERATED_DIR, 'generated_configs');
  }

  // Include contents of each site's root directory
  for (const site of sites) {
    if (fs.existsSync(site.root)) {
      const base = path.basename(site.root);
      archive.directory(site.root, path.join('sites', base));
    }
  }

  await archive.finalize();
  console.log(`Backup created at ${target}`);
}

/**
 * Restore BlockHead data from a backup archive.
 * @param {string} source Path to the zip file to extract
 */
async function importBackup(source) {
  await extract(source, { dir: ROOT });
  console.log('Backup imported. Review nginx configs and site directories.');
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (!mode || !file) {
    console.log('Usage: node scripts/migrate.js <export|import> <archive.zip>');
    process.exit(1);
  }

  if (mode === 'export') {
    await exportBackup(file);
  } else if (mode === 'import') {
    await importBackup(file);
  } else {
    console.error('Unknown mode:', mode);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
