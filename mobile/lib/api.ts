import type { Session } from '@supabase/supabase-js';

const apiUrl = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, '');

async function request<T>(path: string, session: Session, init: RequestInit): Promise<T> {
  if (!apiUrl) throw new Error('Missing EXPO_PUBLIC_API_URL');
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail ?? `API failed with HTTP ${response.status}`);
  return body as T;
}

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
