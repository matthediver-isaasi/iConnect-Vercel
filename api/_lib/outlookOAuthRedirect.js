const CALLBACK_PATH = '/api/auth/outlook/callback';
const PRODUCTION_REDIRECT_URI = `https://iconn.app${CALLBACK_PATH}`;

function isAllowedDevelopmentHost(host) {
  if (typeof host !== 'string' || !host || /[\/\\@\s]/.test(host)) return false;

  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }

  if (parsed.host !== host.toLowerCase()) return false;
  const hostname = parsed.hostname.toLowerCase();
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname.endsWith('.replit.dev')
    || hostname.endsWith('.repl.co');
}

/**
 * Build the one redirect URI used for both Microsoft authorization and token
 * exchange. Production deliberately retains its registered canonical URI.
 */
export function getOutlookOAuthRedirectUri({
  isProduction,
  host,
}) {
  if (isProduction) return PRODUCTION_REDIRECT_URI;
  if (!isAllowedDevelopmentHost(host)) {
    throw new Error('Invalid Outlook OAuth callback host');
  }

  const hostname = new URL(`http://${host}`).hostname.toLowerCase();
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  const protocol = isLocal ? 'http' : 'https';
  return `${protocol}://${host}${CALLBACK_PATH}`;
}

export function isValidOutlookOAuthRedirectUri(value, { isProduction }) {
  if (isProduction) return value === PRODUCTION_REDIRECT_URI;
  if (typeof value !== 'string') return false;

  try {
    const parsed = new URL(value);
    if (parsed.pathname !== CALLBACK_PATH || parsed.search || parsed.hash) return false;
    return value === getOutlookOAuthRedirectUri({
      isProduction: false,
      host: parsed.host,
    });
  } catch {
    return false;
  }
}

export { PRODUCTION_REDIRECT_URI };