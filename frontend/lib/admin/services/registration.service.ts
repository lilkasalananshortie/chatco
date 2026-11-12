// lib/admin/services/registration.service.ts
//
// Admin registration review service (S5-T15).
//
// Calls Next.js proxy routes (which forward to Laravel with the httpOnly
// `chatco_session` cookie) — never calls Laravel directly from the browser.
//
//   GET  /api/admin/registrations              → listPending()
//   POST /api/admin/registrations/{id}/approve → approve(id)
//   POST /api/admin/registrations/{id}/reject  → reject(id, reason)

// ─── Types ────────────────────────────────────────────────────────────

export type AppliedType = "REGULAR" | "STUDENT" | "SENIOR" | "PWD";

/** Raw registration row from the backend (Laravel paginator item). */
export interface RawRegistration {
  id: string;
  email: string;
  first_name: string;
  middle_name: string | null;
  surname: string;
  birthdate: string;
  gender: string;
  contact_number: string;
  username: string;
  applied_type: AppliedType;
  id_image_url: string;
  profile_image_url?: string | null;
  account_status: string;
  language_preference: string;
  // How many times this applicant's identity (email/contact) was previously
  // rejected. Present on the pending list; absent (→ 0) on the rejected list.
  rejection_count?: number;
  rejection_history?: Array<{
    reason: string;
    attempt_number: number;
    blocked_until: string | null;
    rejected_at: string;
  }>;
  blocked_until?: string | null;
  created_at: string;
  /** School details a Student gave at sign-up; pending list only, null otherwise. */
  student_details?: RegistrationStudentDetails | null;
}

/** Same field names and values as a discount application's school details. */
export interface RegistrationStudentDetails {
  school_name: string;
  education_level: "HIGH_SCHOOL" | "COLLEGE";
  grade_level: number | null;
  school_year: string;
  enrollment_term: string | null;
}

/** Frontend view-model for the pending registrations table + review modal. */
export interface PendingRegistration {
  id: string;
  name: string;
  firstName: string;
  middleName: string | null;
  surname: string;
  email: string;
  phoneNumber: string;
  commuterType: string;
  languagePreference: string;
  idImageUrl: string;
  /** Public R2 profile photo, if the applicant has one; null shows the default icon. */
  profileImageUrl: string | null;
  status: "Pending Verification";
  birthdate: string;
  gender: string;
  username: string;
  appliedType: AppliedType;
  /** Prior rejections of this applicant's identity (0 = first-time applicant). */
  rejectionCount: number;
  rejectionHistory: Array<{
    reason: string;
    attemptNumber: number;
    blockedUntil: string | null;
    rejectedAt: string;
  }>;
  blockedUntil: string | null;
  createdAt: string;
  /** School details from a Student sign-up; null for other types and older sign-ups. */
  studentDetails: RegistrationStudentDetails | null;
}

export interface RegistrationListFilters {
  search?: string;
  appliedType?: AppliedType | "";
  /** Look up one specific pending registration by its User.id (e.g. from a notification deep-link). */
  id?: string;
  /** Pending list order by submission time; the backend defaults to "oldest" (FIFO). */
  sort?: "recent" | "oldest";
  perPage?: number;
  page?: number;
}

export interface RegistrationPagination {
  currentPage: number;
  perPage: number;
  total: number;
  lastPage: number;
  from: number | null;
  to: number | null;
}

export interface RegistrationListResult<T> {
  registrations: T[];
  pagination: RegistrationPagination;
}

interface Paginator<T> {
  data: T[];
  current_page: number;
  per_page: number;
  total: number;
  last_page: number;
  from: number | null;
  to: number | null;
}

export interface ApproveResult {
  id: string;
  email: string;
  name: string;
  commuter_type: string;
  account_status: string;
  verified_at: string;
}

export interface RejectResult {
  id: string;
  email: string;
  account_status: string;
  rejection_reason: string;
}

export class RegistrationError extends Error {
  errors: Record<string, string[]>;
  status: number;

