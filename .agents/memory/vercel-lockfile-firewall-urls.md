---
name: Keep npm lockfile resolved URLs portable
description: Why approved Replit installs can leave internal package URLs that external deployment builders cannot resolve.
---

# Keep approved package installs portable across deployment builders

An approved package install in this workspace can write a `package-lock.json`
`"resolved"` URL under `http://package-firewall.replit.internal/npm/<path>`
(older locks used the `.local` hostname). That internal mirror is valid during
the controlled install but is not a portable artifact source.

External builders such as Vercel cannot resolve the internal hostname, so their
clean lockfile install can fail with `ENOTFOUND` or a misleading npm exit error.

```
npm error Exit handler never called!
npm error This is an error with npm itself.
Command "npm install" exited with 1
```

That npm-internal error message is misleading — the real cause is the
unreachable mirror host in the lockfile.

**Fix (safe, mechanical):** replace only the exact internal npm prefix with
`https://registry.npmjs.org/`. Preserve the remaining tarball path, package
versions, integrity hashes, and any genuine external package sources byte for
byte. Integrity hashes are content hashes, so npm still verifies the downloaded
artifact independently of its registry hostname.

**Why:** this recurs whenever a task agent adds a dependency (the AWS SDK /
Cloudflare R2 backup work is one culprit). It had already been fixed twice before
in git history ("replace internal Replit package mirror URL in package-lock.json"
and "Fix build error caused by incorrect package registry URL").

**How to apply:** after an approved install or merge that touched the lockfile,
run `node --test scripts/package-lock-portability.test.mjs` before trusting an
external deployment. Do not run `npm install` merely to rewrite URLs, alter npm
registry configuration, bypass the firewall, or blanket-rewrite genuine
external sources; directly normalize only the known internal prefix.
