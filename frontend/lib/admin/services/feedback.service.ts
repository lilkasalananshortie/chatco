/**
 * Admin staff-feedback service (S6-T6 revised).
 *
 * Calls the Next.js proxy route `/api/admin/feedback` which forwards to
 * Laravel's `GET /api/v1/admin/feedback?conductor_id=|driver_id=`. The proxy
 * attaches the Sanctum bearer token from the httpOnly `chatco_session`
 * cookie — never called directly from the browser.
 *
 * Responsibilities:
 *   - Map snake_case Laravel rows → camelCase view-models the modal uses
 *   - Translate 404 (staff not found) / 403 (role) / 422 (missing param)
 *     into typed errors the UI can branch on
 *
 * Used by the Fleet Management > Personnel "Ratings & Feedback" modal, which
 * infinite-scrolls the reviews. Requests use the endpoint's cursor mode
 * (`pagination=cursor`): the first batch carries the summary, later batches
 * pass `next_cursor` and return `summary: null`.
 */

// ─── Raw backend shapes ─────────────────────────────────────────────

interface RawFeedbackRow {
  id: string;
  shift_id: string;
  vehicle_id: string;
  driver_id: string;
  conductor_id: string;
  commuter_id: string;
  rating: number;
  category: string | null;
  comment: string | null;
  created_at: string | null;
  vehicle: { id: string; unit_number: string; plate_number: string } | null;
  commuter: { id: string; first_name: string | null; surname: string | null } | null;
}

interface RawFeedbackListResponse {
  staff: { id: string; role: "CONDUCTOR" | "DRIVER" };
  /** Only on the first batch (no cursor). */
  summary: {
    average_rating: number;
    total_count: number;
    distribution: Record<string, number>;
    reasons?: Record<ReasonGroup, FeedbackReason[]>;
  } | null;
  feedback: RawFeedbackRow[];
  pagination: {
    per_page: number;
    next_cursor: string | null;
    has_more: boolean;
  };
}

// ─── Frontend view-model ────────────────────────────────────────────

/** complaints = tags from 1–3 star reviews, praise = from 4–5 star reviews. */
export type ReasonGroup = "complaints" | "praise";

export interface FeedbackReason {
  label: string;
  count: number;
}

export interface FeedbackRow {
  id: string;
  shiftId: string;
  rating: number;
  category: string | null;
  /** `category` split into the commuter's selected tags. */
  tags: string[];
  comment: string | null;
  createdAt: string | null;
  vehicle: { unitNumber: string; plateNumber: string } | null;
  commuter: { name: string } | null;
}

export interface FeedbackSummary {
  averageRating: number;
  totalCount: number;
  /** Keyed "5" → "1" with per-star counts. */
  distribution: Record<string, number>;
  /** Tags ranked by how often commuters picked them, most first. */
  reasons: Record<ReasonGroup, FeedbackReason[]>;
}

export interface FeedbackListResult {
  staff: { id: string; role: "CONDUCTOR" | "DRIVER" };
  /** Present on the first batch only; null when a cursor was sent. */
  summary: FeedbackSummary | null;
  feedback: FeedbackRow[];
  pagination: {
    perPage: number;
    /** Opaque keyset cursor for the next batch; null at the end. */
    nextCursor: string | null;
    hasMore: boolean;
  };
}

// ─── Query input ────────────────────────────────────────────────────

export interface FeedbackListQuery {
  /** conductor_profiles.id (== conductor user id, shared PK). */
  conductorId?: string;
  /** drivers.id. */
  driverId?: string;
  perPage?: number;
  /** `nextCursor` from the previous batch; omit for the first batch. */
  cursor?: string | null;
  /** 1–5: list only this star level. The summary always covers all ratings. */
  rating?: number;
  /** A tag label: list only reviews that picked it. Never narrows the summary. */
  reason?: string;
  /** Cancels a superseded request (filter change, modal closed). */
  signal?: AbortSignal;
}

// ─── Typed errors ───────────────────────────────────────────────────

export class FeedbackFetchError extends Error {
  constructor(
    public code:
      | "not_found"
      | "validation"
      | "forbidden"
      | "unauthenticated"
      | "network",
    message: string
  ) {
    super(message);
    this.name = "FeedbackFetchError";
  }
}

// ─── Mapper ─────────────────────────────────────────────────────────

