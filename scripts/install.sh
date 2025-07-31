#!/bin/bash
# Basic installation script for a new BlockHead server.
# Installs Node.js, Nginx, and project dependencies.
# Run as root or with sudo privileges on the target machine.

set -e

# Update package index
sudo apt-get update

# Install system packages. NodeSource's nodejs already includes npm.
sudo apt-get install -y nodejs nginx git

# Install Node.js dependencies for BlockHead
npm install

# Create directories if they don't exist
mkdir -p backups generated_configs

# Ensure a writable web root exists. Many users deploy sites under
# /var/www but this folder may not be present or owned by the current
# user on a fresh install. Create it and set ownership so that the
# BlockHead server can clone repositories there without permission
# errors.
sudo mkdir -p /var/www
sudo chown "$USER":"$USER" /var/www

echo "Installation complete. Start the server with 'node server.js'"
