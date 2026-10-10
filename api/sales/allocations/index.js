// Vercel catch-all routes require a path segment and do not serve the collection.
export { default, createSalesAllocationsHandler } from './[...path].js';
