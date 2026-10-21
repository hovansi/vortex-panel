# Trusted HTTPS and automatic renewal

Vortex supports a public Let’s Encrypt certificate for the managed panel’s IPv4 address. No domain is required. IP certificates use the `shortlived` profile and last six days. A dedicated systemd timer checks renewal every six hours with a short randomized delay. NGINX reloads certificates without restarting managed servers.

Fresh and maintenance installer runs attempt this automatically after the panel and its IP reverse proxy are healthy. Use `--self-signed` to retain self-signed access, or `--local-only` on a fresh installation for a local-only panel. A source-only update preserves access; use **Settings → Panel administration → Trusted HTTPS** to enable the feature afterward. The request shows the public IP, certificate authority terms and current Admin password confirmation.

The VPS must accept inbound **TCP 80 and the configured HTTPS port (19191 by default)**. HTTP challenge files are served from a dedicated path; other HTTP traffic redirects to HTTPS. Check provider firewall/NAT rules as well as UFW. Validation and CA rate limits can prevent issuance. Vortex reports the failure and preserves the previously serving configuration instead of reporting a trusted certificate prematurely. Custom reverse proxies and certificates are preserved rather than rewritten.

Fresh installations open at **`https://IP:19191`**. TCP 80 remains available for HTTP certificate challenges and redirects other requests to that HTTPS endpoint. Existing installations keep their endpoint during ordinary updates; see [the explicit port migration command](INSTALL.md#installation-options) to move a verified Vortex-owned IP proxy. Certificate renewal verifies the certificate on the configured public port.

## Ownership and renewal

Certbot 5.8.0 runs in a separate Vortex-owned Python environment. It uses private ACME configuration and account directories, isolated from any administrator-managed Certbot installation. No contact email is submitted by the automatic installer. The IP and issued certificate are public certificate-authority data. Read the [subscriber agreement and privacy information](https://letsencrypt.org/repository/) before enabling issuance.

Candidate certificates must pass public CA chain, IP identity, expiry and private-key matching checks. Vortex stages immutable certificate generations before switching the active pair. It then verifies the fingerprint actually served by NGINX. A failed activation restores the known previous generation. Interrupted requests can be verified from HTTPS settings; verification does not issue another certificate.

Inspect the actual timer and logs:

```bash
sudo systemctl status vortex-panel-tls-renew.timer
sudo systemctl list-timers vortex-panel-tls-renew.timer
sudo journalctl -u vortex-panel-tls-renew.service -n 60 --no-pager
```

Certificate expiry, automatic renewal state and recent request progress appear in settings. Keep inbound TCP 80 available for renewal. A successful check when a certificate is not due is not evidence of a completed new issuance. Do not force repeated renewals to test progress; CA rate limits apply.

Uninstall disables the owned renewal timer before removing its verified private artifacts. Changed or externally managed configurations require review and are preserved. Worker agent certificates continue using their existing pinned TLS identity; this feature manages browser access to the main panel.

Implementation references: [Let’s Encrypt IP certificates with Certbot](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html), [Certbot renewal documentation](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates).


ACME logs use the root-private `/var/lib/vortex-panel-acme-logs` directory. Ubuntu can make `/var/log` writable by the syslog group; Vortex preserves that OS configuration and keeps its strict ownership checks. Version 0.22.1 corrects automatic certificate setup on those hosts. Verified legacy Vortex log directories from 0.22.0 remain covered by owned uninstall cleanup. Before contacting the certificate authority, a bounded local check waits for NGINX to serve the exact random challenge token after reload. Only the public probe token is made readable by NGINX, including under a restrictive service umask; private keys and account files retain their permissions.
