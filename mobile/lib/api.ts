import type { Session } from '@supabase/supabase-js';

const apiUrl = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '');

// Includes response-body reading. A timeout does not imply a mutation was rolled back.
const requestTimeoutMs = 30_000;

export class ApiError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function safeMessage(message: string, session: Session): string {
  let result = message;
  for (const token of [session.access_token, session.refresh_token]) {
    if (token) result = result.split(token).join('[redacted]');
  }
  return result
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/(?:sb_(?:secret|publishable)_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:ExponentPushToken|ExpoPushToken)\[[^\]]+\])/g, '[redacted]');
}

function httpError(body: unknown, status: number, session: Session): ApiError {
  const fallback = `API failed with HTTP ${status}`;
  const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : undefined;
  if (typeof detail === 'string' && detail.trim()) {
    return new ApiError(safeMessage(detail, session), status, `http_${status}`);
  }
  // FastAPI validation entries can contain submitted input and credential-bearing context.
  if (Array.isArray(detail)) {
    return new ApiError('Request validation failed. Check the submitted fields.', status, 'validation_error');
  }
  if (detail && typeof detail === 'object') {
    const code = 'code' in detail && typeof detail.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(detail.code)
      ? safeMessage(detail.code, session) : `http_${status}`;
    const message = 'message' in detail && typeof detail.message === 'string' && detail.message.trim()
      ? safeMessage(detail.message, session) : fallback;
    return new ApiError(message, status, code);
  }
  return new ApiError(fallback, status, `http_${status}`);
}

async function request<T>(path: string, session: Session, init: RequestInit): Promise<T> {
  if (!apiUrl) throw new ApiError('Missing EXPO_PUBLIC_API_URL', null, 'configuration_error');
  const controller = new AbortController();
  let status: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ApiError('API request timed out after 30 seconds. The server may have processed the request.', status, 'request_timeout'));
      controller.abort();
    }, requestTimeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetch(`${apiUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init.headers, Authorization: `Bearer ${session.access_token}` },
        signal: controller.signal,
      });
      status = response.status;
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw httpError(body, response.status, session);
      if (body === undefined) throw new ApiError('API returned an invalid JSON response', response.status, 'invalid_response');
      return body as T;
    })()]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Fetch errors can include URLs or credentials; do not surface the original error.
    throw new ApiError('Unable to reach the API. Check your connection.', status, 'network_error');
  } finally {
    clearTimeout(timer);
  }
}

/** Backend normalizes username/display_name and validates the IANA timezone. */
export type ProfileCreate = { username: string; display_name: string; timezone: string };
export type ProfileResult = ProfileCreate & { user_id: string; created_at: string; updated_at: string };

export const readProfile = (session: Session) =>
  request<ProfileResult>('/profiles/me', session, { method: 'GET' });

export const createProfile = (session: Session, profile: ProfileCreate) =>
  request<ProfileResult>('/profiles/me', session, { method: 'POST', body: JSON.stringify(profile) });

export const registerDevice = (session: Session, expoPushToken: string) =>
  request<{ registered: boolean; updated_at: string }>('/devices/register', session, {
    method: 'POST', body: JSON.stringify({ expo_push_token: expoPushToken, platform: 'android' }),
  });

export type TestResult = {
  request_id: string; success: boolean; database_verified: boolean; push_requested: boolean;
  expo_ticket_id: string | null; server_received_at: string;
  timings_ms: { database: number; push_request: number; server_total: number };
};

export const runInfrastructureTest = (session: Session, requestId: string, clientStartedAt: string) =>
  request<TestResult>('/infrastructure-test', session, {
    method: 'POST', body: JSON.stringify({ request_id: requestId, client_started_at: clientStartedAt }),
  });