  constructor(message: string, errors: Record<string, string[]>, status: number) {
    super(message);
    this.name = "RegistrationError";
    this.errors = errors;
    this.status = status;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  REGULAR: "Regular",
  STUDENT: "Student",
  SENIOR: "Senior Citizen",
  PWD: "PWD",
};

function mapToViewModel(r: RawRegistration): PendingRegistration {
  return {
    id: r.id,
    name: `${r.first_name} ${r.middle_name ? r.middle_name + " " : ""}${r.surname}`.trim(),
    firstName: r.first_name,
    middleName: r.middle_name,
    surname: r.surname,
    email: r.email,
    phoneNumber: r.contact_number,
    commuterType: TYPE_LABELS[r.applied_type] ?? "Regular",
    languagePreference: r.language_preference === "Filipino" ? "Filipino" : "English",
    idImageUrl: r.id_image_url,
    profileImageUrl: r.profile_image_url?.trim() || null,
    status: "Pending Verification",
    birthdate: r.birthdate,
    gender: r.gender,
    username: r.username,
    appliedType: r.applied_type,
    studentDetails: r.student_details ?? null,
    rejectionCount: r.rejection_count ?? 0,
    rejectionHistory: (r.rejection_history ?? []).map(item => ({
      reason: item.reason,
      attemptNumber: item.attempt_number,
      blockedUntil: item.blocked_until,
      rejectedAt: item.rejected_at,
    })),
    blockedUntil: r.blocked_until ?? null,
    createdAt: r.created_at,
  };
}

function buildQuery(filters: RegistrationListFilters): string {
  const params = new URLSearchParams();
  if (filters.search?.trim()) params.set("search", filters.search.trim());
  if (filters.appliedType) params.set("applied_type", filters.appliedType);
  if (filters.id) params.set("id", filters.id);
  if (filters.sort) params.set("sort", filters.sort);
  params.set("per_page", String(filters.perPage ?? 10));
  params.set("page", String(filters.page ?? 1));
  return `?${params.toString()}`;
}

function paginationFrom(raw: Partial<Paginator<unknown>> | null, fallbackCount: number): RegistrationPagination {
  return {
    currentPage: raw?.current_page ?? 1,
    perPage: raw?.per_page ?? fallbackCount,
    total: raw?.total ?? fallbackCount,
    lastPage: raw?.last_page ?? 1,
    from: raw?.from ?? (fallbackCount ? 1 : null),
    to: raw?.to ?? fallbackCount,
  };
}

// ─── API methods ──────────────────────────────────────────────────────

/**
 * GET /api/admin/registrations
 * Lists all PENDING commuter registrations awaiting admin review.
 */
export async function listPending(
  filters: RegistrationListFilters = {},
  signal?: AbortSignal,
): Promise<RegistrationListResult<PendingRegistration>> {
  const res = await fetch(`/api/admin/registrations${buildQuery(filters)}`, {
    headers: { Accept: "application/json" },
    credentials: "include",
    signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new RegistrationError(
      body?.message ?? `Failed to fetch registrations (HTTP ${res.status})`,
      {},
      res.status
    );
  }

  const json = await res.json();
  // The backend returns a paginator: { data: { data: [...], ... } }
  const paginator = json.data ?? {};
  const rows = paginator.data ?? (Array.isArray(paginator) ? paginator : []);
  return {
    registrations: (rows as RawRegistration[]).map(mapToViewModel),
    pagination: paginationFrom(paginator, rows.length),
  };
}

/** Frontend view-model for rejected registrations (includes rejection reason). */
export interface RejectedRegistration extends PendingRegistration {
  rejectionReason: string;
  rejectedAt: string;
  /** Name of the admin who rejected this account. Null for legacy rows predating this field. */
  rejectedByName: string | null;
  /** Email of the admin who rejected this account. Null for legacy rows predating this field. */
  rejectedByEmail: string | null;
}

/**
 * GET /api/admin/registrations/rejected
 * Lists all REJECTED commuter accounts (soft-deleted, email rewritten).
 */
export async function listRejected(
  filters: RegistrationListFilters = {},
  signal?: AbortSignal,
): Promise<RegistrationListResult<RejectedRegistration>> {
  const res = await fetch(`/api/admin/registrations/rejected${buildQuery(filters)}`, {
    headers: { Accept: "application/json" },
    credentials: "include",
    signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new RegistrationError(
      body?.message ?? `Failed to fetch rejected registrations (HTTP ${res.status})`,
      {},
      res.status
    );
  }

  const json = await res.json();
  const paginator = json.data ?? {};
  const rows = paginator.data ?? (Array.isArray(paginator) ? paginator : []);
  return {
    registrations: (rows as (RawRegistration & {
      rejection_reason: string;
      rejected_at: string;
      rejected_by_name: string | null;
      rejected_by_email: string | null;
    })[]).map(r => ({
      ...mapToViewModel(r),
      rejectionReason: r.rejection_reason ?? "Not provided",
      rejectedAt: r.rejected_at ?? r.created_at,
      rejectedByName: r.rejected_by_name ?? null,
      rejectedByEmail: r.rejected_by_email ?? null,
    })),
    pagination: paginationFrom(paginator, rows.length),
  };
}

/**
 * POST /api/admin/registrations/{id}/approve
 * Approves a pending registration — copies applied_type to commuter_type,
 * sets verified_at, sets account_status to APPROVED.
 */
export async function approve(id: string): Promise<ApproveResult> {
  const res = await fetch(`/api/admin/registrations/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({}),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new RegistrationError(
      data.message ?? "Failed to approve registration.",
      data.errors ?? {},
      res.status
    );
  }

  return data.data as ApproveResult;
}

/**
 * POST /api/admin/registrations/{id}/reject
 * Rejects a pending registration — sets account_status to REJECTED,
 * records the rejection reason, soft-deletes the account (frees the email).
 */
export async function reject(id: string, reason: string): Promise<RejectResult> {
  const res = await fetch(`/api/admin/registrations/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ rejection_reason: reason }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new RegistrationError(
      data.message ?? "Failed to reject registration.",
      data.errors ?? {},
      res.status
    );
  }

  return data.data as RejectResult;
}
