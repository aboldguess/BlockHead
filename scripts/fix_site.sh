#!/bin/bash
# Attempt to repair a BlockHead site by re-enabling its nginx configuration.
# Usage: sudo ./scripts/fix_site.sh <domain>
# This script copies the generated config for the given domain into
# /etc/nginx/sites-available, ensures a symlink exists in sites-enabled,
# and reloads nginx. It assumes BlockHead has already generated the config
# under generated_configs/<domain>.

set -e

DOMAIN="$1"
if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo ./scripts/fix_site.sh <domain>" >&2
  exit 1
fi

ROOT_DIR="$(dirname "$0")/.."
CONFIG="$ROOT_DIR/generated_configs/$DOMAIN"
TARGET="/etc/nginx/sites-available/$DOMAIN"

if [ ! -f "$CONFIG" ]; then
  echo "Generated config $CONFIG not found. Use the web UI to recreate it." >&2
  exit 1
fi

# Copy the config file into nginx and enable it
sudo mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
sudo cp "$CONFIG" "$TARGET"
sudo ln -sf "$TARGET" "/etc/nginx/sites-enabled/$DOMAIN"

# Reload nginx so changes take effect
sudo systemctl reload nginx

echo "Site $DOMAIN repaired and nginx reloaded."
