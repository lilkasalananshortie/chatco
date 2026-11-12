/**
 * Shared Lost & Found service (S6-T8).
 *
 * Single CRUD gateway used by BOTH the commuter lost-and-found page and the
 * admin lost-found page. Calls the Next.js proxy routes (which forward to
 * Laravel with the httpOnly `chatco_session` cookie) — never Laravel directly.
 *
 *   COMMUTER (role:COMMUTER for claim/watch; any auth role for browse):
 *     GET  /api/lost-found                         → list({ status?, category?, search?, page? })
 *     GET  /api/lost-found/{id}                    → show(id)
 *     POST /api/lost-found/{id}/claim              → claim(id, { proof, contact?, email?, images? })
 *
 *   ADMIN (role:ADMIN):
 *     GET  /api/admin/lost-items                   → listForAdmin({ status?, statuses?, category?, page? })
 *     POST /api/admin/lost-items                   → report({ itemName, description, ... })
 *     PATCH /api/admin/lost-items/{id}              → update(id, { itemName, description, ... })
 *     POST /api/admin/lost-items/{id}/photos       → addPhoto(id, file)
 *     DELETE /api/admin/lost-items/{id}/photos/{pid} → deletePhoto(id, pid)
 *     PATCH /api/admin/lost-items/{id}/reactivate   → reactivate(id)
 *     GET  /api/admin/lost-items/{id}/claims       → claimsForItem(id)
 *     PATCH /api/admin/lost-items/{id}/claims/{cid}/approve   → approveClaim(id, cid)
 *     PATCH /api/admin/lost-items/{id}/claims/{cid}/release   → releaseClaim(id, cid)
 *     PATCH /api/admin/lost-items/{id}/claims/{cid}/reject    → rejectClaim(id, cid, reason?)
 *     PATCH /api/admin/lost-items/{id}/close                  → close(id)
 *
 * Responsibilities:
 *   - Map snake_case Laravel rows → camelCase view-models the existing UI uses.
 *   - Translate backend HTTP codes (404/409/422/403/401) into typed error
 *     codes so the UI can branch without parsing strings.
 *   - Map the backend's status enum (AVAILABLE/CLAIMED/APPROVED/RELEASED/
 *     CLOSED for items; PENDING/APPROVED/REJECTED for claims) to the
 *     display strings the existing admin UI expects (Unmatched/Claimed/
 *     Released/Returned/Rejected for items; Pending/Approved/Rejected/
 *     Released/Returned for claims).
 *
 * Mirrors the pattern established by lib/commuter/services/feedback.service.ts.
 */

import { api, ApiError, RequestCancelledError } from "@/lib/api/client";
import { compressImage, compressImages } from "@/lib/utils/compress-image";

// ─── Backend status enums ────────────────────────────────────────────

/**
 * Backend lost_items.status values (LostItemService constants).
 * The commuter list defaults to AVAILABLE/CLAIMED (active items).
 */
export type BackendItemStatus =
  | "AVAILABLE"
  | "CLAIMED"
  | "APPROVED"
  | "RELEASED"
  | "CLOSED"
  | "EXPIRED";

/** Backend claims.status values. */
export type BackendClaimStatus = "PENDING" | "APPROVED" | "REJECTED" | "RELEASED";

// ─── Raw backend shapes ─────────────────────────────────────────────

/** A lost_items row as returned by Laravel (snake_case). */
interface RawLostItem {
  id: string;
  item_name: string;
  description: string;
  image_url: string | null;
  plate_number: string | null;
  driver_name: string | null;
  conductor_name: string | null;
  vehicle_id: string | null;
  estimated_time_lost: string | null;
  category: string | null;
  reported_by_id: string | null;
  reported_by_role: string | null;
  reporter_name: string | null;
  status: string;
  claimed_by: string | null;
  released_to: string | null;
  released_at: string | null;
  closed_by: string | null;
  /** Resolved admin display name for closed_by (see LostItem::getClosedByNameAttribute). Also who released it — releaseClaim() stamps closed_by too. */
  closed_by_name: string | null;
  closed_at: string | null;
  expired_at: string | null;
  /** When an AVAILABLE item drops out of Lost & Found (LostItem::getClaimableUntilAttribute); null otherwise. */
  claimable_until: string | null;
  created_at: string;
  updated_at: string;
  // Eager-loaded only on the admin list (listForAdmin)
  claims?: RawClaim[];
  // Eager-loaded on every fetch — up to 3 photos, position 0 is the thumbnail
  // (also mirrored onto image_url so single-image read sites keep working).
  photos?: RawPhoto[];
  // The signed-in commuter's own latest claim on this item (browse + watchlist only).
  my_claim?: { id: string; status: string } | null;
}

