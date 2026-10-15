import { createCanvasSummaryHandler } from './canvas-summary.js';

// Separate from the first-content summary: pricing must not delay the portal.
// Reuses self-only identity, tenant, RBAC, no-store and no-selector guards.
export default createCanvasSummaryHandler({ renewalPriceOnly: true });
