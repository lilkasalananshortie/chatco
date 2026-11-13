// app/(admin)/announcements/page.tsx
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { Plus, Megaphone, Archive, Edit3, Eye, AlertTriangle, ChevronUp, Tag, Bell, ChevronLeft, ChevronRight } from 'lucide-react';
import { RequestCancelledError } from '@/lib/api/client';
import {
  listForAdmin,
  list as listUpdates,
  show as showUpdate,
  markRead as markUpdateRead,
  create as createAnnouncement,
  update as updateAnnouncement,
  archive as archiveAnnouncement,
  AnnouncementOperationError,
  type Announcement,
} from '@/lib/shared/services/announcement.service';
import { AnnouncementFormModal, TYPE_SUGGESTIONS, type AnnouncementFormData } from '@/components/admin/announcements/announcement-form-modal';
import { AnnouncementDetailModal } from '@/components/shared/announcement-detail-modal';
import { Modal } from '@/components/admin/ui/modal';
import { ADMIN_BUTTON } from '@/components/admin/ui/modal-parts';
import { DataTable } from '@/components/admin/ui/data-table';
import { RowActionsMenu } from '@/components/admin/ui/row-actions-menu';
import { AdminDatePicker } from '@/components/admin/ui/admin-date-picker';

const PER_PAGE = 30;
/** Debounce window before a keystroke fires a server search request. */
const SEARCH_DEBOUNCE_MS = 300;

function formatCategory(value: string): string {
  const label = value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : '—';
}

type UpdateTab = 'all' | 'announcements' | 'notifications';
type ReadFilter = 'ALL' | 'UNREAD' | 'READ';
const NOTIFICATION_CATEGORIES = ['NEW_REGISTRATION', 'REGISTRATION_WAITING', 'DISCOUNT_APPLICATION_NEW', 'DISCOUNT_APPLICATION_WAITING', 'NEW_CLAIM', 'VEHICLE_STATUS_CHANGED', 'SHIFT_STARTED', 'SHIFT_ENDED', 'REMITTANCE_COMPLETED', 'REMITTANCE_OVERDUE', 'OVERSPEED_FLAGGED'];

type DateRange = 'today' | 'last_7_days' | 'this_month' | 'all';

const DATE_RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: 'this_month', label: 'This Month' },
  { value: 'today', label: 'Today' },
  { value: 'last_7_days', label: 'Last 7 Days' },
  { value: 'all', label: 'All' },
];

/**
 * Updates Center uses the existing recipient-scoped feed for All/Notifications
 * and the existing admin list for published announcements, including archives.
 * Frontend tab filtering scans cached server pages as needed, preserving
 * accurate visible pagination without adding backend filters or endpoints.
 */
