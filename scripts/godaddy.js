const https = require('https');

/**
 * Create or update the root A record for a domain via GoDaddy's API.
 * The function performs a simple HTTP PUT request using the provided
 * credentials. Only IPv4 addresses are supported for the A record.
 *
 * @param {string} domain - Domain name, e.g. "example.com".
 * @param {string} ip - IPv4 address to assign to the A record.
 * @param {string} key - GoDaddy API key.
 * @param {string} secret - GoDaddy API secret.
 * @returns {Promise<void>} Resolves on success or rejects with an error.
 */
function updateARecord(domain, ip, key, secret) {
  return new Promise((resolve, reject) => {
    // GoDaddy expects a JSON array of record objects even when updating a single record
    const payload = JSON.stringify([{ data: ip, ttl: 600 }]);

    const options = {
      hostname: 'api.godaddy.com',
      path: `/v1/domains/${domain}/records/A/@`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        // API authentication uses the "sso-key" scheme
        'Authorization': `sso-key ${key}:${secret}`
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        // GoDaddy returns 200-series codes for success
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return resolve();
        }
        // Include response body to aid debugging when something goes wrong
        reject(new Error(`GoDaddy API responded with ${res.statusCode}: ${data}`));
      });
    });

    req.on('error', err => reject(err));
    req.write(payload);
    req.end();
  });
}

module.exports = { updateARecord };
