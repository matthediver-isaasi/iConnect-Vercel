// Infrastructure failure is not evidence of logout. Throw rather than return
// a truthy pseudo-session or null (which guest consumers treat as authoritative).
export class SessionUnavailableError extends Error {
  constructor(cause) {
    super('Session verification is temporarily unavailable.', { cause });
    this.code = 'SESSION_UNAVAILABLE';
    this.status = 503;
  }
}

export function sessionUnavailable(error) {
  return error?.code === 'SESSION_UNAVAILABLE'
    ? error : new SessionUnavailableError(error);
}

export async function boundedSessionLookup(read, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(sessionUnavailable()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function sendSessionUnavailable(res, error) {
  if (error?.code !== 'SESSION_UNAVAILABLE') return false;
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(503).json({ code: 'SESSION_UNAVAILABLE', error: error.message });
  return true;
}
