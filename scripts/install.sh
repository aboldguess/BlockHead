#!/bin/bash
# Basic installation script for a new BlockHead server.
# Installs Node.js, Nginx, and project dependencies.
# Run as root or with sudo privileges on the target machine.

set -e

# Determine the directory of this script so npm install runs from the project root
# even when the script is executed from another location.
DIR="$(cd "$(dirname "$0")" && pwd)"

# Update package index
sudo apt-get update

# Install system packages. NodeSource's nodejs package already bundles npm,
# so there's no need to install the separate npm package.
sudo apt-get install -y nodejs nginx git

# Install Node.js dependencies for BlockHead from the project root. Using the
# script's path ensures the correct location regardless of the current working
# directory when this script is invoked.
(cd "$DIR/.." && npm install)

# Create directories if they don't exist
mkdir -p backups generated_configs

# Ensure a writable web root exists. Many users deploy sites under
# /var/www but this folder may not be present or owned by the current
# user on a fresh install. Create it and set ownership so that the
# BlockHead server can clone repositories there without permission
# errors.
sudo mkdir -p /var/www
# Use the user who invoked sudo (if any) to own /var/www, falling back to the
# current user when not running under sudo. This allows non-root users to write
# to the directory.
sudo chown "${SUDO_USER:-$USER}":"${SUDO_USER:-$USER}" /var/www

echo "Installation complete. Start the server with 'node server.js'"
