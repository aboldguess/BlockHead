# BlockHead

BlockHead is a simple web interface for managing multiple websites on a single server using Nginx server blocks. It lets you clone projects from GitHub, pull updates, and generate basic Nginx configuration files.
For a detailed walkthrough see the in-app help page at `/help` once the server is running.

## Features

- List websites hosted on the server
- Add a new site by cloning from a Git repository
- Pull the latest changes for a site (assumes `main` branch)
- Generate an Nginx server block configuration for each site
- Delete site configuration
- Download a zip backup of any site
- View the generated Nginx config for each site directly from the web UI
- Upload SSL certificates via paste, individual files, or GoDaddy-provided zip bundles with automated testing
- Modern Bootstrap-based interface for easy management
- Diagnostic status checks displayed as traffic light indicators

## Getting Started

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Start the server**
   ```bash
   node server.js
   ```
   The app listens on port `3000` by default. Open `http://localhost:3000` (or the machine's IP) in your browser.

3. **Add your first site**
   - Click `Add New Site`
   - Provide the domain (e.g., `example.com`), the Git repo URL, and the directory where the site should live on disk.
   - If the app listens on a specific port (e.g., `3001`), enter it in the **Application Port** field.
   - Optionally provide a **Start Command** to run after cloning, such as `./scripts/rpi_bidfinder.sh -p 4000`.
   - The app clones the repository and creates a config snippet in `generated_configs/`.
   - If the project contains a `package.json`, BlockHead automatically runs `npm install` and then starts the app using `npm start`.

4. **Nginx setup**
   - BlockHead now tries to run the helper script automatically when you create a site.
   - If you still see the default "Welcome to nginx" page when clicking **View via IP**, run the command manually:
     ```bash
     sudo ./scripts/enable_site.sh example.com
     ```
     Replace `example.com` with your domain name.

5. **Configure your domain in GoDaddy**
   - Log into GoDaddy and edit the DNS records for your domain.
   - Create an `A` record that points to your home server's static IP (`193.237.136.211`).
   - Allow time for DNS propagation.

6. **Updating sites**
   - On the main page, click `Pull Latest` next to a domain to run `git pull origin main` in the site's directory.
   - If the site is a Node.js project, dependencies are reinstalled and the `npm start` script runs again automatically.

7. **Backing up sites**
   - Click `Backup` next to a domain to download a zip archive of the site's files and generated config.

8. **Viewing configs**
   - Click `View Config` next to a domain to see the nginx server block that was generated for that site.

9. **Verify LAN access**
   - From another device on your network open `http://<server-ip>:3000` to confirm the BlockHead UI loads.
   - Open `http://<server-ip>` to check that a site is served by nginx after running `enable_site.sh`.
   - If these work locally but fail from the internet, forward port **80** (and optionally **3000** for the UI) on your router to the server's LAN IP.

10. **Install and test SSL certificates**
    - Click **Configure SSL** for your domain.
    - Paste the certificate and key or upload the relevant `.pem/.crt/.key` files or GoDaddy `.zip` bundle.
    - After installing, use the **Test SSL** button or visit `/ssl/your-domain/test` to verify the certificate.

## Migrating to a new server

BlockHead ships with a small utility to assist when moving to a fresh machine.

1. On the **old** server export a full backup:

   ```bash
   node scripts/migrate.js export blockhead-backup.zip
   ```

   This archive contains `sites.json`, generated Nginx configs and the content
   of each site directory.

2. Copy the archive to the **new** server and run the installation script:

   ```bash
   ./scripts/install.sh
   ```

3. Import the backup on the new machine:

   ```bash
   node scripts/migrate.js import blockhead-backup.zip
   ```


The server can then be started with `node server.js` as usual. Verify that Nginx
config files are in place and reload Nginx if required.

## Troubleshooting

### "Cannot write to /var/www" error

If you see an error similar to `Cannot write to /var/www. Ensure the directory
exists and permissions are correct`, it usually means the directory does not
exist or your user cannot write to it. You can fix this by creating the folder
and giving yourself ownership:

```bash
sudo mkdir -p /var/www
sudo chown $(whoami):$(whoami) /var/www
```

Running the installation script (`./scripts/install.sh`) performs these steps
automatically. After adjusting permissions, retry adding the site through the
web interface.

### "Destination already exists and is not empty" error

This occurs when the clone directory already has files in it. You can delete the
existing folder manually, for example:

```bash
sudo rm -rf /var/www/example
```

Or simply tick the **Overwrite existing directory** box on the Add Site form to
let BlockHead remove the folder automatically.

### Site shows as down

The main page now includes a traffic light indicator for each domain. If a site
appears in red or yellow, click the **Fix** button or run the helper script

```bash
sudo ./scripts/fix_site.sh your-domain
```

This copies the generated config into `/etc/nginx`, enables the site and
reloads nginx.

### SSL certificate issues

BlockHead automatically runs a basic `openssl` check after you upload a certificate.
If HTTPS still fails:

1. Verify the certificate and key pair:
   ```bash
   openssl x509 -in ssl/example.com.crt -noout
   openssl rsa -in ssl/example.com.key -check
   ```
2. Ensure nginx can load the files:
   ```bash
   sudo nginx -t && sudo nginx -s reload
   ```
3. Test the public endpoint from the server:
   ```bash
   openssl s_client -connect example.com:443 -servername example.com
   ```
   A successful handshake ends with `Verify return code: 0 (ok)`.

If problems persist, confirm that DNS points to your server and that port 443 is accessible.

## Warning

This project is intended for home lab or educational use. Running arbitrary Git repositories on a public server can be dangerous. Always review code before deploying.

## License

MIT
