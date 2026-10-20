import type { Session } from '@supabase/supabase-js';
import { usernameInput } from './username-input';
import { explanationInput } from './excuse-input';

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

async function request<T>(path: string, session: Session, init: RequestInit, responseType: 'json' | 'empty' = 'json'): Promise<T> {
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
      // Only endpoints whose contract is 204 may complete without JSON. An
      // unexpected success response is ambiguous and must be reconciled by callers.
      if (response.ok && responseType === 'empty') {
        if (response.status === 204) return undefined as T;
        throw new ApiError('API returned an unexpected response', response.status, 'invalid_response');
      }
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

export const updateProfile = (session: Session, profile: ProfileCreate) =>
  request<ProfileResult>('/profiles/me', session, { method: 'PATCH', body: JSON.stringify(profile) });

/** Search and relationships expose only this public identity, never full profiles. */
export type PublicProfile = { user_id: string; username: string; display_name: string };

/** Exact username lookup only; normalization matches backend ProfileFields. */
export async function searchProfile(session: Session, username: string): Promise<PublicProfile> {
  let normalized: string;
  try {
    normalized = usernameInput(username);
  } catch {
    throw new ApiError('Username must be 3–30 ASCII letters, digits, or underscores.', null, 'invalid_username');
  }
  return request<PublicProfile>(`/profiles/search?username=${encodeURIComponent(normalized)}`, session, { method: 'GET' });
}

export type RelationshipResult = {
  id: string;
  direction: 'incoming' | 'outgoing';
  state: 'pending' | 'accepted';
  profile: PublicProfile;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
};

export type FriendRequestLists = { incoming: RelationshipResult[]; outgoing: RelationshipResult[] };

export const listFriends = (session: Session) =>
  request<RelationshipResult[]>('/friends', session, { method: 'GET' });

export const listFriendRequests = (session: Session) =>
  request<FriendRequestLists>('/friend-requests', session, { method: 'GET' });

/** The backend derives the sender from the bearer token. */
export const sendFriendRequest = (session: Session, recipientUserId: string) =>
  request<RelationshipResult>('/friend-requests', session, {
    method: 'POST', body: JSON.stringify({ recipient_user_id: recipientUserId }),
  });

export const acceptFriendRequest = (session: Session, requestId: string) =>
  request<RelationshipResult>(`/friend-requests/${encodeURIComponent(requestId)}/accept`, session, { method: 'POST' });

export const rejectFriendRequest = (session: Session, requestId: string): Promise<void> =>
  request<void>(`/friend-requests/${encodeURIComponent(requestId)}/reject`, session, { method: 'POST' }, 'empty');

/** Removing a friendship also deletes both directions' habit sharing grants. */
export const removeFriend = (session: Session, friendUserId: string): Promise<void> =>
  request<void>(`/friends/${encodeURIComponent(friendUserId)}`, session, { method: 'DELETE' }, 'empty');

/** Weekdays use ISO numbering: Monday = 1, Sunday = 7; daily schedules return []. */
export type HabitWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Full server configuration, including nullable fields in occurrence snapshots. */
export type HabitSnapshot = {
  name: string;
  description: string | null;
  schedule: 'daily' | 'selected';
  weekdays: HabitWeekday[];
  reminder_times: string[];
} & (
  | { type: 'binary'; target: null; unit: null }
  | { type: 'target'; target: number; unit: string | null }
);

export type HabitResult = HabitSnapshot & {
  id: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type OccurrenceState = 'in_progress' | 'completed' | 'missed' | 'justification_pending' | 'excused';

export type OccurrenceResult = {
  id: string;
  habit_id: string;
  owner_id: string;
  local_date: string;
  timezone: string;
  closes_at: string;
  snapshot: HabitSnapshot;
  progress: number;
  completed: boolean;
  state: OccurrenceState;
  created_at: string;
  updated_at: string;
};

export type TodayResult = {
  local_date: string;
  timezone: string;
  server_time: string;
  occurrences: OccurrenceResult[];
};

/** The server determines the local date, due occurrences, snapshots, and states. */
export const readToday = (session: Session) =>
  request<TodayResult>('/today', session, { method: 'GET' });

/** Explicit binary assignment; eligibility and the occurrence deadline are server-enforced. */
export const setOccurrenceCompletion = (session: Session, id: string, completed: boolean) =>
  request<OccurrenceResult>(`/occurrences/${encodeURIComponent(id)}/completion`, session, {
    method: 'PUT', body: JSON.stringify({ completed }),
  });

/** Absolute target assignment; never serialize values JavaScript cannot represent exactly. */
export async function setOccurrenceProgress(session: Session, id: string, progress: number): Promise<OccurrenceResult> {
  if (!Number.isSafeInteger(progress) || progress < 0) {
    throw new ApiError('Progress must be a nonnegative safe integer.', null, 'invalid_progress');
  }
  return request<OccurrenceResult>(`/occurrences/${encodeURIComponent(id)}/progress`, session, {
    method: 'PUT', body: JSON.stringify({ progress }),
  });
}

export type HistoryExcuse = {
  id: string;
  explanation: string;
  status: 'pending' | 'approved' | 'rejected';
  decision_source: 'automatic' | 'friend' | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
};

export type HistoryOccurrence = OccurrenceResult & { excuse: HistoryExcuse | null };

export type ExcuseResult = HistoryExcuse & {
  occurrence_id: string;
  habit_id: string;
  owner_id: string;
  occurrence: OccurrenceResult;
};

export async function submitExcuse(session: Session, occurrenceId: string, explanation: string): Promise<ExcuseResult> {
  let normalized: string;
  try { normalized = explanationInput(explanation); }
  catch (error) { throw new ApiError(error instanceof Error ? error.message : 'Invalid explanation.', null, 'invalid_excuse_explanation'); }
  return request<ExcuseResult>(`/occurrences/${encodeURIComponent(occurrenceId)}/excuse`, session,
    { method: 'POST', body: JSON.stringify({ explanation: normalized }) });
}

export const readExcuse = (session: Session, occurrenceId: string) =>
  request<ExcuseResult>(`/occurrences/${encodeURIComponent(occurrenceId)}/excuse`, session, { method: 'GET' });

export const listPendingExcuses = (session: Session) =>
  request<ExcuseResult[]>('/excuses/pending', session, { method: 'GET' });

export const decideExcuse = (session: Session, excuseId: string, decision: 'approve' | 'reject') =>
  request<ExcuseResult>(`/excuses/${encodeURIComponent(excuseId)}/decision`, session,
    { method: 'POST', body: JSON.stringify({ decision }) });

export type HistoryResult = {
  habit_id: string;
  occurrences: HistoryOccurrence[];
  next_cursor: string | null;
};

export type StreakResult = {
  habit_id: string;
  current_streak: number;
  provisional: boolean;
  calculated_at: string;
};

/** Owner reads also support archived habits. Return opaque cursors unchanged. */
export const readHabitHistory = (session: Session, id: string, cursor?: string | null): Promise<HistoryResult> =>
  request<HistoryResult>(`/habits/${encodeURIComponent(id)}/history?limit=30${cursor == null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, session, { method: 'GET' });

/** Current streaks and provisional status are calculated only by the server. */
export const readHabitStreak = (session: Session, id: string): Promise<StreakResult> =>
  request<StreakResult>(`/habits/${encodeURIComponent(id)}/streak`, session, { method: 'GET' });

/** Sharing exposes public identities only and never follows from friendship alone. */
export const listHabitShares = (session: Session, id: string) =>
  request<PublicProfile[]>(`/habits/${encodeURIComponent(id)}/shares`, session, { method: 'GET' });

/** Explicit grants also work for archived owned habits. The actor is the bearer. */
export const grantHabitShare = (session: Session, id: string, friendUserId: string) =>
  request<PublicProfile>(`/habits/${encodeURIComponent(id)}/shares/${encodeURIComponent(friendUserId)}`, session, { method: 'PUT' });

export const revokeHabitShare = (session: Session, id: string, friendUserId: string): Promise<void> =>
  request<void>(`/habits/${encodeURIComponent(id)}/shares/${encodeURIComponent(friendUserId)}`, session, { method: 'DELETE' }, 'empty');

export type SharedOccurrence = Pick<OccurrenceResult,
  'id' | 'local_date' | 'timezone' | 'closes_at' | 'snapshot' | 'progress' | 'completed' | 'state'>;

/** Each entry has its own owner's Today; current configuration may differ from its snapshot. */
export type SharedHabitResult = {
  id: string;
  owner: PublicProfile;
  configuration: HabitSnapshot;
  local_date: string;
  timezone: string;
  server_time: string;
  due_today: boolean;
  occurrence: SharedOccurrence | null;
} & Pick<StreakResult, 'current_streak' | 'provisional' | 'calculated_at'>;

/** Recipients get streaks here; owner history/streak endpoints are never needed. */
export const listSharedHabits = (session: Session) =>
  request<SharedHabitResult[]>('/shared-habits', session, { method: 'GET' });

export const readSharedHabit = (session: Session, id: string) =>
  request<SharedHabitResult>(`/shared-habits/${encodeURIComponent(id)}`, session, { method: 'GET' });

/** Owner identity and timestamps are server-managed; binary payloads omit target/unit. */
export type HabitCreate = {
  name: string;
  description?: string | null;
  schedule: 'daily' | 'selected';
  weekdays: HabitWeekday[];
  reminder_times: string[];
} & (
  | { type: 'binary'; target?: never; unit?: never }
  | { type: 'target'; target: number; unit?: string | null }
);

export const createHabit = (session: Session, habit: HabitCreate) =>
  request<HabitResult>('/habits', session, { method: 'POST', body: JSON.stringify(habit) });

/** Owner identity comes from the current session; the backend returns an array. */
export type HabitStatus = 'active' | 'archived' | 'all';

export const listHabits = (session: Session, status: HabitStatus = 'active') =>
  request<HabitResult[]>(`/habits?status=${encodeURIComponent(status)}`, session, { method: 'GET' });

/** Omitted fields stay unchanged; only these three nullable fields can be cleared. */
export type HabitUpdate = {
  name?: string;
  description?: string | null;
  target?: number | null;
  unit?: string | null;
  schedule?: 'daily' | 'selected';
  weekdays?: HabitWeekday[];
  reminder_times?: string[];
};

export const readHabit = (session: Session, id: string) =>
  request<HabitResult>(`/habits/${encodeURIComponent(id)}`, session, { method: 'GET' });

export const updateHabit = (session: Session, id: string, changes: HabitUpdate) =>
  request<HabitResult>(`/habits/${encodeURIComponent(id)}`, session, { method: 'PATCH', body: JSON.stringify(changes) });

/** Lifecycle mutations preserve history/configuration and accept an absent body. */
export const archiveHabit = (session: Session, id: string) =>
  request<HabitResult>(`/habits/${encodeURIComponent(id)}/archive`, session, { method: 'POST' });

export const restoreHabit = (session: Session, id: string) =>
  request<HabitResult>(`/habits/${encodeURIComponent(id)}/restore`, session, { method: 'POST' });

export const registerDevice = (session: Session, expoPushToken: string, registrationId: string, platform: 'android' | 'ios') =>
  request<{ registered: boolean; registration_id: string; updated_at: string }>('/devices/register', session, {
    method: 'POST', body: JSON.stringify({ expo_push_token: expoPushToken, registration_id: registrationId, platform }),
  });

export const unregisterDevice = (session: Session, registrationId: string) =>
  request<{ removed: boolean }>('/devices/unregister', session, {
    method: 'POST', body: JSON.stringify({ registration_id: registrationId }),
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
