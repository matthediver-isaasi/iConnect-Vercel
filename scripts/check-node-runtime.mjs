import { pathToFileURL } from 'node:url';

// November 2026 security baseline. Keep the major aligned with Vercel and
// Replit; newer patches on this line are allowed without changing the app.
export function assertSupportedNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) !== 24
    || Number(match[2]) < 22
    || (Number(match[2]) === 22 && Number(match[3]) < 3)) {
    throw new Error(`Node.js ${version} is unsupported. Use Node.js 24.22.3 or newer within 24.x.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertSupportedNode(process.version);
  console.info(`[Runtime] Node.js ${process.version}; security baseline 24.22.3 satisfied`);
}