export default function AnnouncementsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const userId = user?.id;
  const [activeTab, setActiveTab] = useState<UpdateTab>(() => {
    const tab = searchParams.get('tab');
    return tab === 'notifications' || tab === 'announcements' ? tab : 'all';
  });
  const [readFilter, setReadFilter] = useState<ReadFilter>('ALL');
  const [readVersion, setReadVersion] = useState(0);
  const sourceCacheRef = useRef<{ key: string; rows: Announcement[]; nextPage: number; hasMore: boolean }>({ key: '', rows: [], nextPage: 1, hasMore: true });
  const loadGenerationRef = useRef(0);
  const [items, setItems] = useState<Announcement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Status filter + search are resolved server-side so pagination stays
  // correct across the whole dataset, not just the currently loaded page.
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'ARCHIVED'>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // Mutually exclusive: picking an exact date clears the range dropdown back
  // to its "no preset active" placeholder, and vice versa — see the two
  // handlers below.
  const [selectedDate, setSelectedDate] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>('this_month');
  const [page, setPage] = useState(1);
  const [pageMeta, setPageMeta] = useState({ page: 1, total: 0, hasMore: false });
  // Modal state.
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<Announcement | null>(null);
  const [detailItem, setDetailItem] = useState<Announcement | null>(null);
  const [archivingItem, setArchivingItem] = useState<Announcement | null>(null);

  // Form submit state.
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | undefined>(undefined);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [isArchiving, setIsArchiving] = useState(false);

  // The mobile chevron collapses the action button, search, and filters; tabs stay visible.
  const [isMobileFiltersExpanded, setIsMobileFiltersExpanded] = useState(true);

  // ─── Debounce the search box → a server-side query, resetting to page 1 ──
  useEffect(() => {
    const id = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const handleStatusFilterChange = (key: 'ALL' | 'ACTIVE' | 'ARCHIVED') => {
    setStatusFilter(key);
    setPage(1);
  };

  const handleCategoryFilterChange = (type: string) => {
    setCategoryFilter(type);
    setPage(1);
  };

  const handleDateRangeChange = (range: DateRange) => {
    setDateRange(range);
    setSelectedDate('');
    setPage(1);
  };

  const handleSelectedDateChange = (date: string) => {
    setSelectedDate(date);
    // An exact date overrides the preset — drop the dropdown to "All" so it
    // doesn't keep showing a stale range that's no longer actually applied.
    if (date) setDateRange('all');
    setPage(1);
  };

  // ─── Fetch the current page from the server (status + search + page) ────
  // An in-flight request is aborted as soon as a newer one supersedes it
  // (fast typing, quick page flips), so the UI never renders stale results.
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!userId) return;
    const generation = ++loadGenerationRef.current;
    const current = () => !signal?.aborted && generation === loadGenerationRef.current;
    setIsLoading(true);
    setListError(null);
    const isManagement = activeTab === 'announcements';
    const serverUnreadOnly = !isManagement && readFilter === 'UNREAD';
    const key = JSON.stringify([userId, isManagement, isManagement ? [statusFilter, categoryFilter, searchQuery, selectedDate, dateRange] : serverUnreadOnly]);
    const stored = sourceCacheRef.current;
    const cache = stored.key === key
      ? { ...stored, rows: [...stored.rows] }
      : { key, rows: [] as Announcement[], nextPage: 1, hasMore: true };
    let startDate: Date | null = null;
    let endDate: Date | null = null;
    if (selectedDate) {
      startDate = new Date(`${selectedDate}T00:00:00`);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
    } else if (dateRange !== 'all') {
      startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
      if (dateRange === 'this_month') startDate.setDate(1);
      if (dateRange === 'last_7_days') startDate.setDate(startDate.getDate() - 6);
      endDate = new Date();
      endDate.setHours(24, 0, 0, 0);
    }
    const matches = (item: Announcement) => {
      const notification = Boolean(item.recipientId);
      if (isManagement) return !notification;
      if (notification && item.recipientId !== userId) return false;
      if (activeTab === 'notifications' && !notification) return false;
      if (readFilter === 'UNREAD' && item.isRead) return false;
      if (readFilter === 'READ' && !item.isRead) return false;
      if (categoryFilter !== 'ALL' && item.type !== categoryFilter) return false;
      if (searchQuery && !`${item.title} ${item.message}`.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      const postedAt = new Date(item.createdAt);
      return (!startDate || postedAt >= startDate) && (!endDate || postedAt < endDate);
    };
    const rangeExhausted = () => !isManagement && startDate !== null && cache.rows.length > 0
      && new Date(cache.rows[cache.rows.length - 1].createdAt) < startDate;
    try {
      let filtered = cache.rows.filter(matches);
      // Existing APIs paginate mixed updates. Scan batches only as needed for
      // the requested UI page; never apply a tab filter to a single server page.
      while (filtered.length < page * PER_PAGE + 1 && cache.hasMore && !rangeExhausted()) {
        const result = isManagement
          ? await listForAdmin({
              status: statusFilter === 'ALL' ? 'ACTIVE' : statusFilter,
              type: categoryFilter === 'ALL' ? undefined : categoryFilter,
              search: searchQuery || undefined, date: selectedDate || undefined,
              dateRange, page: cache.nextPage, perPage: 100, signal,
            })
          : await listUpdates({ unreadOnly: serverUnreadOnly, page: cache.nextPage, perPage: 100, signal });
        if (!current()) return;
        const seen = new Set(cache.rows.map((item) => item.id));
        cache.rows.push(...result.items.filter((item) => !seen.has(item.id)));
        cache.nextPage = result.page + 1;
        cache.hasMore = result.page < result.lastPage;
        filtered = cache.rows.filter(matches);
      }
      if (!current()) return;
      sourceCacheRef.current = cache;
      const safePage = Math.max(1, Math.min(page, Math.ceil(filtered.length / PER_PAGE)));
      setItems(filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE));
      setPageMeta({ page: safePage, total: filtered.length, hasMore: filtered.length > safePage * PER_PAGE || (cache.hasMore && !rangeExhausted()) });
      if (safePage !== page) setPage(safePage);
    } catch (err) {
      if (!current() || err instanceof RequestCancelledError) return;
      setListError(err instanceof Error ? err.message : 'Unable to load updates.');
      setItems([]);
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [userId, activeTab, readFilter, statusFilter, categoryFilter, searchQuery, selectedDate, dateRange, page]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, readVersion]);

  const refresh = useCallback(() => {
    sourceCacheRef.current.key = '';
    return load();
  }, [load]);

  const openDetails = useCallback((item: Announcement) => {
    setDetailItem(item);
    if (item.status === 'ARCHIVED' || item.isRead) return;
    void markUpdateRead(item.id).then(() => {
      sourceCacheRef.current.rows = sourceCacheRef.current.rows.map((row) => row.id === item.id ? { ...row, isRead: true } : row);
      // A read removes a row from the server's unread feed, shifting page offsets.
      if (readFilter === 'UNREAD') sourceCacheRef.current.key = '';
      setItems((rows) => rows.map((row) => row.id === item.id ? { ...row, isRead: true } : row));
      setDetailItem((current) => current?.id === item.id ? { ...current, isRead: true } : current);
      setReadVersion((version) => version + 1);
    }).catch(() => setActionError('Unable to mark this update as read. Please try again.'));
  }, [readFilter]);

  const linkedUpdateId = searchParams.get('updateId');
  useEffect(() => {
    if (!linkedUpdateId || !userId) return;
    const controller = new AbortController();
    void showUpdate(linkedUpdateId, controller.signal).then((item) => {
      if (controller.signal.aborted) return;
      if (item.recipientId && item.recipientId !== userId) {
        setActionError('This notification is not available to your account.');
      } else {
        const tab = item.recipientId ? 'notifications' : 'announcements';
        setActiveTab(tab);
        setPage(1);
        openDetails(item);
      }
      router.replace('/announcements', { scroll: false });
    }).catch((error) => {
      if (!controller.signal.aborted) setActionError(error instanceof Error ? error.message : 'Unable to open this update.');
    });
    return () => controller.abort();
  }, [linkedUpdateId, userId, router, openDetails]);

  const from = items.length === 0 ? 0 : (pageMeta.page - 1) * PER_PAGE + 1;
  const to = items.length === 0 ? 0 : from + items.length - 1;

  // ─── Open create / edit ─────────────────────────────────────────────
  const handleOpenCreate = () => {
    setEditingItem(null);
    setFieldErrors(undefined);
    setSubmitError(null);
    setIsFormOpen(true);
  };

  const handleOpenEdit = (item: Announcement) => {
    setEditingItem(item);
    setFieldErrors(undefined);
    setSubmitError(null);
    setIsFormOpen(true);
  };

  const handleCloseForm = () => {
    if (isSubmitting) return;
    setIsFormOpen(false);
    setEditingItem(null);
    setFieldErrors(undefined);
    setSubmitError(null);
  };

  // ─── Submit create / edit ───────────────────────────────────────────
  const handleSubmitForm = async (data: AnnouncementFormData) => {
    setIsSubmitting(true);
    setFieldErrors(undefined);
    setSubmitError(null);
    try {
      if (editingItem) {
        await updateAnnouncement(editingItem.id, {
          title: data.title,
          message: data.message,
          type: data.type || null,
        });
      } else {
        await createAnnouncement({
          title: data.title,
          message: data.message,
          ...(data.type ? { type: data.type } : {}),
        });
      }
      setIsFormOpen(false);
      setEditingItem(null);
      void refresh();
    } catch (err) {
      if (err instanceof AnnouncementOperationError) {
        if (err.code === 'validation') {
          setFieldErrors(err.fieldErrors);
          setSubmitError(err.message);
        } else {
          setSubmitError(err.message);
        }
      } else {
        setSubmitError('Unable to save this announcement.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── Archive flow (with confirm) ────────────────────────────────────
  const handleConfirmArchive = async () => {
    if (!archivingItem) return;
    setIsArchiving(true);
    setActionError(null);
    try {
      await archiveAnnouncement(archivingItem.id);
      setArchivingItem(null);
      void refresh();
    } catch (err) {
      setActionError(
        err instanceof AnnouncementOperationError
          ? err.message
          : 'Unable to archive this announcement.'
      );
    } finally {
      setIsArchiving(false);
    }
  };

  // ─── Helpers ────────────────────────────────────────────────────────
  const formatRelativeTime = (iso: string): string => {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const columns = [
    {
      key: 'title',
      label: activeTab === 'announcements' ? 'Announcement' : 'Update',
      headerClassName: 'w-[34%]',
      render: (value: string, item: Announcement) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-white admin-light:text-slate-900" title={value}>{value}</p>
          <p className="mt-0.5 truncate text-xs text-slate-500" title={item.message}>{item.message}</p>
        </div>
      ),
    },
    {
      key: 'type',
      label: 'Category',
      headerClassName: 'w-[14%]',
      render: (value: string) => value ? (
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-slate-300 admin-light:text-slate-700" title={formatCategory(value)}>
          <Tag size={14} className="shrink-0 text-slate-500" aria-hidden="true" />
          <span className="truncate">{formatCategory(value)}</span>
        </span>
      ) : <span className="text-xs text-slate-500">—</span>,
    },
    ...(activeTab === 'announcements' ? [{
      key: 'status',
      label: 'Status',
      headerClassName: 'w-[12%]',
      cellClassName: 'whitespace-nowrap',
      render: (_: unknown, item: Announcement) => (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300 admin-light:text-slate-700">
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.status === 'ARCHIVED' ? 'bg-slate-500' : 'bg-emerald-400'}`} />
          {item.displayStatus}
        </span>
      ),
    }] : []),
    {
      key: 'createdBy',
      label: 'Source',
      headerClassName: 'w-[16%]',
      cellClassName: 'truncate',
      render: (_: string | null, item: Announcement) => (
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 admin-light:text-slate-500">
          {item.recipientId ? <Bell size={13} className="text-slate-500" /> : <Megaphone size={13} className="text-slate-500" />}
          {item.recipientId ? 'Notification' : 'Announcement'}
        </span>
      ),
    },
    {
      key: 'createdAt',
      label: 'Posted',
      headerClassName: 'w-[14%]',
      cellClassName: 'whitespace-nowrap',
      render: (value: string) => <span className="text-xs text-slate-400 admin-light:text-slate-500" title={new Date(value).toLocaleString()}>{formatRelativeTime(value)}</span>,
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'center' as const,
      headerClassName: 'w-20',
      cellClassName: 'w-20',
      render: (_: unknown, item: Announcement) => (
        <RowActionsMenu
          label={`Actions for ${item.title}`}
          actions={[
            { label: 'View Details', icon: Eye, onSelect: () => openDetails(item) },
            ...(!item.recipientId ? [{ label: 'Edit', icon: Edit3, onSelect: () => handleOpenEdit(item) }, ...(item.status !== 'ARCHIVED' ? [{ label: 'Archive', icon: Archive, onSelect: () => setArchivingItem(item), tone: 'danger' as const }] : [])] : []),
          ]}
        />
      ),
    },
  ];

  const searchInputClasses =
    'h-11 w-full bg-[#0E1628] admin-light:bg-white border border-[#1E2D45] admin-light:border-[#E2E8F0] rounded-md pl-10 pr-4 text-base text-white admin-light:text-slate-900 placeholder:text-slate-500 admin-light:placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-[#62A0EA] admin-light:focus:ring-[#1A5FB4] transition-colors md:text-sm';
  const selectFilterClasses =
    'h-11 min-w-0 w-full rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white px-3 text-base text-slate-200 admin-light:text-slate-800 outline-none transition-colors scheme-dark admin-light:scheme-light focus:border-[#62A0EA]/50 admin-light:focus:border-[#1A5FB4]/50 focus:ring-1 focus:ring-[#62A0EA]/30 admin-light:focus:ring-[#1A5FB4]/30 md:w-56 md:shrink-0 md:text-sm';

  const filterOptions = activeTab === 'announcements'
    ? [['ALL', 'All'], ['ACTIVE', 'Active'], ['ARCHIVED', 'Archived']]
    : [['ALL', 'All'], ['UNREAD', 'Unread'], ['READ', 'Read']];
  const selectedFilter = activeTab === 'announcements' ? statusFilter : readFilter;

  return (
    <div className="h-full min-h-[32rem] min-w-0 w-[calc(100%+2rem)] flex flex-col overflow-hidden relative -mx-4 -mt-4 md:min-h-0 md:w-full md:mx-0 md:mt-0">
      {/* Header. On phones it breaks out of <main>'s padding to sit flush at the
          top edge-to-edge (like the shared sticky header). On desktop it drops
          the boxed-card look and becomes a borderless, transparent full-width
          header — flush to the content edges like every other admin module —
          with just a full-width bottom divider. */}
      <div className="relative z-20 flex-shrink-0 bg-[#131C2E] admin-light:max-md:bg-white border-b border-[#1E2D45] admin-light:border-[#E2E8F0] p-4 mb-4 md:bg-transparent md:rounded-none md:px-0 md:pt-0 md:pb-5 md:mb-6">
        <div className="mb-4 pr-12 md:mb-5 md:pr-0">
          <div className="min-w-0">
            <h1 className="text-white admin-light:text-slate-900 font-bold text-xl lg:text-2xl flex items-center gap-2">
              <Megaphone size={22} className="text-[#62A0EA] admin-light:text-[#1A5FB4]" />
              Updates Center
            </h1>
            <p className="text-slate-500 text-xs mt-1">
              Announcements and operational notifications
            </p>
          </div>
        </div>

        <div className={`mb-4 flex flex-wrap items-center justify-between gap-x-3 border-b border-[#1E2D45] admin-light:border-[#E2E8F0] md:gap-y-3 ${isMobileFiltersExpanded ? 'gap-y-3' : 'gap-y-0'}`}>
          <div role="group" aria-label="Update type" className="flex w-full min-w-0 gap-1 overflow-x-auto scrollbar-themed md:w-auto">
            {([['all', 'All Updates'], ['announcements', 'Announcements'], ['notifications', 'Notifications']] as const).map(([tab, label]) => (
              <button key={tab} type="button" aria-pressed={activeTab === tab} onClick={() => {
                setActiveTab(tab);
                setPage(1);
                setCategoryFilter('ALL');
                setReadFilter('ALL');
                setStatusFilter('ALL');
              }} className={`min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors ${activeTab === tab ? 'border-[#62A0EA] admin-light:border-[#1A5FB4] text-[#62A0EA] admin-light:text-[#1A5FB4]' : 'border-transparent text-slate-400 admin-light:text-slate-500 hover:text-white admin-light:hover:text-slate-900'}`}>{label}</button>
            ))}
          </div>
          <div
            id="updates-center-action"
            className={`ml-auto w-full transition-all duration-300 ease-in-out md:visible md:w-auto md:overflow-visible md:max-h-none! ${isMobileFiltersExpanded ? 'visible overflow-visible' : 'invisible overflow-hidden'}`}
            style={{ maxHeight: isMobileFiltersExpanded ? '44px' : '0px' }}
          >
            <button
              onClick={handleOpenCreate}
              className="inline-flex h-11 w-full flex-shrink-0 items-center justify-center gap-2 rounded-lg bg-[#62A0EA] admin-light:bg-[#1A5FB4] px-4 text-sm font-bold text-white transition-colorshover:bg-[#4A8BD4] admin-light:hover:bg-[#164A8F] md:w-auto md:-translate-y-1"
            >
              <Plus size={16} />
              <span>New Announcement</span>
            </button>
          </div>
        </div>

        <div
          id="updates-center-controls"
          className={`transition-all duration-300 ease-in-out md:visible md:overflow-visible md:max-h-none! ${isMobileFiltersExpanded ? 'visible overflow-visible' : 'invisible overflow-hidden'}`}
          style={{ maxHeight: isMobileFiltersExpanded ? '600px' : '0px' }}
        >
          <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center md:pl-1">
            <div className="flex w-full min-w-0 items-center gap-2 md:w-80 md:flex-none">
              <div className="relative min-w-0 flex-1">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                </svg>
                <input
                  type="text"
                  aria-label="Search updates by title or message"
                  placeholder="Search title or message…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className={searchInputClasses}
                />
              </div>
            </div>

            <div className="w-full md:ml-auto md:w-auto md:max-w-full">
              <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center md:gap-3">
                {/* Exact date picker — resolved server-side (whereDate created_at).
                    Picking a date overrides the range dropdown below (see
                    handleSelectedDateChange), same relationship as the two date
                    filters on the Lost & Found admin page. */}
                <AdminDatePicker
                  accent="blue"
                  popover
                  yearNavigation
                  ariaLabel="Filter updates by an exact date"
                  value={selectedDate}
                  onChange={handleSelectedDateChange}
                  triggerClassName="h-11 w-full text-sm!"
                  className="min-w-0 w-full md:w-56 md:shrink-0"
                />
                {/* Quick date range — same today/last_7_days/this_month convention
                    as Fleet Management's shift history filter. Defaults to This
                    Month. Mutually exclusive with the exact date picker above. */}
                <select
                  value={dateRange}
                  onChange={(e) => handleDateRangeChange(e.target.value as DateRange)}
                  aria-label="Filter updates by a quick date range"
                  className={selectFilterClasses}
                >
                  {DATE_RANGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value} className="bg-[#0E1628] admin-light:bg-white">
                      {option.label}
                    </option>
                  ))}
                </select>
                {/* Category filter — same suggested categories offered when creating
                    a new announcement (TYPE_SUGGESTIONS), so this list can't drift
                    from what an admin can actually assign. */}
                <select
                  value={categoryFilter}
                  onChange={(e) => handleCategoryFilterChange(e.target.value)}
                  aria-label="Filter updates by category"
                  className={`${selectFilterClasses} col-span-2`}
                >
                  <option value="ALL" className="bg-[#0E1628] admin-light:bg-white">All Categories</option>
                  {(activeTab === 'announcements' ? TYPE_SUGGESTIONS : [...TYPE_SUGGESTIONS, ...NOTIFICATION_CATEGORIES]).map((type) => (
                    <option key={type} value={type} className="bg-[#0E1628] admin-light:bg-white">
                      {formatCategory(type)}
                    </option>
                  ))}
                </select>
                <div role="group" aria-label={activeTab === 'announcements' ? 'Announcement status' : 'Read status'} className="col-span-2 flex h-11 w-full shrink-0 items-stretch gap-1 rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white p-1 md:w-56">
                  {filterOptions.map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={selectedFilter === key}
                      onClick={() => {
                        if (activeTab === 'announcements') handleStatusFilterChange(key as 'ALL' | 'ACTIVE' | 'ARCHIVED');
                        else { setReadFilter(key as ReadFilter); setPage(1); }
                      }}
                      className={`flex-1 rounded-md px-2 text-sm font-semibold transition-all ${
                        selectedFilter === key
                          ? 'bg-[#62A0EA] admin-light:bg-[#1A5FB4] text-white'
                          : 'text-slate-500 hover:text-slate-300 admin-light:hover:text-slate-700 hover:bg-[#1A2540] admin-light:hover:bg-[#EEF2F7]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsMobileFiltersExpanded((prev) => !prev)}
          aria-expanded={isMobileFiltersExpanded}
          aria-controls="updates-center-action updates-center-controls"
          aria-label={isMobileFiltersExpanded ? 'Collapse controls' : 'Expand controls'}
          className="-mx-4 -mb-4 mt-2 flex min-h-11 w-[calc(100%+2rem)] flex-shrink-0 items-center justify-center border-t border-white/5 admin-light:border-[#E2E8F0] py-1.5 text-slate-500 transition-colors hover:bg-white/5 admin-light:hover:bg-[#F1F5F9] hover:text-slate-300 admin-light:hover:text-slate-700 active:bg-white/10 admin-light:active:bg-[#EEF2F7] md:hidden"
        >
          <ChevronUp className={`h-4 w-4 transition-transform duration-300 ${isMobileFiltersExpanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </div>

      {/* Action error */}
      {actionError && (
        <div className="mx-4 md:mx-0 mb-4 bg-red-500/10 border border-red-500/30 rounded-md p-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-red-400 admin-light:text-red-600 flex-shrink-0" />
          <p className="text-red-400 admin-light:text-red-600 text-xs font-medium">{actionError}</p>
          <button
            onClick={() => setActionError(null)}
            className="ml-auto text-red-400/60 admin-light:text-red-600 hover:text-red-400 admin-light:hover:text-red-700 text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Table — bounded height; only the rows scroll internally so the
          header row and the pagination bar stay put instead of scrolling
          away with the content. */}
      <div className="relative z-0 flex-1 min-h-0 flex flex-col px-4 md:px-0">
        {isLoading ? (
          <div className="h-full flex flex-col items-center justify-center">
            <div className="w-8 h-8 border-2 border-[#1E2D45] admin-light:border-[#E2E8F0] border-t-[#62A0EA] admin-light:border-t-[#1A5FB4] rounded-full animate-spin" />
            <p className="text-slate-500 text-sm mt-4">Loading announcements…</p>
          </div>
        ) : listError ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4">
            <AlertTriangle size={32} className="text-red-400/60 admin-light:text-red-600 mb-3" />
            <p className="text-red-400 admin-light:text-red-600 font-medium text-sm mb-3">{listError}</p>
            <button
              onClick={() => void refresh()}
              className="px-4 py-2 rounded-md text-xs font-semibold bg-[#62A0EA] admin-light:bg-[#1A5FB4] text-white"
            >
              Try again
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4">
            <Megaphone size={40} className="text-slate-600 admin-light:text-slate-400 mb-3" />
            <h3 className="text-slate-300 admin-light:text-slate-700 font-semibold mb-1">No updates found</h3>
            <p className="text-slate-500 text-sm">
              {searchQuery || statusFilter !== 'ALL' || dateRange !== 'all' || selectedDate
                ? 'Try adjusting your search or filters.'
                : 'Updates will appear here when announcements are published or events occur.'}
            </p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col gap-3">
            {/* Desktop table — header row stays pinned while only the body scrolls. */}
            <div className="hidden md:flex md:flex-1 md:min-h-0 md:flex-col rounded-lg border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#111A2B] admin-light:bg-white p-3 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
              <DataTable
                data={items}
                columns={columns}
                searchQuery=""
                onRowDoubleClick={openDetails}
                height="100%"
                stickyHeader
                tableClassName="w-full min-w-[760px] table-fixed"
              />
            </div>

            {/* Mobile cards */}
            <div className="md:hidden flex-1 min-h-0 overflow-y-auto space-y-3">
              {items.map((item) => (
                <div key={item.id} className="bg-[#131C2E] admin-light:bg-white border border-[#1E2D45] admin-light:border-[#E2E8F0] rounded-lg p-4">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="min-w-0 flex-1 break-words text-sm font-semibold text-white admin-light:text-slate-900">{item.title}</p>
                    {activeTab === 'announcements' && <span
                      className={`flex-shrink-0 text-[10px] font-bold uppercase tracking-wider ${
                        item.status === 'ARCHIVED'
                          ? 'text-slate-500'
                          : 'text-slate-300 admin-light:text-slate-700'
                      }`}
                    >
                      {item.displayStatus}
                    </span>}
                  </div>
                  <p className="text-xs text-slate-500 line-clamp-2 mb-3">
                    {item.message.slice(0, 120)}
                    {item.message.length > 120 ? '…' : ''}
                  </p>
                  <div className="flex flex-col gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[10px] text-slate-600 admin-light:text-slate-400">
                      <span className="text-slate-400 admin-light:text-slate-500">{item.recipientId ? 'Notification' : 'Announcement'}</span>
                      {item.type && (
                        <span className="px-1.5 py-0.5 rounded bg-[#62A0EA]/10 admin-light:bg-[#1A5FB4]/10 text-[#62A0EA] admin-light:text-[#1A5FB4] font-medium">
                          {formatCategory(item.type)}
                        </span>
                      )}
                      <span>{formatRelativeTime(item.createdAt)}</span>
                    </div>
                    <div className="flex items-center justify-end gap-2 border-t border-[#1E2D45] admin-light:border-[#E2E8F0] pt-2">
                      <button aria-label={`View ${item.title}`} onClick={() => openDetails(item)} className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] text-slate-400 admin-light:text-slate-500 hover:text-[#62A0EA] admin-light:hover:text-[#1A5FB4] hover:bg-[#62A0EA]/10 admin-light:hover:bg-[#1A5FB4]/10">
                        <Eye size={15} />
                      </button>
                      {!item.recipientId && <>
                      <button aria-label={`Edit ${item.title}`} onClick={() => handleOpenEdit(item)} className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] text-slate-400 admin-light:text-slate-500 hover:text-[#62A0EA] admin-light:hover:text-[#1A5FB4] hover:bg-[#62A0EA]/10 admin-light:hover:bg-[#1A5FB4]/10">
                        <Edit3 size={15} />
                      </button>
                      <button
                        aria-label={`Archive ${item.title}`}
                        onClick={() => setArchivingItem(item)}
                        disabled={item.status === 'ARCHIVED'}
                        className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] text-slate-400 admin-light:text-slate-500 hover:text-amber-400 admin-light:hover:text-amber-700 hover:bg-amber-400/10 disabled:opacity-30"
                      >
                        <Archive size={15} />
                      </button>
                      </>}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination — outside the scrollable areas above, so it never scrolls out of view. */}
            <div className="flex-shrink-0 bg-[#131C2E] admin-light:bg-white border border-[#1E2D45] admin-light:border-[#E2E8F0] rounded-lg px-3 pb-3">
              <div className="flex flex-col items-center justify-between gap-2 border-t border-[#1E2D45] admin-light:border-[#E2E8F0] pt-2 text-xs text-slate-500 sm:flex-row sm:gap-3">
                <p>Showing {from}–{to} updates{!pageMeta.hasMore && ` of ${pageMeta.total}`}</p>
                <div className="flex items-center gap-2">
                  <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-[#F8FAFC] text-slate-400 admin-light:text-slate-500 disabled:opacity-30 sm:h-9 sm:w-9"><ChevronLeft size={16} /></button>
                  <span className="rounded-md bg-[#62A0EA]/15 admin-light:bg-[#1A5FB4]/15 px-3 py-1.5 font-medium text-[#62A0EA] admin-light:text-[#1A5FB4]">Page {pageMeta.page}</span>
                  <button type="button" aria-label="Next page" disabled={!pageMeta.hasMore} onClick={() => setPage((value) => value + 1)} className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-[#F8FAFC] text-slate-400 admin-light:text-slate-500 disabled:opacity-30 sm:h-9 sm:w-9"><ChevronRight size={16} /></button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create / Edit modal */}
      <AnnouncementFormModal
        isOpen={isFormOpen}
        onClose={handleCloseForm}
        onSubmit={handleSubmitForm}
        initial={editingItem}
        fieldErrors={fieldErrors}
        submitError={submitError}
        isSubmitting={isSubmitting}
      />

      {/* Detail modal */}
      <AnnouncementDetailModal
        managementView
        announcement={detailItem}
        isOpen={detailItem !== null}
        onClose={() => setDetailItem(null)}
      />

      {/* Archive confirm modal */}
      <Modal adminThemed isOpen={archivingItem !== null} onClose={() => !isArchiving && setArchivingItem(null)} maxWidth="max-w-md">
        {archivingItem && (
          <>
            <div className="flex items-start gap-3 pr-8">
              <Archive size={28} aria-hidden="true" className="shrink-0 text-[#62A0EA] admin-light:text-[#1A5FB4]" />
              <div className="min-w-0">
                <h3 className="text-lg font-semibold tracking-tight text-white admin-light:text-slate-900">Archive this announcement?</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-400 admin-light:text-slate-500">
                  It disappears right away from the commuter bell and the updates feed. You can still find it by filtering to Archived.
                </p>
              </div>
            </div>
            <div className="mt-4 rounded-md border border-[#2A3A55] bg-[#131C2E] p-3 admin-light:border-[#E2E8F0] admin-light:bg-[#F8FAFC]">
              <p className="text-sm font-semibold break-words text-white admin-light:text-slate-900">{archivingItem.title}</p>
              <p className="mt-0.5 line-clamp-2 text-xs text-slate-400 admin-light:text-slate-500">{archivingItem.message}</p>
            </div>
            {/* Archiving can be filtered back into view, so it's the normal
                primary action rather than a red destructive one. */}
            <div className="mt-5 flex flex-col-reverse gap-2 min-[380px]:flex-row min-[380px]:justify-end">
              <button type="button" onClick={() => setArchivingItem(null)} disabled={isArchiving} className={ADMIN_BUTTON.secondary}>
                Cancel
              </button>
              <button type="button" onClick={handleConfirmArchive} disabled={isArchiving} className={ADMIN_BUTTON.primary}>
                {isArchiving
                  ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  : <Archive size={16} aria-hidden="true" />}
                Archive
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
