/**
 * Runtime configuration. The API base URL is read from the EXPO_PUBLIC_API_BASE_URL
 * environment variable (inlined at build time by Expo) and falls back to the default
 * below.
 *
 * NOTE: this default points at the preview backend (dev.iconn.app) because the
 * mobile endpoints are not yet deployed to the production site (iconn.app) — the
 * production site returns 404 for /api/auth/mobile-login. Once the backend is
 * published to production, change this back to 'https://iconn.app' (or set
 * EXPO_PUBLIC_API_BASE_URL in a .env file to override without editing code).
 */
const raw = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://dev.iconn.app';

export const API_BASE_URL = raw.replace(/\/+$/, '');

/** How often (ms) the live attendance counter re-polls the dashboard. */
export const COUNTER_POLL_INTERVAL_MS = 10_000;
