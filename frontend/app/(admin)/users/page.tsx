// app/(admin)/users/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { UsersTable } from '@/components/admin/users/users-table';
import { RegistrationRequestsTable } from '@/components/admin/users/registration-requests-table';
import { RejectedAccountsTable } from '@/components/admin/users/rejected-accounts-table';
import { RejectedAccountDetailsModal } from '@/components/admin/users/rejected-account-details-modal';
import { ReviewRequestModal } from '@/components/admin/users/review-request-modal';
import { AddRegistrationModal, type OnsiteStudentDetails } from '@/components/admin/users/add-registration-modal';
import { RegisterAdminModal } from '@/components/admin/users/register-admin-modal';
import { EditUserModal } from '@/components/admin/users/edit-user-modal';
import { DeleteUserModal } from '@/components/admin/users/delete-user-modal';
import { SearchBar } from '@/components/admin/ui/search-bar';
import { Plus, UserCheck, Users, XCircle, AlertCircle, RefreshCw, CheckCircle, ChevronUp, ChevronDown, SlidersHorizontal, UserPlus, ShieldUser } from 'lucide-react';
import { RowActionsMenu } from '@/components/admin/ui/row-actions-menu';
import { useUsersData } from './data/users-data';
import type { ActiveUser, PendingRequest, RejectedUser, RejectedRequest } from './data/users-data';
import type { UpdateUserInput } from '@/lib/admin/services/user.service';
import * as registrationService from '@/lib/admin/services/registration.service';
import { SkeletonTable } from '@/components/admin/ui/skeleton';
import { StickyPageHeader } from '@/components/admin/layout/sticky-page-header';
import { SuspensionModal } from '@/components/admin/users/suspension-modal';
import type { SuspendUserInput } from '@/lib/admin/services/user.service';
import { OperationResultModal } from '@/components/admin/ui/operation-result-modal';
import { PageTabs } from '@/components/admin/ui/page-tabs';
import { DiscountApplicationsPanel } from '@/components/admin/users/discount-applications-panel';
import { useAdminNotifications } from '@/contexts/admin-notifications-context';
import { compressImage, IMAGE_COMPRESSION } from '@/lib/utils/compress-image';

/** How long a success banner stays before clearing itself. */
const SUCCESS_MESSAGE_MS = 3000;

