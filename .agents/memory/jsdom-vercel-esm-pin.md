---
name: jsdom pinned to v26 for Vercel
description: Why jsdom must stay at ^26 — v27+ crashes Vercel functions with ERR_REQUIRE_ESM.
---

# jsdom must stay at ^26 while deploying to Vercel

**Rule:** Keep `jsdom` at `^26.x`. Do not upgrade to 27+ until Vercel's function runtime supports `require()` of ES modules.

**Why:** jsdom 29 pulls `html-encoding-sniffer@6`, which does `require('@exodus/bytes/encoding-lite.js')` — an ESM-only file. Vercel's custom module loader (`/opt/rust/nodejs.js`) throws `ERR_REQUIRE_ESM` at cold start, crashing every function that imports jsdom (the AI code sanitiser stack). Works fine locally on newer Node, so it only breaks in production.

**How to apply:** If a dependency bump or fresh install raises jsdom past 26, downgrade back (`jsdom@^26.1.0` → html-encoding-sniffer 4 + whatwg-encoding 3, all CommonJS). Test suites pass unchanged on 26. Re-test on Vercel before ever unpinning.

Also: after any install here, check `package-lock.json` for `package-firewall.replit.local` resolved URLs — they appear as `http://package-firewall.replit.local/npm/...` and must be sed'd to `https://registry.npmjs.org/...` or Vercel's npm install crashes.
