#!/bin/bash
# Basic installation script for a new BlockHead server.
# Installs Node.js, Nginx, and project dependencies.
# Run as root or with sudo privileges on the target machine.

set -e

# Update package index
sudo apt-get update

# Install system packages
sudo apt-get install -y nodejs npm nginx git

# Install Node.js dependencies for BlockHead
npm install

# Create directories if they don't exist
mkdir -p backups generated_configs

echo "Installation complete. Start the server with 'node server.js'"
