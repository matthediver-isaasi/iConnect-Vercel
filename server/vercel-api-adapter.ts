/**
 * Vercel API Adapter for Express Development Server
 * 
 * This adapter routes API requests to the Vercel serverless functions in /api/
 * 
 * The Vercel API handlers follow the signature: export default async function handler(req, res)
 * which is compatible with Express request/response objects with minor adaptations.
 */

import type { Express, Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(__dirname, "..", "api");

// Cache for loaded API handlers
const handlerCache = new Map<string, any>();

/**
 * Parse a route path like /api/entities/Member/123 and find matching handler
 * Returns { handler, params } where params contains dynamic segments
 */
async function findHandler(urlPath: string): Promise<{ handler: any; params: Record<string, string> } | null> {
  // Remove /api prefix and trailing slashes
  let relativePath = urlPath.replace(/^\/api/, "").replace(/\/$/, "") || "/";
  
  // Split into segments
  const segments = relativePath.split("/").filter(Boolean);
  
  // Try to find matching handler file
  // Priority: exact match > [param] dynamic match
  
  const possiblePaths: { filePath: string; params: Record<string, string> }[] = [];
  
  function searchDir(currentDir: string, segmentIndex: number, params: Record<string, string>) {
    if (segmentIndex >= segments.length) {
      // Check for index.js at this level
      const indexPath = path.join(currentDir, "index.js");
      if (fs.existsSync(indexPath)) {
        possiblePaths.push({ filePath: indexPath, params: { ...params } });
      }
      // Also check for direct file match (e.g., /api/health.js)
      return;
    }
    
    const segment = segments[segmentIndex];
    const isLastSegment = segmentIndex === segments.length - 1;
    
    // Check for exact directory match
    const exactDir = path.join(currentDir, segment);
    if (fs.existsSync(exactDir) && fs.statSync(exactDir).isDirectory()) {
      searchDir(exactDir, segmentIndex + 1, params);
    }
    
    // Check for exact file match (last segment only)
    if (isLastSegment) {
      const exactFile = path.join(currentDir, `${segment}.js`);
      if (fs.existsSync(exactFile)) {
        possiblePaths.push({ filePath: exactFile, params: { ...params } });
      }
    }
    
    // Check for dynamic segment match [param]
    try {
      const entries = fs.readdirSync(currentDir);
      for (const entry of entries) {
        if (entry.startsWith("[") && entry.endsWith("]")) {
          const paramName = entry.slice(1, -1);
          const dynamicPath = path.join(currentDir, entry);
          
          if (fs.statSync(dynamicPath).isDirectory()) {
            searchDir(dynamicPath, segmentIndex + 1, { ...params, [paramName]: segment });
          }
        }
        
        // Also check for dynamic file match [param].js
        if (isLastSegment && entry.startsWith("[") && entry.endsWith("].js")) {
          const paramName = entry.slice(1, -5);
          const filePath = path.join(currentDir, entry);
          possiblePaths.push({ filePath, params: { ...params, [paramName]: segment } });
        }
      }
    } catch (e) {
      // Directory doesn't exist or can't be read
    }
  }
  
  // Handle root /api/ request
  if (segments.length === 0) {
    const indexPath = path.join(API_DIR, "index.js");
    if (fs.existsSync(indexPath)) {
      possiblePaths.push({ filePath: indexPath, params: {} });
    }
  } else {
    searchDir(API_DIR, 0, {});
  }
  
  // Return the first valid handler found
  for (const { filePath, params } of possiblePaths) {
    try {
      let handler = handlerCache.get(filePath);
      if (!handler) {
        const module = await import(filePath);
        handler = module.default;
        handlerCache.set(filePath, handler);
      }
      
      if (typeof handler === "function") {
        return { handler, params };
      }
    } catch (e) {
      console.error(`[Vercel Adapter] Error loading handler ${filePath}:`, e);
    }
  }
  
  return null;
}

/**
 * Adapt Express req to Vercel-style req
 */
function adaptRequest(req: Request, params: Record<string, string>) {
  // Vercel uses req.query for both URL params and dynamic route segments
  // Explicitly preserve headers since object spread doesn't copy getters properly
  return {
    ...req,
    headers: req.headers,
    query: { ...req.query, ...params },
    // Ensure body is available
    body: req.body,
  };
}

/**
 * Register the Vercel API adapter as Express middleware
 */
export function registerVercelApiRoutes(app: Express) {
  // Handle all /api/* requests
  app.use("/api", async (req: Request, res: Response, next: NextFunction) => {
    const urlPath = "/api" + req.path;
    
    try {
      const result = await findHandler(urlPath);
      
      if (!result) {
        // No handler found, let Express continue to next middleware
        return next();
      }
      
      const { handler, params } = result;
      
      // Adapt the request to include route params in query
      const adaptedReq = adaptRequest(req, params);
      
      // Call the Vercel handler
      await handler(adaptedReq, res);
    } catch (error) {
      console.error(`[Vercel Adapter] Error handling ${urlPath}:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });
}
