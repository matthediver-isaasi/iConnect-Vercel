---
name: Vercel build breaks on package-firewall.replit.local lockfile URLs
description: Why Vercel npm install crashes with "Exit handler never called!" and the one-line fix.
---

# Replit package-firewall URLs leak into package-lock.json and break Vercel builds

When a package is installed in this workspace (via the Replit packager), its
`package-lock.json` entry's `"resolved"` URL is written as
`http://package-firewall.replit.local/npm/<path>` (Replit's internal package
mirror), NOT `https://registry.npmjs.org/<path>`.

Vercel cannot resolve the host `package-firewall.replit.local`, so `npm install`
on Vercel hangs and then crashes with:

```
npm error Exit handler never called!
npm error This is an error with npm itself.
Command "npm install" exited with 1
```

That npm-internal error message is misleading — the real cause is the
unreachable mirror host in the lockfile.

**Fix (safe, mechanical):** rewrite the host prefix in `package-lock.json`:

```bash
sed -i 's#http://package-firewall\.replit\.local/npm/#https://registry.npmjs.org/#g' package-lock.json
```

The path after `/npm/` is identical to npmjs's path, and `integrity` hashes are
content hashes (registry-independent), so only the `"resolved"` lines change and
npm still verifies integrity after downloading from npmjs. Verify with
`grep -c package-firewall.replit.local package-lock.json` (expect 0) and
`node -e "JSON.parse(require('fs').readFileSync('package-lock.json','utf8'))"`.

**Why:** this recurs whenever a task agent adds a dependency (the AWS SDK /
Cloudflare R2 backup work is one culprit). It had already been fixed twice before
in git history ("replace internal Replit package mirror URL in package-lock.json"
and "Fix build error caused by incorrect package registry URL").

**How to apply:** after any merge that touched `package-lock.json`, before
trusting a Vercel deploy, scan for non-`registry.npmjs.org` `resolved` hosts and
rewrite them. Do NOT run `npm install` here to "fix" it — that re-resolves
through the firewall and re-injects the internal URLs. Edit the lockfile directly
(editing package-lock.json is allowed; editing package.json is not).
