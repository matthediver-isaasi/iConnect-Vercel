import report from './event-registration-report.js';

// Mode is server-owned; query parameters cannot enable a broader report.
export default function handler(req, res) {
  return report(req, res, true);
}
