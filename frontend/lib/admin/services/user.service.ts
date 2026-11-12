/**
 * Admin user-management service (S5-T10).
 *
 * Calls Next.js proxy routes (which forward to Laravel with the httpOnly
 * `chatco_session` cookie) — never calls Laravel directly from the browser.
 * This keeps the Sanctum bearer token server-side only and avoids CORS.
 *
 *   GET    /api/admin/users              → list(filters)
 *   GET    /api/admin/users/{id}         → get(id)
 *   PUT    /api/admin/users/{id}         → update(id, data)
 *   DELETE /api/admin/users/{id}         → remove(id)
 *
 * Responsibilities:
 *   - Map snake_case Laravel envelopes → camelCase view-models the UI uses
 *   - Translate backend 422 validation errors into typed exceptions the
 *     UI can branch on (field-level errors for the edit modal)
 *   - Keep the page component free of API/transport concerns
 *
 * Mirrors the pattern established by lib/commuter/services/profile.service.ts
 * (S5-T9) and the admin vehicles proxy routes (S5-T4 frontend).
 */

// ─── Raw backend shapes ─────────────────────────────────────────────

/** Shape of a single user from AdminService::present(). */
interface RawUser {
  id: string;
  email: string;
  role: string;
  name: string;
  /** Public R2 URL of the user's own profile photo. Null when none uploaded. */
  profile_image_url: string | null;
  first_name: string | null;
  middle_name: string | null;
  suffix: string | null;
  last_name: string | null;
  account_status: string | null;
  student_renewal_required: boolean;
  commuter_type: string | null;
  applied_type: string | null;
  username: string | null;
  contact_number: string | null;
  /** Commuter's date of birth (YYYY-MM-DD). Null for non-commuter roles. */
  birthdate: string | null;
  gender: string | null;
  id_image_url: string | null;
  verified_at: string | null;
  created_at: string | null;
  suspension: RawSuspension | null;
}

interface RawSuspension {
  id: string;
  reason_code: string;
  reason: string;
  starts_at: string;
  ends_at: string | null;
  is_permanent: boolean;
  lifted_at: string | null;
}

export interface SuspensionDetails {
  id: string;
  reasonCode: string;
  reason: string;
  startsAt: string;
  endsAt: string | null;
  isPermanent: boolean;
  liftedAt: string | null;
}

/**
 * Laravel LengthAwarePaginator shape (the relevant fields).
 * The full paginator also has `links`, `path`, `from`, `to` etc. —
 * we only destructure what the UI needs.
 */
interface Paginator<T> {
  data: T[];
  current_page: number;
  per_page: number;
  total: number;
  last_page: number;
  from: number | null;
  to: number | null;
}

// ─── Frontend view-model ────────────────────────────────────────────

export type UserRole = "ADMIN" | "CONDUCTOR" | "COMMUTER";
export type AccountStatus = "ACTIVE" | "SUSPENDED" | "DISABLED" | "APPROVED" | "PENDING" | "REJECTED";
export type CommuterType = "REGULAR" | "STUDENT" | "SENIOR" | "PWD";

/**
 * A user row in the admin management table.
 *
 * `id` is a UUID string (the backend uses UUID PKs). `status` is the
 * UI-friendly mapping of `account_status`:
 *   ACTIVE / APPROVED → "Active"
 *   SUSPENDED          → "Suspended"
 *   DISABLED           → "Disabled" (conductors — Disable Account)
 *   PENDING / REJECTED → passthrough (for the pending/rejected tabs)
 */
export interface AdminUser {
  id: string;
  email: string;
  role: UserRole;
  name: string;
  /** Public R2 URL of the user's profile photo; null falls back to the default icon. */
  profileImageUrl: string | null;
  firstName: string | null;
  middleName: string | null;
  suffix: string | null;
  lastName: string | null;
  /** Raw backend status — kept for the service layer to branch on. */
  accountStatus: AccountStatus | null;
  /** UI-friendly label for the table badge. */
  statusLabel: string;
  studentRenewalRequired: boolean;
  commuterType: CommuterType | null;
  /** UI-friendly commuter type label (e.g. "Senior Citizen" for SENIOR). */
  commuterTypeLabel: string;
  appliedTypeLabel: string | null;
  /** Commuter's self-chosen login username. Null for non-commuter roles. */
  username: string | null;
  contactNumber: string | null;
  /** Commuter's date of birth (YYYY-MM-DD). Null for non-commuter roles. */
  dateOfBirth: string | null;
  gender: string | null;
  idImageUrl: string | null;
  verifiedAt: string | null;
  createdAt: string | null;
  suspension: SuspensionDetails | null;
}

