# BlockHead

BlockHead is a simple web interface for managing multiple websites on a single server using Nginx server blocks. It lets you clone projects from GitHub, pull updates, and generate basic Nginx configuration files.

## Features

- List websites hosted on the server
- Add a new site by cloning from a Git repository
- Pull the latest changes for a site (assumes `main` branch)
- Generate an Nginx server block configuration for each site
- Delete site configuration
- Download a zip backup of any site

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
   - The app clones the repository and creates a config snippet in `generated_configs/`.

4. **Nginx setup**
   - Copy the generated config file for each domain to `/etc/nginx/sites-available/`.
   - Create a symlink in `/etc/nginx/sites-enabled/`:
     ```bash
     sudo ln -s /etc/nginx/sites-available/example.com /etc/nginx/sites-enabled/
     ```
   - Reload Nginx:
     ```bash
     sudo systemctl reload nginx
     ```

5. **Configure your domain in GoDaddy**
   - Log into GoDaddy and edit the DNS records for your domain.
   - Create an `A` record that points to your home server's static IP (`193.237.136.211`).
   - Allow time for DNS propagation.

6. **Updating sites**
   - On the main page, click `Pull Latest` next to a domain to run `git pull origin main` in the site's directory.

7. **Backing up sites**
   - Click `Backup` next to a domain to download a zip archive of the site's files and generated config.

## Warning

This project is intended for home lab or educational use. Running arbitrary Git repositories on a public server can be dangerous. Always review code before deploying.

## License

MIT
