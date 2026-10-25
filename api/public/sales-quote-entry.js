// Explicit deployment entry point: plain Vercel functions do not reliably
// expand a [...path].js filename across multiple URL segments. The rewrite
// forwards token/action to the existing handler without changing its guards.
export { default } from './sales-quote/[...path].js';
