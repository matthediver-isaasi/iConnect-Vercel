/**
 * DEPRECATED - This file is no longer used.
 * 
 * All API routes have been migrated to Vercel serverless functions in /api/
 * 
 * The server now uses server/vercel-api-adapter.ts to route all /api/* 
 * requests directly to the Vercel function handlers in development.
 * 
 * In production, Vercel handles routing natively.
 * 
 * Migration Date: January 2026
 * 
 * See also:
 * - server/vercel-api-adapter.ts - Routes requests to Vercel handlers
 * - api/_lib/database.js - Centralized database configuration
 * - api/_lib/session.js - Session management
 */

import type { Express } from "express";
import { createServer, type Server } from "http";

export async function registerRoutes(_app: Express): Promise<Server> {
  console.warn('[DEPRECATED] server/routes.ts is no longer used. All API routes are now served via Vercel serverless functions.');
  return createServer(_app);
}
