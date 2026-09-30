# iConnect Check-In (mobile)

A standalone **Expo / React Native** app (iOS + Android) for event door check-in.
Staff sign in with their iConnect credentials, pick an organisation and event,
scan attendee QR codes, view attendee details (ticket, dietary, allergies, flags),
mark/undo attendance, and watch a live "X of Y arrived" counter.

This is a **separate subproject**. It is intentionally isolated from the Vercel web
build — it has its own `package.json` and is not referenced by the web app. It talks
to the existing iConnect REST API over HTTPS using bearer-token auth.

> Online-only. There is no offline queue in v1 — the device needs network access at
> the door.

## Prerequisites

- **Node.js 18+** and **npm**.
- **Expo CLI** (run via `npx expo`, no global install needed).
- The **Expo Go** app on your phone for quick testing (development), OR a custom dev
  build / store build for production (see "Builds").
- For store builds: an **Expo (EAS) account** (`npx eas login`).
- **App store accounts** (only needed to publish):
  - Apple Developer Program — ~$99/year.
  - Google Play Developer — one-time $25.

## Setup

```bash
cd mobile
npm install
cp .env.example .env   # then edit if you need a non-production API
```

### Environment

| Var | Default | Purpose |
| --- | ------- | ------- |
| `EXPO_PUBLIC_API_BASE_URL` | `https://iconn.app` | Base URL of the iConnect API. Point at `https://dev.iconn.app` for the preview backend. |

`EXPO_PUBLIC_*` vars are inlined into the JS bundle at build time, so rebuild after
changing them. No secrets live in the app — the only credential is the bearer token,
which is obtained at login and stored in the OS secure keystore (`expo-secure-store`).

## Run (development)

```bash
npm run start      # Expo dev server + QR code
npm run ios        # open iOS simulator (macOS only)
npm run android    # open Android emulator
```

Scan the dev-server QR with Expo Go (or the dev build) to load the app. The QR-code
scanning feature requires a **real device** — simulators have no camera.

## How it works

1. **Login** (`POST /api/auth/mobile-login`) returns either a bearer token or, for
   multi-org accounts, a list of organisations to choose from. Selecting one re-calls
   login with `tenantId`.
2. The token is sent as `Authorization: Bearer <token>` on every request and is
   persisted in the secure keystore so the session survives app restarts.
3. **Events** come from `GET /api/admin/event-checkin?action=events`. Simple events go
   straight to the scanner; complex (multi-session) events first show a session picker.
4. **Scanner** uses `expo-camera` to read a QR code, extracts the `token` query param,
   resolves it (`GET ...?token=`), shows attendee details, and posts `mark` / `undo`.
5. The **counter** polls `GET ...?eventId=&eventType=&sessionId=` every 10s and refetches
   immediately after each mark/undo.
6. Any `401` response clears the stored session and returns the user to the login screen.

To switch organisations after login, sign out and sign back in (v1 behaviour).

## Builds (EAS)

Set your EAS project id in `app.json` (`expo.extra.eas.projectId`) first, then:

```bash
npx eas login
npx eas build:configure          # one-time, if needed
npm run build:ios                # eas build --platform ios --profile production
npm run build:android            # eas build --platform android --profile production
```

Profiles live in `eas.json`. The `preview` profile produces an internally
distributable build; `production` produces store-ready binaries.

### Submitting to the stores

```bash
npx eas submit --platform ios
npx eas submit --platform android
```

You will need the store accounts listed under Prerequisites and the usual store
metadata (screenshots, privacy policy, etc.).

## Assets

`assets/icon.png`, `assets/adaptive-icon.png`, and `assets/splash.png` are solid-colour
**placeholders**. Replace them with real branded artwork before submitting to the stores
(1024×1024 for the icon).

## Project layout

```
mobile/
  App.tsx                  # providers + root navigator
  app.json                 # Expo config (perms, bundle ids, icons)
  eas.json                 # EAS build profiles
  src/
    config.ts              # API base URL + poll interval
    theme.ts               # dark palette + spacing/radius tokens
    types.ts               # API response types
    config/                # (n/a)
    lib/
      api.ts               # fetch client, ApiError, extractToken, endpoints
      storage.ts           # secure-store session persistence
    context/AuthContext.tsx
    navigation/            # RootNavigator + param types
    components/            # Button, Screen, AttendeeDetails
    screens/               # Login, OrgSelect, EventList, SessionSelect, Scanner
```

## Notes / constraints

- Does **not** modify the shared auth layer or the existing web check-in pages.
- Native `fetch` is not subject to CORS, so no backend changes were required.
- Type-check with `npm run typecheck`.