/** Pagination metadata returned by the list endpoint. */
export interface PaginationMeta {
  currentPage: number;
  perPage: number;
  total: number;
  lastPage: number;
  from: number | null;
  to: number | null;
}

/** Result of a list() call — the page + pagination metadata. */
export interface UserListResult {
  users: AdminUser[];
  pagination: PaginationMeta;
}

// ─── Filter input ───────────────────────────────────────────────────

export interface UserListFilters {
  role?: UserRole | "";
  search?: string;
  perPage?: number;
  page?: number;
  sort?: "recent" | "oldest" | "alphabetical";
  accountStatus?: "" | "ACTIVE" | "SUSPENDED";
  commuterType?: CommuterType | "";
}

// ─── Update input ───────────────────────────────────────────────────

/**
 * Fields the admin edit modal can send. All optional — the backend
 * UpdateUserRequest uses `sometimes` validation, so only sent fields
 * are updated. At least one field must be present (server-enforced).
 */
export interface UpdateUserInput {
  firstName?: string;
  middleName?: string | null;
  lastName?: string;
  accountStatus?: "ACTIVE" | "SUSPENDED";
  contactNumber?: string;
  /** Commuter's date of birth (YYYY-MM-DD). Commuter-only. */
  dateOfBirth?: string;
}

// ─── Typed errors ───────────────────────────────────────────────────

/**
 * Thrown by update() / remove() on any non-success response.
 * Carries a stable `code` + optional `field` + `errors` map so the UI
 * can render field-specific messages next to the right input.
 */
export class UserOperationError extends Error {
  constructor(
    public code:
      | "validation"
      | "not_found"
      | "forbidden"
      | "unauthenticated"
      | "network",
    message: string,
    public field?: string,
    public errors?: Record<string, string[]>
  ) {
    super(message);
    this.name = "UserOperationError";
  }
}

// ─── Mapper ─────────────────────────────────────────────────────────

function mapCommuterTypeLabel(raw: string | null): string {
  if (!raw) return "—";
  switch (raw) {
    case "REGULAR": return "Regular";
    case "STUDENT": return "Student";
    case "SENIOR": return "Senior Citizen";
    case "PWD": return "PWD";
    default: return raw;
  }
}

function mapStatusLabel(raw: string | null): string {
  if (!raw) return "—";
  switch (raw) {
    case "ACTIVE":
    case "APPROVED":
      return "Active";
    case "SUSPENDED":
      return "Suspended";
    case "DISABLED":
      return "Disabled";
    case "PENDING":
      return "Pending";
    case "REJECTED":
      return "Rejected";
    default:
      return raw;
  }
}

function mapUser(raw: RawUser): AdminUser {
  return {
    id: raw.id,
    email: raw.email,
    role: raw.role as UserRole,
    name: raw.name,
    profileImageUrl: raw.profile_image_url?.trim() || null,
    firstName: raw.first_name,
    middleName: raw.middle_name,
    suffix: raw.suffix ?? null,
    lastName: raw.last_name,
    accountStatus: (raw.account_status as AccountStatus | null) ?? null,
    statusLabel: mapStatusLabel(raw.account_status),
    studentRenewalRequired: raw.student_renewal_required ?? false,
    commuterType: (raw.commuter_type as CommuterType | null) ?? null,
    commuterTypeLabel: mapCommuterTypeLabel(raw.commuter_type),
    appliedTypeLabel: raw.applied_type ? mapCommuterTypeLabel(raw.applied_type) : null,
    username: raw.username,
    contactNumber: raw.contact_number,
    dateOfBirth: raw.birthdate,
    gender: raw.gender ?? null,
    idImageUrl: raw.id_image_url ?? null,
    verifiedAt: raw.verified_at,
    createdAt: raw.created_at,
    suspension: raw.suspension ? {
      id: raw.suspension.id,
      reasonCode: raw.suspension.reason_code,
      reason: raw.suspension.reason,
      startsAt: raw.suspension.starts_at,
      endsAt: raw.suspension.ends_at,
      isPermanent: raw.suspension.is_permanent,
      liftedAt: raw.suspension.lifted_at,
    } : null,
  };
}

