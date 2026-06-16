import { API_BASE_URL } from '@/config';
import type {
  DashboardData,
  EventSummary,
  EventType,
  MobileLoginResponse,
  ResolvedCheckin,
} from '@/types';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

type Method = 'GET' | 'POST';

interface RequestOptions {
  method?: Method;
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
}

/**
 * Low-level fetch wrapper. Attaches the bearer token, parses JSON, and surfaces
 * a typed ApiError carrying the HTTP status so callers (and the auth layer) can
 * react to 401/403/404 distinctly.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, signal } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    throw new ApiError(0, 'Network request failed. Check your connection and try again.', err);
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const message =
      (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as any).error === 'string'
        ? (parsed as any).error
        : null) || `Request failed (${res.status})`;
    throw new ApiError(res.status, message, parsed);
  }

  return parsed as T;
}

/**
 * Extracts the check-in token from a scanned QR payload. The QR encodes a URL
 * such as `https://iconn.app/EventCheckIn?token=<token>`; we pull out the
 * `token` query param. Raw token strings (no URL) are accepted as-is.
 */
export function extractToken(scanned: string): string | null {
  const value = (scanned || '').trim();
  if (!value) return null;

  // Try to parse as a URL and read the `token` query param.
  const queryIndex = value.indexOf('?');
  if (queryIndex !== -1) {
    const query = value.slice(queryIndex + 1);
    for (const pair of query.split('&')) {
      const [k, v] = pair.split('=');
      if (k === 'token' && v) {
        try {
          return decodeURIComponent(v).trim() || null;
        } catch {
          return v.trim() || null;
        }
      }
    }
  }

  // Not a URL with a token param. If it looks like a bare token (no scheme,
  // no spaces), accept it directly; otherwise reject.
  if (!/\s/.test(value) && !/^https?:\/\//i.test(value)) {
    return value;
  }
  return null;
}

// ---- Auth ----

export function mobileLogin(email: string, password: string, tenantId?: string) {
  return request<MobileLoginResponse>('/api/auth/mobile-login', {
    method: 'POST',
    body: { email, password, ...(tenantId ? { tenantId } : {}) },
  });
}

export function mobileLogout(token: string) {
  return request<{ success: boolean; revoked: boolean }>('/api/auth/mobile-logout', {
    method: 'POST',
    token,
  });
}

// ---- Check-in ----

export function listEvents(token: string, signal?: AbortSignal) {
  return request<{ data: EventSummary[] }>('/api/admin/event-checkin?action=events', {
    token,
    signal,
  }).then((r) => r.data);
}

export function getDashboard(
  token: string,
  params: { eventId: string; eventType: EventType; sessionId?: string; trackId?: string },
  signal?: AbortSignal
) {
  const search = new URLSearchParams({ eventId: params.eventId, eventType: params.eventType });
  if (params.sessionId) search.set('sessionId', params.sessionId);
  if (params.trackId) search.set('trackId', params.trackId);
  return request<{ data: DashboardData }>(`/api/admin/event-checkin?${search.toString()}`, {
    token,
    signal,
  }).then((r) => r.data);
}

export function resolveToken(token: string, checkinToken: string, signal?: AbortSignal) {
  return request<{ data: ResolvedCheckin }>(
    `/api/admin/event-checkin?token=${encodeURIComponent(checkinToken)}`,
    { token, signal }
  ).then((r) => r.data);
}

export function markAttended(token: string, checkinToken: string) {
  return request<{ data: ResolvedCheckin; alreadyCheckedIn?: boolean }>('/api/admin/event-checkin', {
    method: 'POST',
    token,
    body: { action: 'mark', token: checkinToken },
  });
}

export function undoAttended(token: string, checkinToken: string, reason: string) {
  return request<{ data: ResolvedCheckin }>('/api/admin/event-checkin', {
    method: 'POST',
    token,
    body: { action: 'undo', token: checkinToken, reason },
  }).then((r) => r.data);
}
