---
name: Mobile Expo check-in subproject
description: Conventions/gotchas for the standalone Expo app under mobile/
---

The event check-in mobile app lives in `mobile/` as a **fully isolated Expo
subproject** with its own `package.json`. It is deliberately NOT part of the
Vercel web build and must not be imported by the web app. It talks to the
existing iConnect REST API over HTTPS with bearer-token auth (see
bearer-token-auth.md). Native `fetch` is not subject to CORS, so reusing the
web check-in endpoint (`/api/admin/event-checkin`) required zero backend changes.

**Gotcha — TS path aliases don't resolve at runtime.** `@/*` in `tsconfig.json`
only satisfies the type-checker. Metro (the RN bundler) ignores tsconfig paths,
so the same alias MUST also be declared in `babel.config.js` via
`babel-plugin-module-resolver` (alias `{'@':'./src'}`) or every `@/...` import
throws "unable to resolve module" at bundle time.
**Why:** two independent resolvers — tsc for types, Metro/Babel for the bundle.
**How to apply:** when adding aliases, update BOTH tsconfig paths and the babel
module-resolver alias in lockstep.

**Cannot run/build Expo from this Replit workspace** — bash blocks `npm install`
(must use the packager tool, which targets the root project, not a subdir) and
there is no iOS/Android toolchain here. The deliverable is build-ready source +
README; validation (typecheck, builds) happens via EAS / a dev machine.

**Complex (multi-session) events** use per-session check-in tokens; a scanned
token resolves its session automatically. The live counter still needs the
`sessionId` passed explicitly to scope "X of Y arrived" to that session.

Org switching post-login in v1 = sign out and back in (the cookie-based
tenant-switch flow is not used by mobile).

**Upgrading the Expo SDK from this workspace** — `npx expo install --fix` can't
run here (no install path for the subdir). Get the exact aligned dependency
versions from `expo@<sdk>/bundledNativeModules.json` (e.g. via
`unpkg.com/expo@54.0.35/bundledNativeModules.json`) and hand-write them into
`mobile/package.json`; that file is the authoritative source of what each SDK
pins (react, react-native, all expo-* and RN community packages). `npm install`
and `tsc` typecheck must be verified by the user on a dev machine / EAS.