export interface SuspendUserInput {
  reasonCode: "POLICY_VIOLATION" | "FRAUD_SUSPECTED" | "SAFETY_CONCERN" | "INAPPROPRIATE_PROFILE_PHOTO" | "PAYMENT_ISSUE" | "OTHER";
  reason: string;
  isPermanent: boolean;
  durationDays?: 1 | 3 | 7 | 14 | 30 | 90;
}

// ─── Service functions ──────────────────────────────────────────────

const API_BASE = "/api/admin/users";

function buildQueryString(filters: UserListFilters): string {
  const params = new URLSearchParams();
  if (filters.role) params.set("role", filters.role);
  if (filters.search && filters.search.trim()) {
    params.set("search", filters.search.trim());
  }
  if (filters.perPage) params.set("per_page", String(filters.perPage));
  if (filters.page) params.set("page", String(filters.page));
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.accountStatus) params.set("account_status", filters.accountStatus);
  if (filters.commuterType) params.set("commuter_type", filters.commuterType);
  params.set("active_only", "1");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Fetch a paginated, filterable list of users.
 *
 * @throws {UserOperationError} on 401 (unauthenticated) / 403 (forbidden) /
 *   502 (network). Never throws on empty results — returns `{ users: [],
 *   pagination: {...} }`.
 */
export async function list(filters: UserListFilters = {}): Promise<UserListResult> {
  const qs = buildQueryString(filters);
  const res = await fetch(`${API_BASE}${qs}`, {
    headers: { Accept: "application/json" },
    credentials: "include",
  });

  if (!res.ok) {
    throw translateError(res.status, await safeMessage(res));
  }

  const json = await res.json();
  // The proxy forwards the Laravel paginator as `{ data: { paginator } }`.
  // The paginator itself has a `data` array of users.
  const paginator: Paginator<RawUser> | RawUser[] = json.data;

  // Defensive: the endpoint always returns a paginator, but handle a
  // bare array too (older mock or future shape change).
  if (Array.isArray(paginator)) {
    return {
      users: paginator.map(mapUser),
      pagination: {
        currentPage: 1,
        perPage: filters.perPage ?? paginator.length,
        total: paginator.length,
        lastPage: 1,
        from: paginator.length ? 1 : null,
        to: paginator.length,
      },
    };
  }

  return {
    users: (paginator.data ?? []).map(mapUser),
    pagination: {
      currentPage: paginator.current_page,
      perPage: paginator.per_page,
      total: paginator.total,
      lastPage: paginator.last_page,
      from: paginator.from,
      to: paginator.to,
    },
  };
}

/**
 * Fetch a single user by ID.
 *
 * @throws {UserOperationError} 404 / 401 / 403 / 502
 */
export async function get(id: string): Promise<AdminUser> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
    credentials: "include",
  });

  if (!res.ok) {
    throw translateError(res.status, await safeMessage(res));
  }

  const json = await res.json();
  return mapUser(json.data as RawUser);
}

/**
 * Update a user's editable fields.
 *
 * Maps camelCase frontend input → snake_case backend contract, then PUTs
 * to the proxy. On 422, throws a `UserOperationError` with `code:
 * "validation"` and the `errors` map so the edit modal can render
 * field-specific messages.
 *
 * @returns The updated user (fresh from the server).
 */