export default function UsersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<'active' | 'pending' | 'rejected' | 'discounts'>('active');
  const { discountApplications } = useAdminNotifications();
  const {
    activeUsers,
    pendingRequests,
    rejectedUsers,
    pagination,
    pendingPagination,
    rejectedPagination,
    pendingTotal,
    rejectedTotal,
    isLoading,
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
  } = useUsersData(activeTab);

  const [searchQuery, setSearchQuery] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  // Every success banner (suspend, reactivate, disable, onsite registration)
  // clears itself after a few seconds. Keyed on the message, so a newer one
  // restarts the timer instead of being cut short by an older timer.
  // Errors stay until dismissed.
  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(null), SUCCESS_MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [successMessage]);
  const [isReviewProcessing, setIsReviewProcessing] = useState(false);
  const [suspensionUser, setSuspensionUser] = useState<ActiveUser | null>(null);
  const [isSuspensionProcessing, setIsSuspensionProcessing] = useState(false);
  const [reviewResult, setReviewResult] = useState<{
    type: 'success' | 'error';
    title: string;
    message: string;
  } | null>(null);

  // Modal States
  const [isRegisterModalOpen, setIsRegisterModalOpen] = useState(false);
  const [isAdminRegisterModalOpen, setIsAdminRegisterModalOpen] = useState(false);
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  const [selectedRequest, setSelectedRequest] = useState<PendingRequest | null>(null);
  const [selectedRejectedRequest, setSelectedRejectedRequest] = useState<RejectedRequest | null>(null);
  const [selectedUser, setSelectedUser] = useState<ActiveUser | RejectedUser | null>(null);
  const [editingUser, setEditingUser] = useState<ActiveUser | null>(null);
  const [deletingUser, setDeletingUser] = useState<ActiveUser | null>(null);

  // Extra filters collapse on phones; search, tabs, and registration stay visible.
  const [isMobileFiltersExpanded, setIsMobileFiltersExpanded] = useState(false);

  useEffect(() => {
    if (searchParams.get('tab') === 'discounts') setActiveTab('discounts');
  }, [searchParams]);

  // ─── Deep-link from the notification bell ──────────────────────
  // A NEW_REGISTRATION notification links here as
  // /users?tab=pending&registrationId={userId}. Switch to the Pending tab
  // and, if a registrationId is present, fetch that one registration by id
  // (it may be far down the oldest-first queue, not on page 1) and open its
  // Review Registration Request modal directly. Runs once on mount — the
  // params are stripped from the URL right after so a refresh/back doesn't
  // reopen the modal.
  useEffect(() => {
    const tab = searchParams.get('tab');
    const registrationId = searchParams.get('registrationId');
    if (tab === 'discounts') { setActiveTab('discounts'); return; }
    if (tab !== 'pending' && !registrationId) return;

    setActiveTab('pending');
    router.replace('/users?tab=pending');
    if (!registrationId) return;

    let cancelled = false;
    void registrationService
      .listPending({ id: registrationId, perPage: 1 })
      .then((result) => {
        if (cancelled) return;
        const match = result.registrations[0];
        if (match) {
          setSelectedRequest(match);
          setIsReviewModalOpen(true);
        }
      })
      .catch(() => {
        // Best-effort — the applicant may have already been approved/rejected
        // by another admin between the notification firing and this click.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately mount-only: reacting to `router`/`searchParams` would re-fire after router.replace() strips the params.
  }, []);

  // ─── Debounced search → API filter ────────────────────────────
  // The SearchBar updates `searchQuery` immediately (for responsive UX),
  // but we debounce the API call by 400ms to avoid spamming the server
  // on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters({ search: searchQuery });
    }, 600);
    return () => clearTimeout(timer);
  }, [searchQuery, setFilters]);

  // ─── Loading State ───
  // ─── Modal Handlers ───
  const handleOpenRegisterModal = () => setIsRegisterModalOpen(true);
  const handleCloseRegisterModal = () => setIsRegisterModalOpen(false);

  const handleOpenReviewModal = (request: PendingRequest) => {
    setSelectedRequest(request);
    setIsReviewModalOpen(true);
  };
  const handleCloseReviewModal = () => {
    setSelectedRequest(null);
    setIsReviewModalOpen(false);
  };

  // Rejected tab: double-clicking a row opens the details modal with the
  // row object it already has in memory — no fetch, since the current
  // page's data already carries everything the modal displays.
  const handleOpenRejectedDetails = (request: RejectedRequest) => {
    setSelectedRejectedRequest(request);
  };
  const handleCloseRejectedDetails = () => {
    setSelectedRejectedRequest(null);
  };

  const handleOpenEditModal = (user: ActiveUser) => {
    setEditingUser(user);
    setActionError(null);
    setIsEditModalOpen(true);
  };
  const handleCloseEditModal = () => {
    setEditingUser(null);
    setIsEditModalOpen(false);
  };

  const handleSaveEditUser = async (data: UpdateUserInput): Promise<void> => {
    if (!editingUser) return;
    setActionError(null);
    try {
      await updateUserApi(editingUser.id, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update user.';
      setActionError(msg);
      throw err; // re-throw so the modal can show the inline error
    }
  };

  const handleOpenDeleteModal = (user: ActiveUser) => {
    setDeletingUser(user);
    setActionError(null);
    setIsDeleteModalOpen(true);
  };
  const handleCloseDeleteModal = () => {
    setDeletingUser(null);
    setIsDeleteModalOpen(false);
  };
  const handleConfirmDelete = async (): Promise<void> => {
    if (!deletingUser) return;
    await deleteUserApi(deletingUser.id);
  };

  // Double-clicking an active user row opens the same details modal as
  // the row's View Details action.
  const handleRowDoubleClick = (user: ActiveUser | RejectedUser): void => {
    setSelectedUser(user);
  };

  // Suspend / Reactivate — toggles account_status via the API.
  const handleDeactivateUser = (user: ActiveUser): void => {
    setActionError(null);
    setSuspensionUser(user);
  };

  const handleSuspendUser = async (input: SuspendUserInput): Promise<void> => {
    if (!suspensionUser) return;
    setActionError(null);
    setIsSuspensionProcessing(true);
    try {
      await suspendUserApi(suspensionUser.id, input);
      setSuspensionUser(null);
      setSuccessMessage('Account suspended and active sessions revoked.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to suspend account.');
    } finally {
      setIsSuspensionProcessing(false);
    }
  };

  const handleUnsuspendUser = async (): Promise<void> => {
    if (!suspensionUser) return;
    setActionError(null);
    setIsSuspensionProcessing(true);
    try {
      await unsuspendUserApi(suspensionUser.id);
      setSuspensionUser(null);
      setSuccessMessage('Account reactivated.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reactivate account.');
    } finally {
      setIsSuspensionProcessing(false);
    }
  };

  // ─── Registration handlers (real API) ───
  // handleSaveRegistration is async — the modal stays open with a spinner
  // until the POST resolves. On success: close + refetch + success banner.
  // On error: throw so the modal shows the message inline (modal stays open).
  const handleSaveRegistration = async (data: {
    firstName: string;
    middleName: string;
    lastName: string;
    birthday: string;
    gender: string;
    username: string;
    email: string;
    phoneNumber: string;
    commuterType: string;
    idImageFile: File | null;
    idImagePreview: string | null;
    studentDetails: OnsiteStudentDetails | null;
  }): Promise<void> => {
    if (!data.idImageFile) {
      throw new Error('Please upload a valid ID image.');
    }

    // Map the modal's UI labels to the backend enum values.
    // Modal: "Regular" / "Student" / "Senior Citizen" / "PWD"
    // Backend: REGULAR / STUDENT / SENIOR / PWD
    const appliedTypeMap: Record<string, string> = {
      'Regular': 'REGULAR',
      'Student': 'STUDENT',
      'Senior Citizen': 'SENIOR',
      'PWD': 'PWD',
    };
    const appliedType = appliedTypeMap[data.commuterType] ?? 'REGULAR';

    // Build multipart form data — the proxy forwards it as multipart to
    // Laravel so $request->file('id_image') works.
    const formData = new FormData();
    formData.append('first_name', data.firstName);
    if (data.middleName.trim()) formData.append('middle_name', data.middleName.trim());
    formData.append('surname', data.lastName);
    formData.append('birthdate', data.birthday);
    formData.append('gender', data.gender);
    formData.append('email', data.email);
    formData.append('contact_number', data.phoneNumber);
    formData.append('username', data.username);
    formData.append('applied_type', appliedType);
    formData.append('id_image', await compressImage(data.idImageFile, IMAGE_COMPRESSION.document));
    // Same school fields student renewal sends.
    if (data.studentDetails) {
      formData.append('school_name', data.studentDetails.schoolName);
      formData.append('education_level', data.studentDetails.educationLevel);
      if (data.studentDetails.educationLevel === 'HIGH_SCHOOL') formData.append('grade_level', data.studentDetails.gradeLevel);
      formData.append('school_year', data.studentDetails.schoolYear);
      if (data.studentDetails.enrollmentTerm) formData.append('enrollment_term', data.studentDetails.enrollmentTerm);
    }

    const res = await fetch('/api/admin/registrations', {
      method: 'POST',
      body: formData, // fetch() sets the multipart Content-Type + boundary automatically
      credentials: 'include',
    });

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      // 422 validation error → surface the first field error.
      // 409 (email taken) → use the backend's message.
      // Other → use the backend's message or a generic HTTP-status fallback.
      if (res.status === 422 && body?.errors) {
        const firstField = Object.keys(body.errors)[0];
        const firstError = firstField ? body.errors[firstField]?.[0] : null;
        throw new Error(firstError ?? body?.message ?? 'Validation failed.');
      }
      throw new Error(body?.message ?? `Failed to create registration (HTTP ${res.status}).`);
    }

    // Success — close the modal, refetch the open tab, show a banner.
    handleCloseRegisterModal();
    refetch();
    if (body?.data?.email_sent === false) {
      // The account exists, but the commuter never received the default
      // password. A code-verified reset also clears the first-time change.
      setActionError(
        `The account for ${data.email} was created, but the email with the default password could not be sent. Ask the commuter to use Forgot password on the sign-in screen.`
      );
      return;
    }
    setSuccessMessage(body?.message ?? 'Onsite registration created. The commuter must set a new password at first sign-in.');
  };

  const handleApproveRequest = async () => {
    if (!selectedRequest || isReviewProcessing) return;
    setActionError(null);
    setSuccessMessage(null);
    setIsReviewProcessing(true);
    try {
      const msg = await approveRegistrationApi(selectedRequest.id);
      handleCloseReviewModal();
      setReviewResult({
        type: 'success',
        title: 'Registration approved',
        message: msg,
      });
    } catch (err) {
      setReviewResult({
        type: 'error',
        title: 'Approval failed',
        message: err instanceof Error ? err.message : 'Failed to approve registration.',
      });
    } finally {
      setIsReviewProcessing(false);
    }
  };

  const handleRejectRequest = async (reason: string) => {
    if (!selectedRequest || isReviewProcessing) return;
    setActionError(null);
    setSuccessMessage(null);
    setIsReviewProcessing(true);
    try {
      const msg = await rejectRegistrationApi(selectedRequest.id, reason);
      handleCloseReviewModal();
      setReviewResult({
        type: 'success',
        title: 'Registration rejected',
        message: msg,
      });
    } catch (err) {
      setReviewResult({
        type: 'error',
        title: 'Rejection failed',
        message: err instanceof Error ? err.message : 'Failed to reject registration.',
      });
    } finally {
      setIsReviewProcessing(false);
    }
  };

  // Active tab label reflects the current role filter so the badge reads
  // "Active Conductors" / "Active Drivers" / "Active Admins" / "Active Commuters"
  // instead of always saying "Active Commuters" regardless of the filter.
  const activeRoleLabel =
    filters.role === 'CONDUCTOR' ? 'Conductors' :
    filters.role === 'DRIVER' ? 'Drivers' :
    filters.role === 'ADMIN' ? 'Admins' :
    filters.role === 'COMMUTER' ? 'Commuters' :
    'Users';

  // True once the active tab has data on screen (pagination is only set
  // after a successful fetch). Used to tell a first load — which needs the
  // full card skeleton — apart from a search/filter/page refetch, which
  // should keep the existing table (and its search bar) mounted and just
  // show a small in-place spinner instead of blanking the whole card.
  const hasDataForActiveTab =
    activeTab === 'active' ? pagination !== null :
    activeTab === 'pending' ? pendingPagination !== null :
    rejectedPagination !== null;

  const selectFilterClasses = 'h-11 min-w-0 w-full rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white px-3 text-base text-white admin-light:text-slate-900 focus:outline-none focus:ring-1 focus:ring-[#62A0EA]/30 admin-light:focus:ring-[#1A5FB4]/30 scheme-dark admin-light:scheme-light md:w-auto md:text-sm';

  // One "Register" menu for the account registration flows available here.
  const renderRegisterMenu = (fullWidth: boolean) => (
    <RowActionsMenu
      label="Register an account"
      menuWidth={248}
      trigger={{
        content: (
          <>
            <Plus size={16} aria-hidden="true" />
            <span>Register</span>
            <ChevronDown size={16} aria-hidden="true" />
          </>
        ),
        className: (isOpen) => `${fullWidth ? 'flex w-full' : 'inline-flex'} h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-bold text-white transition-colors hover:bg-[#4A8BD4] admin-light:hover:bg-[#164A8F] [&>svg:last-child]:transition-transform ${isOpen ? 'bg-[#4A8BD4] admin-light:bg-[#164A8F] [&>svg:last-child]:rotate-180' : 'bg-[#62A0EA] admin-light:bg-[#1A5FB4]'}`,
      }}
      actions={[
        { label: 'Register onsite', hint: 'Commuter at the counter, with valid ID', icon: UserPlus, onSelect: handleOpenRegisterModal },
        { label: 'Register admin account', hint: 'Create a new admin account', icon: ShieldUser, onSelect: () => setIsAdminRegisterModalOpen(true) },
      ]}
    />
  );

  // Search stays visible while tab-specific filters collapse on phones.
  const filterBar = (
    <div className="flex w-full flex-col gap-3 lg:flex-row lg:items-center">
      <div className="flex min-w-0 items-center gap-2 lg:w-64 lg:shrink-0">
        <SearchBar placeholder="Search users..." value={searchQuery} onChange={setSearchQuery} className="min-w-0 flex-1 [&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm" />
        <button
          type="button"
          onClick={() => setIsMobileFiltersExpanded((prev) => !prev)}
          aria-expanded={isMobileFiltersExpanded}
          aria-controls="user-management-filters"
          className={`inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors md:hidden ${isMobileFiltersExpanded ? 'border-[#62A0EA] admin-light:border-[#1A5FB4] bg-[#62A0EA] admin-light:bg-[#1A5FB4] text-white' : 'border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white text-slate-300 admin-light:text-slate-700'}`}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          Filters
          <ChevronUp size={14} className={isMobileFiltersExpanded ? '' : 'rotate-180'} aria-hidden="true" />
        </button>
      </div>
      <div
        id="user-management-filters"
        className={`${isMobileFiltersExpanded ? 'block' : 'hidden'} md:block lg:ml-auto`}
      >
        <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center md:gap-3">
          {activeTab === 'active' && (
            <select
              value={filters.role ?? ''}
              onChange={(e) => setFilters({ role: e.target.value as typeof filters.role })}
              aria-label="Filter users by role"
              className={selectFilterClasses}
            >
              <option value="" className="bg-gray-800 admin-light:bg-white">All Roles</option>
              <option value="COMMUTER" className="bg-gray-800 admin-light:bg-white">Commuters</option>
              <option value="CONDUCTOR" className="bg-gray-800 admin-light:bg-white">Conductors</option>
              <option value="DRIVER" className="bg-gray-800 admin-light:bg-white">Drivers</option>
              <option value="ADMIN" className="bg-gray-800 admin-light:bg-white">Admins</option>
            </select>
          )}
          {activeTab === 'active' && filters.role === 'COMMUTER' && (
            <select
              value={filters.commuterType}
              onChange={(e) => setFilters({ commuterType: e.target.value as typeof filters.commuterType })}
              aria-label="Filter commuters by type"
              className={selectFilterClasses}
            >
              <option value="" className="bg-gray-800 admin-light:bg-white">All Types</option>
              <option value="REGULAR" className="bg-gray-800 admin-light:bg-white">Regular</option>
              <option value="STUDENT" className="bg-gray-800 admin-light:bg-white">Student</option>
              <option value="SENIOR" className="bg-gray-800 admin-light:bg-white">Senior Citizen</option>
              <option value="PWD" className="bg-gray-800 admin-light:bg-white">PWD</option>
            </select>
          )}
          {activeTab === 'active' && (
            <>
              <select
                value={filters.accountStatus}
                onChange={(e) => setFilters({ accountStatus: e.target.value as typeof filters.accountStatus })}
                aria-label="Filter by account status"
                className={selectFilterClasses}
              >
                <option value="" className="bg-gray-800 admin-light:bg-white">All Statuses</option>
                <option value="ACTIVE" className="bg-gray-800 admin-light:bg-white">Active</option>
                <option value="SUSPENDED" className="bg-gray-800 admin-light:bg-white">
                  {filters.role === 'CONDUCTOR' ? 'Disabled' : filters.role === '' ? 'Suspended / Disabled' : 'Suspended'}
                </option>
              </select>
              <select
                value={filters.sort}
                onChange={(e) => setFilters({ sort: e.target.value as typeof filters.sort })}
                aria-label="Sort users"
                className={`${selectFilterClasses} col-span-2`}
              >
                <option value="recent" className="bg-gray-800 admin-light:bg-white">Recent</option>
                <option value="alphabetical" className="bg-gray-800 admin-light:bg-white">Alphabetical</option>
                <option value="oldest" className="bg-gray-800 admin-light:bg-white">Oldest</option>
              </select>
            </>
          )}
          {activeTab === 'pending' && (
            <>
              <select
                value={pendingType}
                onChange={(event) => setPendingType(event.target.value as typeof pendingType)}
                aria-label="Filter pending registrations by commuter type"
                className={selectFilterClasses}
              >
                <option value="">All Types</option>
                <option value="REGULAR">Regular</option>
                <option value="STUDENT">Student</option>
                <option value="SENIOR">Senior Citizen</option>
                <option value="PWD">PWD</option>
              </select>
              <select
                value={pendingSort}
                onChange={(event) => setPendingSort(event.target.value as typeof pendingSort)}
                aria-label="Sort pending registrations"
                className={selectFilterClasses}
              >
                <option value="oldest" className="bg-gray-800 admin-light:bg-white">Oldest</option>
                <option value="recent" className="bg-gray-800 admin-light:bg-white">Recent</option>
              </select>
            </>
          )}
          {activeTab === 'rejected' && (
            <select
              value={rejectedType}
              onChange={(event) => setRejectedType(event.target.value as typeof rejectedType)}
              aria-label="Filter rejected accounts by commuter type"
              className={`${selectFilterClasses} col-span-2`}
            >
              <option value="">All Types</option>
              <option value="REGULAR">Regular</option>
              <option value="STUDENT">Student</option>
              <option value="SENIOR">Senior Citizen</option>
              <option value="PWD">PWD</option>
            </select>
          )}
        </div>
      </div>
      {/* Phones: Register spans the filter column so the tab row above stays clean,
          and collapses with the filters. */}
      <div className={`${isMobileFiltersExpanded ? 'block' : 'hidden'} md:hidden`}>{renderRegisterMenu(true)}</div>
    </div>
  );

  return (
    <div className="flex h-full min-h-[32rem] min-w-0 flex-col md:min-h-0">
      <StickyPageHeader className="mb-4 shrink-0">
        <h1 className="text-xl font-bold text-white admin-light:text-slate-900 md:text-2xl">User Management</h1>
      </StickyPageHeader>

      {/* 3 Tabs — shared with Fleet Management */}
      <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#1E2D45] admin-light:border-[#E2E8F0]">
        <div className="min-w-0 basis-full md:flex-1 md:basis-auto">
          <PageTabs
            className="border-b-0! [&>button]:min-h-11 [&>button]:flex-none"
            activeId={activeTab}
            onChange={(id) => { setActiveTab(id); if (id === 'active') setSelectedUser(null); }}
            tabs={[
              { id: 'active', label: `Active ${activeRoleLabel}`, count: pagination?.total ?? activeUsers.length, icon: UserCheck },
              { id: 'pending', label: 'Pending Verification', count: pendingTotal, icon: Users },
              { id: 'rejected', label: 'Rejected', count: rejectedTotal, icon: XCircle },
              { id: 'discounts', label: 'Discount Applications', count: discountApplications.count, icon: RefreshCw },
            ]}
          />
        </div>
        {/* Phones get Register inside each tab's collapsible filters instead
            (filterBar, and the Discount Applications panel's own filters). */}
        <div className="ml-auto hidden shrink-0 -translate-y-1 md:block">
          {renderRegisterMenu(false)}
        </div>
      </div>

      {/* Action error banner */}
      {actionError && (
        <div className="mb-4 shrink-0 bg-red-500/10 border border-red-500/30 rounded-md p-3 flex items-center justify-between">
          <p className="text-sm text-red-400 admin-light:text-red-600">{actionError}</p>
          <button onClick={() => setActionError(null)} className="text-red-400 admin-light:text-red-600 hover:text-red-300 admin-light:hover:text-red-700">
            <XCircle size={16} />
          </button>
        </div>
      )}

      {/* Success banner */}
      {successMessage && (
        <div className="mb-4 shrink-0 bg-[#1A2540] admin-light:bg-[#F8FAFC] border border-[#1E2D45] admin-light:border-[#E2E8F0] rounded-md p-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle size={16} className="text-[#62A0EA] admin-light:text-[#1A5FB4] flex-shrink-0" />
            <p className="text-sm text-slate-200 admin-light:text-slate-700">{successMessage}</p>
          </div>
          <button onClick={() => setSuccessMessage(null)} aria-label="Dismiss message" className="text-slate-400 admin-light:text-slate-500 hover:text-white admin-light:hover:text-slate-900">
            <XCircle size={16} />
          </button>
        </div>
      )}

      {/* Tab Content — fills whatever vertical space is left, on every
          screen size, instead of a fixed height that either clips or
          leaves a gap (same approach as Remittance/Announcements). */}
      <div className="flex flex-1 min-h-0 flex-col">
        {activeTab === 'discounts' ? <DiscountApplicationsPanel initialId={searchParams.get('applicationId') ?? undefined} onReviewed={discountApplications.refresh} registerAction={renderRegisterMenu(true)} /> : isLoading && !hasDataForActiveTab ? (
          // First load of this tab — nothing on screen yet, so the full
          // card skeleton is the right call.
          <div className="h-full min-h-64 overflow-hidden rounded-lg">
            <SkeletonTable rows={10} columns={5} />
          </div>
        ) : error ? (
          <div className="flex h-full min-h-72 flex-col items-center justify-center gap-3 rounded-xl border border-red-400/20 bg-red-400/5 p-8">
            <AlertCircle size={36} className="text-red-400 admin-light:text-red-600" />
            <p className="text-center font-medium text-slate-200 admin-light:text-slate-800">Unable to load this table.</p>
            <p className="max-w-xl text-center text-sm text-slate-500">{error}</p>
            <button onClick={refetch} className="flex items-center gap-2 rounded-md bg-[#62A0EA] admin-light:bg-[#1A5FB4] px-4 py-2 text-sm font-medium text-white">
              <RefreshCw size={16} /> Retry
            </button>
          </div>
        ) : (
          <>
            {activeTab === 'active' && (
              <UsersTable
                users={activeUsers}
                searchQuery=""
                onDeactivate={handleDeactivateUser}
                onPersonnelChanged={refetch}
                onEdit={handleOpenEditModal}
                onDelete={handleOpenDeleteModal}
                onRowDoubleClick={handleRowDoubleClick}
                isRejectedTab={false}
                selectedUser={selectedUser}
                onSelectUser={setSelectedUser}
                headerContent={filterBar}
                pagination={pagination}
                onPageChange={(page) => setFilters({ page })}
                isRefreshing={isLoading}
              />
            )}
            {activeTab === 'pending' && (
              <RegistrationRequestsTable
                requests={pendingRequests}
                onSelectRequest={handleOpenReviewModal}
                pagination={pendingPagination}
                onPageChange={setPendingPage}
                headerContent={filterBar}
                isRefreshing={isLoading}
              />
            )}
            {activeTab === 'rejected' && (
              <RejectedAccountsTable
                requests={rejectedUsers}
                onSelectRequest={handleOpenRejectedDetails}
                headerContent={filterBar}
                pagination={rejectedPagination}
                onPageChange={setRejectedPage}
                isRefreshing={isLoading}
              />
            )}
          </>
        )}
      </div>

      {/* Modals */}
      <AddRegistrationModal isOpen={isRegisterModalOpen} onClose={handleCloseRegisterModal} onSave={handleSaveRegistration} />
      <RegisterAdminModal isOpen={isAdminRegisterModalOpen} onClose={() => setIsAdminRegisterModalOpen(false)} onCreated={() => refetch()} />

      <ReviewRequestModal
        key={selectedRequest?.id ?? 'closed-review'}
        isOpen={isReviewModalOpen}
        onClose={handleCloseReviewModal}
        request={selectedRequest}
        onApprove={handleApproveRequest}
        onReject={handleRejectRequest}
        isProcessing={isReviewProcessing}
      />

      <EditUserModal
        isOpen={isEditModalOpen}
        onClose={handleCloseEditModal}
        onSave={handleSaveEditUser}
        editingUser={editingUser}
      />

      <DeleteUserModal
        isOpen={isDeleteModalOpen}
        onClose={handleCloseDeleteModal}
        onConfirm={handleConfirmDelete}
        user={deletingUser ? { name: deletingUser.name, email: deletingUser.email } : null}
      />

      <RejectedAccountDetailsModal
        isOpen={selectedRejectedRequest !== null}
        onClose={handleCloseRejectedDetails}
        request={selectedRejectedRequest}
      />

      <SuspensionModal
        key={suspensionUser?.id ?? 'closed-suspension'}
        user={suspensionUser}
        isOpen={!!suspensionUser}
        isProcessing={isSuspensionProcessing}
        error={suspensionUser ? actionError : null}
        onClose={() => { setSuspensionUser(null); setActionError(null); }}
        onSuspend={handleSuspendUser}
        onUnsuspend={handleUnsuspendUser}
      />
      <OperationResultModal
        isOpen={reviewResult !== null}
        type={reviewResult?.type ?? 'success'}
        title={reviewResult?.title ?? ''}
        message={reviewResult?.message ?? ''}
        onClose={() => setReviewResult(null)}
      />
    </div>
  );
}