/** A lost_item_photos row as returned by Laravel (snake_case). */
interface RawPhoto {
  id: string;
  url: string;
  position: number;
}

/** A claims row as returned by Laravel (snake_case). */
interface RawClaim {
  id: string;
  item_id: string;
  claimant_id: string | null;
  claimant_name: string | null;
  claimant_contact: string | null;
  claimant_email: string | null;
  status: string;
  proof: string | null;
  reviewed_by: string | null;
  /** Resolved admin display name for reviewed_by (see Claim::getReviewedByNameAttribute). */
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  released_at: string | null;
  rejection_reason: string | null;
  pickup_location: string | null;
  pickup_at: string | null;
  pickup_reminder: string | null;
  /** Set when an approved claimant never collected the item and the claim was auto-rejected. */
  no_show_at: string | null;
  created_at: string;
  // Proof-of-ownership photos — loaded on claim create + the admin claim lists only.
  photos?: RawPhoto[];
  // Eager-loaded on GET /commuter/claims (myClaims)
  item?: RawLostItem | null;
  // Eager-loaded on the admin claim list (claims.claimant) — null for walk-in
  // claimants recorded via storeManualClaim (no claimant_id).
  claimant?: {
    id: string;
    first_name: string;
    surname: string;
    username: string;
    account_status: string;
  } | null;
}

/** A lost_item_watchlists row as returned by Laravel (snake_case). */
interface RawWatchlistEntry {
  id: string;
  item_id: string;
  commuter_id: string;
  created_at: string;
  // Eager-loaded on GET /commuter/watchlist
  item?: RawLostItem | null;
}

/** Laravel ApiResponse envelope. */
interface ApiResponseEnvelope<T> {
  success: boolean;
  data: T;
  message: string;
  errors: Record<string, string[]> | null;
  meta: unknown;
}

/** Laravel paginator shape (data is the array of rows). */
interface PaginatedEnvelope<T> {
  data: T[];
  current_page: number;
  per_page: number;
  total: number;
  last_page: number;
  from: number | null;
  to: number | null;
}

// ─── Frontend view-models (camelCase) ───────────────────────────────

/**
 * A lost item, in the shape the existing commuter + admin UIs consume.
 * Kept compatible with the legacy `LostItem` / `LostFoundItem` interfaces
 * so we don't have to rewrite the card/grid components.
 */
export interface LostFoundItem {
  id: string;
  itemName: string;
  description: string;
  imageUrl: string;
  plateNumber: string;
  driverName: string;
  conductorName: string;
  vehicleId: string | null;
  estimatedTimeLost: string;
  category: string;
  datePosted: string;
  reporterName: string;
  /** Raw backend status (AVAILABLE/CLAIMED/APPROVED/RELEASED/CLOSED). */
  status: string;
  /** Display status for the admin UI (Unmatched/Claimed/Released/Returned/Closed). */
  displayStatus: string;
  /** Claimant name (admin-only; null for commuters — privacy). */
  claimedBy: string | null;
  /** Who the item was released to (admin-only). */
  releasedTo: string | null;
  releasedAt: string | null;
  closedAt: string | null;
  /** Admin who released/closed this item (admin-only); null until released. */
  closedByName: string | null;
  /** When lost-items:expire auto-archived this item; null if never expired. */
  expiredAt: string | null;
  /** Last day an unclaimed (AVAILABLE) item stays listed; null for any other status. */
  claimableUntil: string | null;
  /** Up to 3 photos, position 0 first (the thumbnail — same URL as imageUrl). */
  photos: { id: string; url: string }[];
  /** The signed-in commuter's own latest claim (backend status), on the browse + watchlist lists; null otherwise. */
  myClaim: { id: string; status: string } | null;
}

/** A claim on a lost item. */
export interface LostFoundClaim {
  id: string;
  itemId: string;
  claimantName: string;
  claimantContact: string;
  claimantEmail: string | null;
  claimDate: string;
  /** Raw backend status (PENDING/APPROVED/REJECTED). */
  status: string;
  /** Display status for the admin UI (Pending/Approved/Rejected). */
  displayStatus: string;
  proof: string;
  /** Proof-of-ownership photos (up to 3), position order. */
  proofPhotos: { id: string; url: string }[];
  rejectionReason: string | null;
  /** Admin who approved/rejected this claim; null until reviewed. */
  reviewedByName: string | null;
  reviewedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  releasedAt: string | null;
  /** Where/when the approved claimant collects the item, set by the admin at approval. */
  pickupLocation: string | null;
  pickupAt: string | null;
  pickupReminder: string | null;
  /** When an uncollected approved claim was auto-rejected ("did not proceed"); null otherwise. */
  noShowAt: string | null;
  /** The registered account that filed this claim; null for walk-in claimants. */
  linkedAccount: { id: string; name: string; username: string; accountStatus: string } | null;
}

