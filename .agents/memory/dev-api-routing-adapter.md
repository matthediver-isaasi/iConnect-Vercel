---
name: Local dev API routing adapter
description: How /api requests are served in dev (not Vercel), and the file-style [param].js routing it does.
---

Local dev does NOT use Vercel to serve `/api/*`. `server/vercel-api-adapter.ts` (wired via `server/index-dev.ts`) filesystem-routes requests into `api/**`, mapping both `[param]/` directories and `[param].js` files into `req.query[param]`. Production uses Vercel's native router instead.

**Why this matters:** a route can work in production but be broken only in the dev workspace (or vice-versa) because two different routers are in play. When a tokenised/dynamic public page returns "X required" in dev despite the param being in the URL, suspect the dev adapter's param extraction, not your handler.

**How to apply:** when adding a new dynamic API route, you can verify the dev path with `curl -H "Host: <tenant>.localhost" http://localhost:5000/api/...`. New `api/**` files require a full workflow restart (tsx watch does not always pick them up; the adapter also caches handlers per-process). Match the existing convention: tokenised public endpoints live as `api/public/<feature>/[token].js` and read `req.query.token`.
