#!/bin/bash
# Completely remove Nginx, BlockHead configs, and hosted sites.
# Use with caution: this is a destructive operation intended
# to reset the server to a pristine state.

set -e

# Stop Nginx if it is running to release any locks on configuration files.
echo "Stopping nginx..."
sudo systemctl stop nginx 2>/dev/null || true

# Purge nginx packages so they are removed from the system.
echo "Purging nginx packages..."
sudo apt-get purge -y nginx nginx-common nginx-core 2>/dev/null || true
sudo apt-get autoremove -y 2>/dev/null || true

# Remove nginx configuration directories.
echo "Removing nginx configuration directories..."
sudo rm -rf /etc/nginx

# Remove all site files under /var/www which are typically
# created by BlockHead when cloning repositories.
echo "Removing site directories..."
sudo rm -rf /var/www/*

# Delete BlockHead generated files and configuration state.
echo "Cleaning BlockHead data..."
rm -rf generated_configs backups sites.json

echo "Nuclear cleanup complete. You may run ./scripts/install.sh to reinstall."