/** Paginated list result. */
export interface LostFoundPage {
  items: LostFoundItem[];
  page: number;
  lastPage: number;
  total: number;
}

/** One of the commuter's own claims, with the claimed item attached. */
export type MyClaim = LostFoundClaim & { item: LostFoundItem | null };

/** Paginated commuter claims result. */
export interface MyClaimsPage {
  claims: MyClaim[];
  page: number;
  lastPage: number;
  total: number;
}

// ─── Typed errors ───────────────────────────────────────────────────

export type LostFoundErrorCode =
  /** 404 — item or claim not found. */
  | "not_found"
  /** 409 — conflict (e.g. claiming an already-CLAIMED/APPROVED item). */
  | "conflict"
  /** 422 — validation (missing proof, bad field, etc.). */
  | "validation"
  /** 403 — caller lacks the role (e.g. commuter hitting admin endpoint). */
  | "forbidden"
  /** 401 — session expired. */
  | "unauthenticated"
  /** 429 — too many requests in the current minute; safe to retry shortly. */
  | "rate_limited"
  /** 5xx / network failure. */
  | "network";

/**
 * Thrown by any service method on a non-success response. Carries a stable
 * `code` so the UI can branch (e.g. 409 conflict → "Item already claimed"
 * inline; 401 → redirect to login).
 */
export class LostFoundOperationError extends Error {
  constructor(
    public code: LostFoundErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LostFoundOperationError";
  }
}

// ─── Status mappers ─────────────────────────────────────────────────

/**
 * Map a backend item status → the display string the admin UI badge expects.
 *
 * Backend → Admin display:
 *   AVAILABLE → Unmatched (no claims yet)
 *   CLAIMED   → Claimed    (≥1 pending claim)
 *   APPROVED  → Claimed    (a claim was approved; transient — release follows)
 *   RELEASED  → Released   (handed over to the claimant)
 *   CLOSED    → Closed     (admin closed the item after handover)
 *   EXPIRED   → Expired    (auto-archived, unclaimed past the expiry window)
 *
 * The commuter UI uses its own status badge logic (it only sees AVAILABLE
 * vs CLAIMED in the default list, both shown as "active"; EXPIRED items are
 * excluded from the commuter browse list entirely).
 */
function mapItemDisplayStatus(status: string): string {
  switch (status) {
    case "AVAILABLE":
      return "Unmatched";
    case "CLAIMED":
    case "APPROVED":
      return "Claimed";
    case "RELEASED":
      return "Released";
    case "CLOSED":
      return "Closed";
    case "EXPIRED":
      return "Expired";
    default:
      return status;
  }
}

/** Map a backend claim status → the display string the admin UI expects. */
function mapClaimDisplayStatus(status: string): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    case "RELEASED":
      return "Released";
    default:
      return status;
  }
}

// ─── Row mappers ────────────────────────────────────────────────────

function mapItem(raw: RawLostItem): LostFoundItem {
  return {
    id: raw.id,
    itemName: raw.item_name ?? "Unknown item",
    description: raw.description ?? "",
    imageUrl: raw.image_url ?? "",
    plateNumber: raw.plate_number ?? "—",
    driverName: raw.driver_name ?? "—",
    conductorName: raw.conductor_name ?? "—",
    vehicleId: raw.vehicle_id ?? null,
    estimatedTimeLost: raw.estimated_time_lost ?? "—",
    category: raw.category ?? "OTHER",
    datePosted: raw.created_at,
    reporterName: raw.reporter_name ?? "Admin",
    status: raw.status,
    displayStatus: mapItemDisplayStatus(raw.status),
    claimedBy: raw.claimed_by,
    releasedTo: raw.released_to,
    releasedAt: raw.released_at,
    closedAt: raw.closed_at,
    closedByName: raw.closed_by_name ?? null,
    expiredAt: raw.expired_at,
    claimableUntil: raw.claimable_until ?? null,
    photos: (raw.photos ?? []).map((p) => ({ id: p.id, url: p.url })),
    myClaim: raw.my_claim ?? null,
  };
}