export async function update(id: string, input: UpdateUserInput): Promise<AdminUser> {
  const body: Record<string, unknown> = {};
  if (input.firstName !== undefined) body.first_name = input.firstName;
  if (input.middleName !== undefined) body.middle_name = input.middleName;
  if (input.lastName !== undefined) body.last_name = input.lastName;
  if (input.accountStatus !== undefined) body.account_status = input.accountStatus;
  if (input.contactNumber !== undefined) body.contact_number = input.contactNumber;
  if (input.dateOfBirth !== undefined) body.birthdate = input.dateOfBirth;

  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    credentials: "include",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const message = await safeMessage(res);
    if (res.status === 422) {
      const errorBody = await safeJson(res);
      const errors: Record<string, string[]> | undefined = errorBody?.errors ?? undefined;
      // The API's 422 message is a generic "Validation failed"; the field
      // message (e.g. "That contact number is already in use.") is what the
      // edit modal and page banner should show.
      const firstFieldError = errors ? Object.values(errors)[0]?.[0] : undefined;
      throw new UserOperationError(
        "validation",
        firstFieldError ?? message,
        errors ? Object.keys(errors)[0] : undefined,
        errors
      );
    }
    throw translateError(res.status, message);
  }

  const json = await res.json();
  return mapUser(json.data as RawUser);
}

/**
 * Soft-delete a user. They are locked out of auth but their financial
 * history is preserved.
 *
 * @throws {UserOperationError} 404 / 422 (self-delete / last-admin guard) /
 *   401 / 403 / 502. On 422 the `errors` map is populated so the UI can
 *   surface the specific guard message ("You cannot delete your own
 *   account.").
 */
export async function remove(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
    credentials: "include",
  });

  if (!res.ok) throw await operationError(res);
}

export async function suspend(id: string, input: SuspendUserInput): Promise<AdminUser> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}/suspend`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: JSON.stringify({
      reason_code: input.reasonCode,
      reason: input.reason,
      is_permanent: input.isPermanent,
      duration_days: input.isPermanent ? null : input.durationDays,
    }),
  });

  if (!res.ok) throw await operationError(res);
  const json = await res.json();
  return mapUser(json.data as RawUser);
}

export async function unsuspend(id: string): Promise<AdminUser> {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}/unsuspend`, {
    method: "POST",
    headers: { Accept: "application/json" },
    credentials: "include",
  });

  if (!res.ok) throw translateError(res.status, await safeMessage(res));
  const json = await res.json();
  return mapUser(json.data as RawUser);
}

/**
 * Disable a conductor account — the conductor's only block mechanism
 * (conductors are never suspended). Same endpoint as Fleet Management's
 * Disable Account: the backend re-checks the admin's password and refuses
 * while the conductor is on an active shift (409).
 */
export async function disableConductor(id: string, currentPassword: string): Promise<void> {
  const res = await fetch(`/api/admin/conductors/${encodeURIComponent(id)}/disable`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: JSON.stringify({ current_password: currentPassword }),
  });

  if (!res.ok) throw await operationError(res);
}

// ─── Error helpers ──────────────────────────────────────────────────

async function safeMessage(res: Response): Promise<string> {
  try {
    const body = await res.clone().json();
    return body?.message ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

async function safeJson(res: Response): Promise<{ message?: string; errors?: Record<string, string[]> } | null> {
  try {
    return await res.clone().json();
  } catch {
    return null;
  }
}

/**
 * Build the error for a failed delete/suspend/disable. The backend wraps
 * guard failures ("You cannot delete your own account.", "Cannot delete the
 * last administrator account.", the 5-character reason rule, the conductor
 * active-shift conflict) in a 422/409 envelope whose top-level message is
 * generic ("Validation failed", "Conflict"), so the specific text is lifted
 * from the `errors` map where the guard put it.
 */
async function operationError(res: Response): Promise<UserOperationError> {
  const message = await safeMessage(res);
  if (res.status !== 422 && res.status !== 409) return translateError(res.status, message);

  const errors = (await safeJson(res))?.errors ?? undefined;
  const first = errors ? Object.values(errors).flat().find(Boolean) : undefined;
  return new UserOperationError("validation", first ?? message, undefined, errors);
}

function translateError(status: number, message: string): UserOperationError {
  switch (status) {
    case 401:
      return new UserOperationError("unauthenticated", "Your session has expired. Please log in again.");
    case 403:
      return new UserOperationError("forbidden", message || "You do not have permission to perform this action.");
    case 404:
      return new UserOperationError("not_found", message || "User not found.");
    case 502:
      return new UserOperationError("network", "Unable to reach the server. Please try again.");
    default:
      return new UserOperationError("network", message || "An unexpected error occurred.");
  }
}
