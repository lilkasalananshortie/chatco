// frontend/app/(admin)/users/data/users-data.ts
//
// Admin User Management data hook.
//
// ACTIVE USERS: fetched from GET /api/admin/users (real API)
// PENDING: fetched from GET /api/admin/registrations (real API)
// REJECTED: empty (rejected accounts are soft-deleted — not listed)
//
// No mock data anywhere.

import { useState, useEffect, useCallback, useRef } from "react";
import {
  list as listUsers,
  update as updateUser,
  remove as deleteUser,
  suspend as suspendUser,
  unsuspend as unsuspendUser,
  type AdminUser,
  type UserListFilters,
  type PaginationMeta,
  type UpdateUserInput,
  type UserOperationError,
  type SuspendUserInput,
  type SuspensionDetails,
} from "@/lib/admin/services/user.service";
import * as registrationService from "@/lib/admin/services/registration.service";

// ─── Re-exported types ───────────────────────────────────────────────

export type { AdminUser, PaginationMeta, UserListFilters, UpdateUserInput };
export type PendingRequest = registrationService.PendingRegistration;
export type PendingSort = NonNullable<registrationService.RegistrationListFilters["sort"]>;
export type RejectedRequest = registrationService.RejectedRegistration;

/**
 * Frontend-only role union. Adds "DRIVER" on top of the backend UserRole
 * (ADMIN | CONDUCTOR | COMMUTER) so the User Management table can show
 * drivers in the same view. Drivers live in a separate `drivers` table
 * (not users) — when the role filter is "DRIVER", the hook fetches from
 * /api/admin/drivers instead of /api/admin/users.
 */
export type TableRowRole = "ADMIN" | "CONDUCTOR" | "COMMUTER" | "DRIVER";

export interface ActiveUser {
  id: string;
  name: string;
  email: string;
  phoneNumber: string;
  /** "Disabled" is conductors only (Disable Account); others are suspended. */
  status: "Active" | "Suspended" | "Disabled";
  commuterType: string;
  languagePreference: string;
  idImageUrl: string;
  /** Public R2 profile photo (any role, drivers included); null shows the default icon. */
  profileImageUrl: string | null;
  /** Self-chosen login username — commuters only. Null for other roles. */
  username: string | null;
  /** ISO timestamp the commuter's account was verified/approved. Null otherwise. */
  verifiedAt: string | null;
  /** Frontend-only role label — includes "DRIVER" for driver rows. */
  role: TableRowRole;
  /**
   * Optional raw backend user. Absent for DRIVER rows (drivers aren't
   * users — they come from /api/admin/drivers, not /api/admin/users).
   */
  _raw?: AdminUser;
  suspension: SuspensionDetails | null;
  createdAt: string | null;
}

export interface RejectedUser {
  id: string;
  name: string;
  email: string;
  phoneNumber: string;
  commuterType: "Regular" | "Student" | "Senior Citizen" | "PWD";
  languagePreference: "English" | "Filipino";
  idImageUrl: string;
  status: "Rejected";
  rejectionReason: string;
  createdAt: string | null;
}

export interface HistoryLog {
  id: string;
  date: string;
  action: string;
  details: string;
}

// ─── Hook ───────────────────────────────────────────────────────────

/**
 * Local filter shape. Extends the backend UserListFilters with the
 * frontend-only "DRIVER" role value (drivers live in a separate table).
 */
export interface UsersTabFilters {
  role: TableRowRole | "";
  search: string;
  perPage: number;
  page: number;
  sort: "recent" | "oldest" | "alphabetical";
  accountStatus: "" | "ACTIVE" | "SUSPENDED";
  /** Only applies while role is COMMUTER; cleared when the role changes. */
  commuterType: NonNullable<UserListFilters["commuterType"]>;
}