function mapClaim(raw: RawClaim): LostFoundClaim {
  return {
    id: raw.id,
    itemId: raw.item_id,
    claimantName: raw.claimant_name ?? "Unknown",
    claimantContact: raw.claimant_contact ?? "—",
    claimantEmail: raw.claimant_email ?? null,
    claimDate: raw.created_at,
    status: raw.status,
    displayStatus: mapClaimDisplayStatus(raw.status),
    proof: raw.proof ?? "",
    proofPhotos: (raw.photos ?? []).map((photo) => ({ id: photo.id, url: photo.url })),
    rejectionReason: raw.rejection_reason ?? null,
    reviewedByName: raw.reviewed_by_name ?? null,
    reviewedAt: raw.reviewed_at,
    approvedAt: raw.approved_at,
    rejectedAt: raw.rejected_at,
    releasedAt: raw.released_at,
    pickupLocation: raw.pickup_location ?? null,
    pickupAt: raw.pickup_at ?? null,
    pickupReminder: raw.pickup_reminder ?? null,
    noShowAt: raw.no_show_at ?? null,
    linkedAccount: raw.claimant
      ? {
          id: raw.claimant.id,
          name: `${raw.claimant.first_name} ${raw.claimant.surname}`.trim(),
          username: raw.claimant.username,
          accountStatus: raw.claimant.account_status,
        }
      : null,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract the human message from an ApiError body (Laravel envelope). */
function readMessage(err: ApiError, fallback: string): string {
  const body = err.body as { message?: string } | null;
  return body?.message ?? fallback;
}

/** Map an ApiError to a typed LostFoundOperationError. */
function classifyError(err: ApiError, fallback: string): LostFoundOperationError {
  const message = readMessage(err, fallback);
  switch (err.status) {
    case 404:
      return new LostFoundOperationError("not_found", message);
    case 409:
      return new LostFoundOperationError("conflict", message);
    case 422:
      return new LostFoundOperationError("validation", message);
    case 403:
      return new LostFoundOperationError("forbidden", message);
    case 401:
      return new LostFoundOperationError("unauthenticated", message);
    case 429:
      return new LostFoundOperationError("rate_limited", message);
    default:
      return new LostFoundOperationError("network", message);
  }
}

/** Build a query string from an optional params object, skipping empties. */
function buildQuery(params: Record<string, string | number | string[] | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    // Arrays go out as repeated `key[]=` entries (Laravel array input).
    if (Array.isArray(v)) v.forEach((entry) => sp.append(`${k}[]`, entry));
    else if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ─── Service: browse (any auth role) ────────────────────────────────

/** Posted-within window for the commuter list endpoints (backend `range` param). */
export type LostFoundTimeRange = "today" | "week" | "month" | "year";

/**
 * Fetch a paginated list of lost items (the public browse endpoint).
 *
 * @throws {LostFoundOperationError} 401/403/5xx
 */
export async function list(params: {
  status?: string;
  category?: string;
  search?: string;
  date?: string;
  /** Inclusive posted-date window ('YYYY-MM-DD'); either end may be omitted. */
  dateFrom?: string;
  dateTo?: string;
  /** Any of these categories; empty/omitted means every category. */
  categories?: string[];
  range?: LostFoundTimeRange;
  page?: number;
  perPage?: number;
  /** Cancels this request if a newer one supersedes it (e.g. rapid filter changes). */
  signal?: AbortSignal;
} = {}): Promise<LostFoundPage> {
  const qs = buildQuery({
    status: params.status,
    category: params.category === "ALL" ? undefined : params.category,
    categories: params.categories,
    search: params.search,
    date: params.date,
    date_from: params.dateFrom,
    date_to: params.dateTo,
    range: params.range,
    page: params.page,
    per_page: params.perPage,
  });
  try {
    const response = await api.get<ApiResponseEnvelope<PaginatedEnvelope<RawLostItem>>>(
      `/api/lost-found${qs}`,
      undefined,
      { signal: params.signal }
    );
    const p = response.data;
    return {
      items: (p?.data ?? []).map(mapItem),
      page: p?.current_page ?? params.page ?? 1,
      lastPage: p?.last_page ?? 1,
      total: p?.total ?? 0,
    };
  } catch (err) {
    if (err instanceof RequestCancelledError) throw err;
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to load lost & found items.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * Fetch a paginated list of lost items WITH claims eager-loaded (admin view).
 *
 * `statuses` (multiple) filters to any of several statuses at once — powers
 * the admin History tab (RELEASED + CLOSED) without a dedicated endpoint.
 * `status` (single) still filters to one exact status, e.g. the Expired tab.
 *
 * @throws {LostFoundOperationError} 401/403/5xx
 */
export async function listForAdmin(params: {
  status?: string;
  statuses?: string[];
  category?: string;
  search?: string;
  date?: string;
  page?: number;
  perPage?: number;
  /** Cancels this request if a newer one supersedes it (e.g. rapid filter changes). */
  signal?: AbortSignal;
} = {}): Promise<LostFoundPage & { items: (LostFoundItem & { claims: LostFoundClaim[] })[] }> {
  const qs = buildQuery({
    status: params.status,
    category: params.category === "ALL" ? undefined : params.category,
    search: params.search,
    date: params.date,
    page: params.page,
    per_page: params.perPage,
  });
  const statusesQs = (params.statuses ?? [])
    .map((s) => `statuses[]=${encodeURIComponent(s)}`)
    .join("&");
  const fullQs = statusesQs
    ? qs
      ? `${qs}&${statusesQs}`
      : `?${statusesQs}`
    : qs;
  try {
    const response = await api.get<ApiResponseEnvelope<PaginatedEnvelope<RawLostItem>>>(
      `/api/admin/lost-items${fullQs}`,
      undefined,
      { signal: params.signal }
    );
    const p = response.data;
    return {
      items: (p?.data ?? []).map((raw) => ({
        ...mapItem(raw),
        claims: (raw.claims ?? []).map(mapClaim),
      })),
      page: p?.current_page ?? params.page ?? 1,
      lastPage: p?.last_page ?? 1,
      total: p?.total ?? 0,
    };
  } catch (err) {
    if (err instanceof RequestCancelledError) throw err;
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to load lost & found items.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * Fetch a single lost item by ID (detail view).
 * @throws {LostFoundOperationError} 404/401/5xx
 */
export async function show(id: string): Promise<LostFoundItem> {
  try {
    const response = await api.get<ApiResponseEnvelope<RawLostItem>>(`/api/lost-found/${id}`);
    return mapItem(response.data);
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to load this item.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

// ─── Service: commuter watchlist + own claims (DB-backed) ───────────

/**
 * Add an item to the commuter's watchlist (idempotent on the backend).
 * @throws {LostFoundOperationError} 404/401/403/5xx
 */
export async function watch(itemId: string): Promise<void> {
  try {
    await api.post<ApiResponseEnvelope<unknown>>(`/api/lost-found/${itemId}/watchlist`);
  } catch (err) {
    if (err instanceof ApiError) throw classifyError(err, "Unable to bookmark item.");
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * Remove an item from the commuter's watchlist (idempotent on the backend).
 * @throws {LostFoundOperationError} 401/403/5xx
 */
export async function unwatch(itemId: string): Promise<void> {
  try {
    await api.delete<ApiResponseEnvelope<unknown>>(`/api/lost-found/${itemId}/watchlist`);
  } catch (err) {
    if (err instanceof ApiError) throw classifyError(err, "Unable to remove bookmark.");
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * The commuter's watchlisted items (paginated, newest first). Entries whose
 * item was deleted are dropped.
 * @throws {LostFoundOperationError} 401/403/5xx
 */
export async function myWatchlist(params: {
  page?: number;
  perPage?: number;
  date?: string;
  search?: string;
  range?: LostFoundTimeRange;
  category?: string;
  dateFrom?: string;
  dateTo?: string;
  categories?: string[];
  /** Cancels this request if a newer one supersedes it (e.g. rapid filter changes). */
  signal?: AbortSignal;
} = {}): Promise<LostFoundPage> {
  const qs = buildQuery({ page: params.page, per_page: params.perPage, date: params.date, date_from: params.dateFrom, date_to: params.dateTo, search: params.search, range: params.range, category: params.category, categories: params.categories });
  try {
    const response = await api.get<ApiResponseEnvelope<PaginatedEnvelope<RawWatchlistEntry>>>(
      `/api/commuter/watchlist${qs}`,
      undefined,
      { signal: params.signal }
    );
    const p = response.data;
    return {
      items: (p?.data ?? [])
        .map((entry) => (entry.item ? mapItem(entry.item) : null))
        .filter((item): item is LostFoundItem => item !== null),
      page: p?.current_page ?? params.page ?? 1,
      lastPage: p?.last_page ?? 1,
      total: p?.total ?? 0,
    };
  } catch (err) {
    if (err instanceof RequestCancelledError) throw err;
    if (err instanceof ApiError) throw classifyError(err, "Unable to load your bookmarks.");
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * The commuter's own claims (item eager-loaded), newest first. Powers the
 * "My Claims" tab + per-card badges — claim state lives in the DB, not React.
 * @throws {LostFoundOperationError} 401/403/5xx
 */
export async function myClaims(params: {
  page?: number;
  perPage?: number;
  status?: BackendClaimStatus;
  date?: string;
  search?: string;
  range?: LostFoundTimeRange;
  category?: string;
  dateFrom?: string;
  dateTo?: string;
  categories?: string[];
  /** Cancels this request if a newer one supersedes it (e.g. rapid filter changes). */
  signal?: AbortSignal;
} = {}): Promise<MyClaimsPage> {
  const qs = buildQuery({ page: params.page, per_page: params.perPage, status: params.status, date: params.date, date_from: params.dateFrom, date_to: params.dateTo, search: params.search, range: params.range, category: params.category, categories: params.categories });
  try {
    const response = await api.get<ApiResponseEnvelope<PaginatedEnvelope<RawClaim>>>(
      `/api/commuter/claims${qs}`,
      undefined,
      { signal: params.signal }
    );
    const p = response.data;
    return {
      claims: (p?.data ?? []).map((raw) => ({
        ...mapClaim(raw),
        item: raw.item ? mapItem(raw.item) : null,
      })),
      page: p?.current_page ?? params.page ?? 1,
      lastPage: p?.last_page ?? 1,
      total: p?.total ?? 0,
    };
  } catch (err) {
    if (err instanceof RequestCancelledError) throw err;
    if (err instanceof ApiError) throw classifyError(err, "Unable to load your claims.");
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * Withdraw the commuter's own PENDING claim (deletes the claim row; the item
 * reverts to AVAILABLE when it was the last pending claim).
 * @throws {LostFoundOperationError} 404 (not found/not owned)/422 (not PENDING)/401/403/5xx
 */
export async function cancelClaim(claimId: string): Promise<void> {
  try {
    await api.delete<ApiResponseEnvelope<unknown>>(`/api/lost-found/claims/${claimId}`);
  } catch (err) {
    if (err instanceof ApiError) throw classifyError(err, "Unable to cancel this claim.");
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

// ─── Service: admin report (POST /admin/lost-items) ─────────────────

/**
 * Admin reports a new lost item.
 *
 * @throws {LostFoundOperationError} 422/401/403/5xx
 */
export async function report(params: {
  itemName: string;
  description: string;
  imageUrl?: string;
  plateNumber?: string;
  driverName?: string;
  conductorName?: string;
  vehicleId?: string;
  estimatedTimeLost?: string;
  category?: string;
}): Promise<LostFoundItem> {
  try {
    const response = await api.post<ApiResponseEnvelope<RawLostItem>>(`/api/admin/lost-items`, {
      item_name: params.itemName,
      description: params.description,
      ...(params.imageUrl ? { image_url: params.imageUrl } : {}),
      ...(params.plateNumber ? { plate_number: params.plateNumber } : {}),
      ...(params.driverName ? { driver_name: params.driverName } : {}),
      ...(params.conductorName ? { conductor_name: params.conductorName } : {}),
      ...(params.vehicleId ? { vehicle_id: params.vehicleId } : {}),
      ...(params.estimatedTimeLost ? { estimated_time_lost: params.estimatedTimeLost } : {}),
      ...(params.category ? { category: params.category } : {}),
    });
    return mapItem(response.data);
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to report this item.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * Admin adds a photo to a lost item (multipart), up to 3 total. Appended at
 * the next open position — position 0 (the first photo ever added) is the
 * thumbnail shown everywhere a single image was shown before.
 *
 * Uses raw fetch instead of the shared api client — the client always sends
 * `Content-Type: application/json`, which breaks multipart (the browser must
 * set the boundary itself). Field name + limits per the backend
 * UploadLostItemImageRequest: `image`, jpg/jpeg/png/webp, max 5MB.
 *
 * @throws {LostFoundOperationError} 404/422 (bad type, >5MB, or already at 3 photos)/401/403/5xx
 */
export async function addPhoto(itemId: string, file: File): Promise<LostFoundItem> {
  return uploadItemPhoto(`/api/admin/lost-items/${itemId}/photos`, file, "Unable to add this photo.");
}

/**
 * Admin swaps one photo's file in place. The photo keeps its id and
 * position, so replacing the thumbnail keeps it the thumbnail (a delete +
 * add would append the new file and promote the next photo instead).
 *
 * @throws {LostFoundOperationError} 404 (item/photo)/422 (bad type, >5MB)/401/403/5xx
 */
export async function replacePhoto(itemId: string, photoId: string, file: File): Promise<LostFoundItem> {
  return uploadItemPhoto(
    `/api/admin/lost-items/${itemId}/photos/${photoId}`,
    file,
    "Unable to replace this photo."
  );
}

/** Shared multipart POST for the add/replace photo endpoints (see addPhoto). */
async function uploadItemPhoto(url: string, file: File, fallbackMessage: string): Promise<LostFoundItem> {
  const formData = new FormData();
  formData.append("image", await compressImage(file));
  try {
    const res = await fetch(url, {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw classifyError(new ApiError(res.status, res.statusText, body), fallbackMessage);
    }
    const envelope = body as ApiResponseEnvelope<RawLostItem>;
    return mapItem(envelope.data);
  } catch (err) {
    if (err instanceof LostFoundOperationError) throw err;
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * Admin removes a photo from a lost item. Remaining photos re-compact to
 * stay at contiguous positions, and the thumbnail (imageUrl) re-syncs to
 * whatever now sits at position 0 (null if none left).
 *
 * @throws {LostFoundOperationError} 404/401/403/5xx
 */
export async function deletePhoto(itemId: string, photoId: string): Promise<LostFoundItem> {
  try {
    const response = await api.delete<ApiResponseEnvelope<RawLostItem>>(
      `/api/admin/lost-items/${itemId}/photos/${photoId}`
    );
    return mapItem(response.data);
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to remove this photo.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * Admin edits a previously reported item's descriptive fields. Blocked once
 * the item is CLOSED (a finalized historical record).
 *
 * @throws {LostFoundOperationError} 404/422 (item CLOSED)/401/403/5xx
 */
export async function update(
  itemId: string,
  params: {
    itemName: string;
    description: string;
    plateNumber?: string;
    driverName?: string;
    conductorName?: string;
    vehicleId?: string;
    estimatedTimeLost?: string;
    category?: string;
  }
): Promise<LostFoundItem> {
  try {
    const response = await api.patch<ApiResponseEnvelope<RawLostItem>>(
      `/api/admin/lost-items/${itemId}`,
      {
        item_name: params.itemName,
        description: params.description,
        ...(params.plateNumber ? { plate_number: params.plateNumber } : {}),
        ...(params.driverName ? { driver_name: params.driverName } : {}),
        ...(params.conductorName ? { conductor_name: params.conductorName } : {}),
        ...(params.vehicleId ? { vehicle_id: params.vehicleId } : {}),
        ...(params.estimatedTimeLost ? { estimated_time_lost: params.estimatedTimeLost } : {}),
        ...(params.category ? { category: params.category } : {}),
      }
    );
    return mapItem(response.data);
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to update this item.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * Admin manually brings an EXPIRED item back to AVAILABLE (e.g. a claimant
 * turns up after the archive window closed). Not lost forever.
 *
 * @throws {LostFoundOperationError} 404/422 (not currently EXPIRED)/401/403/5xx
 */
export async function reactivate(itemId: string): Promise<LostFoundItem> {
  try {
    const response = await api.patch<ApiResponseEnvelope<RawLostItem>>(
      `/api/admin/lost-items/${itemId}/reactivate`
    );
    return mapItem(response.data);
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to reactivate this item.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/** Server cap on ids per bulk reactivate request (LostItemService::MAX_BULK_REACTIVATE). */
export const MAX_BULK_REACTIVATE = 100;

/**
 * Bulk reactivate(): EXPIRED → AVAILABLE for many items in one request and
 * one transaction. Ids that are no longer EXPIRED (or no longer exist) come
 * back in `skipped` rather than failing the batch. Larger selections are
 * sent in sequential chunks of MAX_BULK_REACTIVATE.
 *
 * @throws {LostFoundOperationError} 422/401/403/5xx (ids from chunks that
 *   already succeeded stay reactivated)
 */
export async function reactivateMany(itemIds: string[]): Promise<{ reactivated: string[]; skipped: string[] }> {
  const reactivated: string[] = [];
  const skipped: string[] = [];
  try {
    for (let start = 0; start < itemIds.length; start += MAX_BULK_REACTIVATE) {
      const response = await api.patch<ApiResponseEnvelope<{ reactivated?: string[]; skipped?: string[] }>>(
        `/api/admin/lost-items/reactivate`,
        { item_ids: itemIds.slice(start, start + MAX_BULK_REACTIVATE) }
      );
      reactivated.push(...(response.data?.reactivated ?? []));
      skipped.push(...(response.data?.skipped ?? []));
    }
    return { reactivated, skipped };
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to reactivate the selected items.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

// ─── Service: commuter claim (POST /lost-found/{id}/claim) ──────────

/**
 * Commuter submits a claim on a lost item with proof of ownership, plus up
 * to 3 optional proof photos.
 *
 * Multipart via raw fetch, same as addPhoto() — the shared api client always
 * sends `Content-Type: application/json`. Photo limits per the backend
 * ClaimLostItemRequest: `images[]`, jpg/jpeg/png/webp, max 5MB each.
 *
 * @throws {LostFoundOperationError}
 *   - 409 → conflict (item already CLAIMED/APPROVED/RELEASED/CLOSED)
 *   - 422 → validation (proof missing/too long, bad/oversized photo, >3 photos)
 *   - 403 → non-commuter
 *   - 401 → unauthenticated
 */
export async function claim(
  itemId: string,
  params: { proof: string; contact?: string; email?: string; images?: File[] }
): Promise<LostFoundClaim> {
  const formData = new FormData();
  formData.append("proof", params.proof);
  if (params.contact) formData.append("claimant_contact", params.contact);
  if (params.email) formData.append("claimant_email", params.email);
  for (const image of await compressImages(params.images ?? [])) formData.append("images[]", image);

  try {
    const res = await fetch(`/api/lost-found/${itemId}/claim`, {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw classifyError(
        new ApiError(res.status, res.statusText, body),
        "Unable to submit this claim."
      );
    }
    return mapClaim((body as ApiResponseEnvelope<RawClaim>).data);
  } catch (err) {
    if (err instanceof LostFoundOperationError) throw err;
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

// ─── Service: admin claim review (PATCH /admin/lost-items/{id}/claims/{cid}/...) ─

/**
 * Fetch all claims for an item (admin view — shows claimant info).
 * @throws {LostFoundOperationError} 404/401/403/5xx
 */
export async function claimsForItem(itemId: string): Promise<LostFoundClaim[]> {
  try {
    const response = await api.get<ApiResponseEnvelope<RawClaim[]>>(
      `/api/admin/lost-items/${itemId}/claims`
    );
    return (response.data ?? []).map(mapClaim);
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to load claims for this item.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

export async function recordManualClaim(
  itemId: string,
  input: { name: string; contact?: string; email?: string; proof: string },
): Promise<LostFoundClaim> {
  try {
    const response = await api.post<ApiResponseEnvelope<RawClaim>>(
      `/api/admin/lost-items/${itemId}/claims/manual`,
      {
        claimant_name: input.name,
        claimant_contact: input.contact || null,
        claimant_email: input.email || null,
        proof: input.proof,
      },
    );
    return mapClaim(response.data);
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to record this walk-in claimant.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service.",
    );
  }
}

/**
 * Approve a pending claim. Flips the item → APPROVED (ready for release).
 * @throws {LostFoundOperationError} 404/422 (claim not PENDING)/401/403/5xx
 */
/** Where/when the approved claimant collects the item. `pickupAt` is local "YYYY-MM-DDTHH:mm". */
export interface PickupSchedule {
  location: string;
  pickupAt: string;
  reminder?: string;
}

export async function approveClaim(itemId: string, claimId: string, pickup?: PickupSchedule): Promise<LostFoundClaim> {
  try {
    const response = await api.patch<ApiResponseEnvelope<RawClaim>>(
      `/api/admin/lost-items/${itemId}/claims/${claimId}/approve`,
      pickup
        ? { pickup_location: pickup.location, pickup_at: pickup.pickupAt, pickup_reminder: pickup.reminder || null }
        : {}
    );
    return mapClaim(response.data);
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to approve this claim.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * Release an approved claim — records the handover (released_to + released_at).
 * Flips the item → RELEASED.
 * @throws {LostFoundOperationError} 404/422 (claim not APPROVED)/401/403/5xx
 */
export async function releaseClaim(itemId: string, claimId: string): Promise<LostFoundClaim> {
  try {
    const response = await api.patch<ApiResponseEnvelope<RawClaim>>(
      `/api/admin/lost-items/${itemId}/claims/${claimId}/release`
    );
    return mapClaim(response.data);
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to release this claim.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * Reject a pending or approved claim. Records an optional rejection_reason.
 * @throws {LostFoundOperationError} 404/422/401/403/5xx
 */
export async function rejectClaim(
  itemId: string,
  claimId: string,
  rejectionReason?: string
): Promise<LostFoundClaim> {
  try {
    const response = await api.patch<ApiResponseEnvelope<RawClaim>>(
      `/api/admin/lost-items/${itemId}/claims/${claimId}/reject`,
      {
        ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
      }
    );
    return mapClaim(response.data);
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to reject this claim.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}

/**
 * Close a released item (admin finalizes after handover).
 * Flips the item → CLOSED.
 * @throws {LostFoundOperationError} 404/422 (item not RELEASED)/401/403/5xx
 */
export async function close(itemId: string): Promise<LostFoundItem> {
  try {
    const response = await api.patch<ApiResponseEnvelope<RawLostItem>>(
      `/api/admin/lost-items/${itemId}/close`
    );
    return mapItem(response.data);
  } catch (err) {
    if (err instanceof ApiError) {
      throw classifyError(err, "Unable to close this item.");
    }
    throw new LostFoundOperationError(
      "network",
      err instanceof Error ? err.message : "Unable to reach the backend service."
    );
  }
}