function mapCommuterName(
  c: RawFeedbackRow["commuter"]
): string {
  if (!c) return "Anonymous";
  const first = c.first_name?.trim() ?? "";
  const last = c.surname?.trim() ?? "";
  const full = `${first} ${last}`.trim();
  return full || "Anonymous";
}

/**
 * Before the column was widened, the commuter app cut the joined tags at
 * exactly 50 characters, so the last tag of a 50-character value may be a
 * fragment ("Lo"). It is kept but marked with "…" rather than shown as a tag.
 * Mirrors FeedbackService::splitTags(), which leaves it out of the ranking.
 */
function splitTags(category: string | null): string[] {
  if (!category) return [];
  const tags = category.split(",").map((tag) => tag.trim()).filter(Boolean);
  if (category.length === 50 && tags.length > 1) tags[tags.length - 1] += "…";
  return tags;
}

function mapRow(raw: RawFeedbackRow): FeedbackRow {
  return {
    id: raw.id,
    shiftId: raw.shift_id,
    rating: raw.rating,
    category: raw.category,
    tags: splitTags(raw.category),
    comment: raw.comment,
    createdAt: raw.created_at,
    vehicle: raw.vehicle
      ? {
          unitNumber: raw.vehicle.unit_number,
          plateNumber: raw.vehicle.plate_number,
        }
      : null,
    commuter: raw.commuter ? { name: mapCommuterName(raw.commuter) } : null,
  };
}

function mapResult(raw: RawFeedbackListResponse): FeedbackListResult {
  return {
    staff: raw.staff,
    summary: raw.summary
      ? {
          averageRating: raw.summary.average_rating,
          totalCount: raw.summary.total_count,
          distribution: raw.summary.distribution,
          reasons: raw.summary.reasons ?? { complaints: [], praise: [] },
        }
      : null,
    feedback: raw.feedback.map(mapRow),
    pagination: {
      perPage: raw.pagination.per_page,
      nextCursor: raw.pagination.next_cursor,
      hasMore: raw.pagination.has_more,
    },
  };
}

// ─── Service function ───────────────────────────────────────────────

const API_PATH = "/api/admin/feedback";

function buildQueryString(q: FeedbackListQuery): string {
  const params = new URLSearchParams({ pagination: "cursor" });
  if (q.conductorId) params.set("conductor_id", q.conductorId);
  if (q.driverId) params.set("driver_id", q.driverId);
  if (q.perPage) params.set("per_page", String(q.perPage));
  if (q.cursor) params.set("cursor", q.cursor);
  if (q.rating) params.set("rating", String(q.rating));
  if (q.reason) params.set("reason", q.reason);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Fetch one batch of feedback (newest first) for a conductor or driver.
 *
 * Exactly one of `conductorId` / `driverId` must be supplied — the backend
 * returns 422 if neither is present. The caller chooses which based on the
 * row's role (CONDUCTOR → conductorId, DRIVER → driverId).
 *
 * @throws {FeedbackFetchError} 404 (staff not found) / 422 (missing param) /
 *   403 (role) / 401 (session expired) / 502 (network).
 */
export async function list(
  query: FeedbackListQuery
): Promise<FeedbackListResult> {
  const qs = buildQueryString(query);
  const res = await fetch(`${API_PATH}${qs}`, {
    headers: { Accept: "application/json" },
    credentials: "include",
    signal: query.signal,
  });

  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const body = await res.clone().json();
      if (body?.message) message = body.message;
    } catch {
      /* keep default message */
    }
    throw translateError(res.status, message);
  }

  const json = await res.json();
  // The proxy wraps Laravel's `data` field in `{ data: ... }`.
  return mapResult(json.data as RawFeedbackListResponse);
}

function translateError(status: number, message: string): FeedbackFetchError {
  switch (status) {
    case 401:
      return new FeedbackFetchError(
        "unauthenticated",
        "Your session has expired. Please log in again."
      );
    case 403:
      return new FeedbackFetchError(
        "forbidden",
        message || "You do not have permission to view feedback."
      );
    case 404:
      return new FeedbackFetchError("not_found", message || "Staff member not found.");
    case 422:
      return new FeedbackFetchError(
        "validation",
        message || "A conductor_id or driver_id is required."
      );
    case 502:
      return new FeedbackFetchError(
        "network",
        "Unable to reach the server. Please try again."
      );
    default:
      return new FeedbackFetchError("network", message || "An unexpected error occurred.");
  }
}