export interface UseUsersDataReturn {
  activeUsers: ActiveUser[];
  pendingRequests: PendingRequest[];
  rejectedUsers: RejectedRequest[];
  historyLogs: Record<string, HistoryLog[]>;
  /** Fetches a user's activity timeline. Cached in historyLogs. */
  fetchUserActivity: (userId: string) => Promise<HistoryLog[]>;
  pagination: PaginationMeta | null;
  pendingPagination: registrationService.RegistrationPagination | null;
  rejectedPagination: registrationService.RegistrationPagination | null;
  pendingTotal: number;
  rejectedTotal: number;
  isLoading: boolean;
  isTableLoading: boolean;
  error: string | null;
  filters: UsersTabFilters;
  setFilters: (f: Partial<UsersTabFilters>) => void;
  pendingType: registrationService.AppliedType | "";
  setPendingType: (type: registrationService.AppliedType | "") => void;
  /** Rejected tab: applied commuter type filter ("" = all). */
  rejectedType: registrationService.AppliedType | "";
  setRejectedType: (type: registrationService.AppliedType | "") => void;
  pendingSort: PendingSort;
  setPendingSort: (sort: PendingSort) => void;
  setPendingPage: (page: number) => void;
  setRejectedPage: (page: number) => void;
  refetch: () => void;
  updateUserApi: (id: string, data: UpdateUserInput) => Promise<void>;
  deleteUserApi: (id: string) => Promise<void>;
  approveRegistrationApi: (id: string) => Promise<string>;
  rejectRegistrationApi: (id: string, reason: string) => Promise<string>;
  suspendUserApi: (id: string, input: SuspendUserInput) => Promise<void>;
  unsuspendUserApi: (id: string) => Promise<void>;
}

function mapToActiveUser(u: AdminUser): ActiveUser {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phoneNumber: u.contactNumber ?? "—",
    status: u.statusLabel === "Suspended" || u.statusLabel === "Disabled" ? u.statusLabel : "Active",
    commuterType: u.commuterTypeLabel,
    languagePreference: "English",
    idImageUrl: u.idImageUrl ?? "",
    profileImageUrl: u.profileImageUrl,
    username: u.username,
    verifiedAt: u.verifiedAt,
    role: u.role,
    _raw: u,
    suspension: u.suspension,
    createdAt: u.createdAt,
  };
}

/**
 * Raw driver shape from GET /api/admin/drivers (Laravel Driver model).
 * Drivers are NOT users — they have their own table with license/contact
 * fields. We map them into ActiveUser so the same table component can
 * render them alongside conductors/commuters/admins.
 */
interface RawDriver {
  id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  contact: string | null;
  license_number: string | null;
  profile_picture_url: string | null;
  status: string | null;
  created_at: string | null;
}

function mapDriverToActiveUser(d: RawDriver): ActiveUser {
  const fullName = [d.first_name, d.middle_name, d.last_name]
    .filter(Boolean)
    .join(" ");
  return {
    id: d.id,
    name: fullName || "Unknown Driver",
    email: "—",
    phoneNumber: d.contact ?? "—",
    status: d.status === "ACTIVE" ? "Active" : "Suspended",
    // Drivers don't have a commuter type — show license number instead so
    // the table column is still useful for driver rows.
    commuterType: d.license_number ?? "—",
    languagePreference: "English",
    idImageUrl: "",
    profileImageUrl: d.profile_picture_url?.trim() || null,
    username: null,
    verifiedAt: null,
    role: "DRIVER",
    suspension: null,
    createdAt: d.created_at,
  };
}

