---
name: Portable npm downloads
description: Internal registry URLs can leak into dependency lockfiles and block external deployment.
---

After dependency changes, check lockfile download URLs for workspace-only hosts.

**Why:** Package installation here can record package-firewall.replit.internal tarball URLs. Vercel cannot resolve that hostname, so installation fails before compilation despite a working local installation.

**How to apply:** For public npm packages, retain versions and integrity hashes while using the corresponding public registry URLs. Verify downloaded bytes against the retained integrity hashes; do not regenerate or upgrade unrelated dependencies to resolve this issue.