export function useUsersData(activeTab: "active" | "pending" | "rejected" | "discounts" = "active"): UseUsersDataReturn {
  const [activeUsers, setActiveUsers] = useState<ActiveUser[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
  const [rejectedUsers, setRejectedUsers] = useState<RejectedRequest[]>([]);
  const [historyLogs, setHistoryLogs] = useState<Record<string, HistoryLog[]>>({});
  const [pagination, setPagination] = useState<PaginationMeta | null>(null);
  const [pendingPagination, setPendingPagination] = useState<registrationService.RegistrationPagination | null>(null);
  const [rejectedPagination, setRejectedPagination] = useState<registrationService.RegistrationPagination | null>(null);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [rejectedTotal, setRejectedTotal] = useState(0);
  const [pendingPage, setPendingPageState] = useState(1);
  const [rejectedPage, setRejectedPageState] = useState(1);
  const [pendingType, setPendingTypeState] = useState<registrationService.AppliedType | "">("");
  const [rejectedType, setRejectedTypeState] = useState<registrationService.AppliedType | "">("");
  const [pendingSort, setPendingSortState] = useState<PendingSort>("oldest");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  // Local filter type extends the backend UserListFilters with the
  // frontend-only "DRIVER" value. When role === "DRIVER" the hook fetches
  // from /api/admin/drivers instead of /api/admin/users (drivers aren't
  // users — they're a separate table).
  const [filters, setFiltersState] = useState<UsersTabFilters>({
    role: "COMMUTER",
    search: "",
    perPage: 20,
    page: 1,
    sort: "recent",
    accountStatus: "",
    commuterType: "",
  });

  /**
   * Fetch the active list. When filters.role === "DRIVER", hit the drivers
   * endpoint and map results to ActiveUser. Otherwise hit the users endpoint
   * as before.
   *
   * GET /admin/drivers is paginated/filtered/sorted server-side whenever a
   * `page` param is sent (which this branch always does) — search/status/
   * sort/page all forward straight to the backend instead of fetching the
   * whole drivers table and slicing it in the browser. Every OTHER caller of
   * that endpoint (Fleet Management, Lost & Found pickers, etc.) never sends
   * `page`, so it keeps getting the full unpaginated list unchanged.
   */
  const fetchUsers = useCallback(
    async (f: UsersTabFilters) => {
      const sequence = ++requestSequence.current;
      setIsLoading(true);
      setError(null);
      try {
        if (f.role === "DRIVER") {
          const params = new URLSearchParams();
          params.set("page", String(f.page || 1));
          params.set("per_page", String(f.perPage || 20));
          if (f.search.trim()) params.set("search", f.search.trim());
          if (f.accountStatus) params.set("status", f.accountStatus);
          if (f.sort) params.set("sort", f.sort);

          const res = await fetch(`/api/admin/drivers?${params.toString()}`, {
            headers: { Accept: "application/json" },
            credentials: "include",
          });
          if (!res.ok) {
            const msg = await res.json().catch(() => null);
            throw new Error(msg?.message ?? `Failed to load drivers (${res.status}).`);
          }
          const json = await res.json();
          const paginator = (json.data ?? {}) as {
            data?: RawDriver[];
            current_page?: number;
            per_page?: number;
            total?: number;
            last_page?: number;
            from?: number | null;
            to?: number | null;
          };
          const drivers: RawDriver[] = Array.isArray(paginator.data) ? paginator.data : [];
          const mapped = drivers.map(mapDriverToActiveUser);
          if (sequence !== requestSequence.current) return;
          setActiveUsers(mapped);
          setPagination({
            currentPage: paginator.current_page ?? (f.page || 1),
            perPage: paginator.per_page ?? (f.perPage || 20),
            total: paginator.total ?? mapped.length,
            lastPage: paginator.last_page ?? 1,
            from: paginator.from ?? null,
            to: paginator.to ?? null,
          });
          return;
        }

        // Normal user fetch — pass role through to the backend (DRIVER
        // never reaches here).
        const result = await listUsers({
          role: f.role === "" ? "" : (f.role as Exclude<UserListFilters["role"], undefined>),
          search: f.search,
          perPage: f.perPage,
          page: f.page,
          sort: f.sort,
          accountStatus: f.accountStatus,
          commuterType: f.role === "COMMUTER" ? f.commuterType : "",
        });
        if (sequence !== requestSequence.current) return;
        setActiveUsers(result.users.map(mapToActiveUser));
        setPagination(result.pagination);
      } catch (err) {
        if (sequence !== requestSequence.current) return;
        setError(err instanceof Error ? err.message : "Failed to load users.");
        setActiveUsers([]);
        setPagination(null);
      } finally {
        if (sequence === requestSequence.current) setIsLoading(false);
      }
    },
    []
  );

  const fetchPending = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await registrationService.listPending({
        search: filters.search,
        appliedType: pendingType,
        sort: pendingSort,
        page: pendingPage,
        perPage: filters.perPage,
      });
      if (sequence !== requestSequence.current) return;
      setPendingRequests(result.registrations);
      setPendingPagination(result.pagination);
    } catch (err) {
      if (sequence !== requestSequence.current) return;
      setPendingRequests([]);
      setPendingPagination(null);
      setError(err instanceof Error ? err.message : "Failed to load pending registrations.");
    } finally {
      if (sequence === requestSequence.current) setIsLoading(false);
    }
  }, [filters.search, filters.perPage, pendingPage, pendingType, pendingSort]);

  // ── Fetch rejected registrations (soft-deleted REJECTED commuters) ──
  // Rejected accounts are soft-deleted with their email rewritten to
  // 'rejected+{timestamp}@chatco.local'. The backend's listRejectedRegistrations
  // uses withTrashed() to include them. Powers the Rejected tab.
  const fetchRejected = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await registrationService.listRejected({
        search: filters.search,
        page: rejectedPage,
        perPage: filters.perPage,
        appliedType: rejectedType,
      });
      if (sequence !== requestSequence.current) return;
      // Store the full page response as-is — the Rejected tab's table and
      // its double-click details modal both read straight from this array,
      // so no extra fetch is needed when a row is opened.
      setRejectedUsers(result.registrations);
      setRejectedPagination(result.pagination);
    } catch (err) {
      if (sequence !== requestSequence.current) return;
      setRejectedUsers([]);
      setRejectedPagination(null);
      setError(err instanceof Error ? err.message : "Failed to load rejected registrations.");
    } finally {
      if (sequence === requestSequence.current) setIsLoading(false);
    }
  }, [filters.search, filters.perPage, rejectedPage, rejectedType]);

  /**
   * Load registration totals independently of the selected tab. Inactive
   * tabs do not have pagination data yet, which previously left their
   * labels showing "(...)" until the user opened each tab.
   *
   * `includeRejected` defaults to true (unchanged behavior everywhere except
   * approveRegistrationApi below). Approving a registration can never change
   * the rejected count, so re-fetching it there was a guaranteed-redundant
   * request — always returning the same total already in state.
   */
  const refreshRegistrationTotals = useCallback(async (includeRejected: boolean = true) => {
    const [pendingResult, rejectedResult] = await Promise.allSettled([
      registrationService.listPending({ page: 1, perPage: 1 }),
      includeRejected ? registrationService.listRejected({ page: 1, perPage: 1 }) : Promise.resolve(null),
    ]);

    if (pendingResult.status === "fulfilled") {
      setPendingTotal(pendingResult.value.pagination.total);
    }
    if (includeRejected && rejectedResult.status === "fulfilled" && rejectedResult.value) {
      setRejectedTotal(rejectedResult.value.pagination.total);
    }
  }, []);

  useEffect(() => {
    void refreshRegistrationTotals();
  }, [refreshRegistrationTotals]);

  // ── Fetch a user's activity timeline ──
  // Calls GET /api/admin/users/{id}/activity which reuses existing data
  // (transactions, shift_logs, verification dates) to build a chronological
  // timeline. Cached in historyLogs so repeat opens don't re-fetch.
  const fetchUserActivity = useCallback(async (userId: string): Promise<HistoryLog[]> => {
    try {
      const res = await fetch(`/api/admin/users/${userId}/activity`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];
      const json = await res.json();
      const events = (json.data ?? []) as Array<{
        id: string;
        timestamp: string;
        action: string;
        details: string;
      }>;
      const logs: HistoryLog[] = events.map(e => ({
        id: e.id,
        date: e.timestamp ? new Date(e.timestamp).toLocaleString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: true,
        }) : '—',
        action: e.action,
        details: e.details,
      }));
      setHistoryLogs(prev => ({ ...prev, [userId]: logs }));
      return logs;
    } catch {
      return [];
    }
  }, []);

  const refetch = useCallback(() => {
    if (activeTab === "active") void fetchUsers(filters);
    if (activeTab === "pending") void fetchPending();
    if (activeTab === "rejected") void fetchRejected();
  }, [activeTab, fetchUsers, fetchPending, fetchRejected, filters]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const setFilters = useCallback(
    (f: Partial<UsersTabFilters>) => {
      if (f.search !== undefined || f.perPage !== undefined) {
        setPendingPageState(1);
        setRejectedPageState(1);
      }
      setFiltersState((prev) => {
        const roleChanged = f.role !== undefined && f.role !== prev.role;
        const searchChanged = f.search !== undefined && f.search !== prev.search;
        const sortChanged = f.sort !== undefined && f.sort !== prev.sort;
        const statusChanged = f.accountStatus !== undefined && f.accountStatus !== prev.accountStatus;
        const typeChanged = f.commuterType !== undefined && f.commuterType !== prev.commuterType;
        const pageSizeChanged = f.perPage !== undefined && f.perPage !== prev.perPage;
        const next = { ...prev, ...f };
        if (roleChanged && next.role !== "COMMUTER") next.commuterType = "";
        if (roleChanged || searchChanged || sortChanged || statusChanged || typeChanged || pageSizeChanged) next.page = 1;
        return next;
      });
    },
    []
  );

  const updateUserApi = useCallback(
    async (id: string, data: UpdateUserInput) => {
      await updateUser(id, data);
      await fetchUsers(filters);
    },
    [fetchUsers, filters]
  );

  const deleteUserApi = useCallback(
    async (id: string) => {
      await deleteUser(id);
      if (pagination && pagination.currentPage > 1 && activeUsers.length === 1) {
        setFiltersState((prev) => ({ ...prev, page: prev.page! - 1 }));
      } else {
        await fetchUsers(filters);
      }
    },
    [fetchUsers, filters, pagination, activeUsers.length]
  );

  // ── Registration review (returns a success message for the UI) ──

  const approveRegistrationApi = useCallback(
    async (id: string): Promise<string> => {
      const result = await registrationService.approve(id);
      // Approving can't change the rejected count — skip refetching it.
      await Promise.all([fetchPending(), refreshRegistrationTotals(false)]);
      return `Approved ${result.name} — commuter type: ${result.commuter_type}. They can now log in.`;
    },
    [fetchPending, refreshRegistrationTotals]
  );

  const rejectRegistrationApi = useCallback(
    async (id: string, reason: string): Promise<string> => {
      await registrationService.reject(id, reason);
      await Promise.all([fetchPending(), refreshRegistrationTotals()]);
      return `Registration rejected. Reason: "${reason}". The email is now available for re-registration.`;
    },
    [fetchPending, refreshRegistrationTotals]
  );

  const suspendUserApi = useCallback(async (id: string, input: SuspendUserInput) => {
    await suspendUser(id, input);
    await fetchUsers(filters);
  }, [fetchUsers, filters]);

  const unsuspendUserApi = useCallback(async (id: string) => {
    await unsuspendUser(id);
    await fetchUsers(filters);
  }, [fetchUsers, filters]);

  const setPendingType = useCallback((type: registrationService.AppliedType | "") => {
    setPendingTypeState(type);
    setPendingPageState(1);
  }, []);

  const setRejectedType = useCallback((type: registrationService.AppliedType | "") => {
    setRejectedTypeState(type);
    setRejectedPageState(1);
  }, []);

  const setPendingSort = useCallback((sort: PendingSort) => {
    setPendingSortState(sort);
    setPendingPageState(1);
  }, []);

  const setPendingPage = useCallback((page: number) => setPendingPageState(Math.max(1, page)), []);
  const setRejectedPage = useCallback((page: number) => setRejectedPageState(Math.max(1, page)), []);

  return {
    activeUsers,
    pendingRequests,
    rejectedUsers,
    historyLogs,
    fetchUserActivity,
    pagination,
    pendingPagination,
    rejectedPagination,
    pendingTotal,
    rejectedTotal,
    isLoading,
    isTableLoading: isLoading,
    error,
    filters,
    setFilters,
    pendingType,
    setPendingType,
    rejectedType,
    setRejectedType,
    pendingSort,
    setPendingSort,
    setPendingPage,
    setRejectedPage,
    refetch,
    updateUserApi,
    deleteUserApi,
    approveRegistrationApi,
    rejectRegistrationApi,
    suspendUserApi,
    unsuspendUserApi,
  };
}

export type { UserOperationError };
