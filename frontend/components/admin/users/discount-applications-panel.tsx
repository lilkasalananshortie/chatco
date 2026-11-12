'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronUp, RotateCw, SlidersHorizontal } from 'lucide-react';
import { DataTable } from '@/components/admin/ui/data-table';
import { TablePagination } from '@/components/admin/ui/table-pagination';
import { SearchBar } from '@/components/admin/ui/search-bar';
import { ReviewRequestModal } from '@/components/admin/users/review-request-modal';
import { OperationResultModal } from '@/components/admin/ui/operation-result-modal';
import { CommuterTypeLabel } from './commuter-type-label';
import type { PendingRequest } from '@/app/(admin)/users/data/users-data';
import { DISCOUNT_CATEGORIES, APPLICATION_LABELS, discountStatusLabel, renewalRequest, type DiscountApplication } from '@/lib/shared/services/student-renewal.service';

interface ApplicationsPage {
  data: DiscountApplication[]; current_page: number; last_page: number;
  total: number; from: number | null; to: number | null;
}

function reviewRequest(application: DiscountApplication): PendingRequest | null {
  const profile = application.commuter;
  if (!profile) return null;
  return {
    id: application.id, name: `${profile.first_name} ${profile.middle_name ?? ''} ${profile.surname}`.replace(/\s+/g, ' ').trim(),
    firstName: profile.first_name, middleName: profile.middle_name, surname: profile.surname, email: profile.email,
    phoneNumber: profile.contact_number, commuterType: DISCOUNT_CATEGORIES[application.requested_type], languagePreference: 'English',
    idImageUrl: application.document_url ?? '', profileImageUrl: null, status: 'Pending Verification', birthdate: profile.birthdate,
    gender: profile.gender, username: profile.username, appliedType: application.requested_type, rejectionCount: 0,
    rejectionHistory: [], blockedUntil: null, createdAt: application.submitted_at,
    // The application's own school fields show in the discount review layout.
    studentDetails: null,
  };
}

export function DiscountApplicationsPanel({ initialId, onReviewed, registerAction }: {
  initialId?: string; onReviewed?: () => void;
  /** Phones only: the page's Register menu, shown with the expanded filters. */
  registerAction?: ReactNode;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [result, setResult] = useState<ApplicationsPage | null>(null);
  const [status, setStatus] = useState('PENDING');
  const [kind, setKind] = useState('');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<{ title: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<DiscountApplication | null>(null);
  // The table row already holds everything but the signed document link, so
  // the modal opens from it at once and the link fills in when fetched.
  const [documentPending, setDocumentPending] = useState(false);
  const listSequence = useRef(0);
  const reviewSequence = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++listSequence.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), per_page: '20', status, search: query, request_type: kind, requested_type: category });
      const data = await renewalRequest<ApplicationsPage>(`/api/admin/discount-applications?${params}`, { signal });
      if (!signal?.aborted && sequence === listSequence.current) { setResult(data); setError(''); }
    } catch (err) { if (!signal?.aborted && sequence === listSequence.current) setError(err instanceof Error ? err.message : 'Unable to load applications.'); }
    finally { if (!signal?.aborted && sequence === listSequence.current) setLoading(false); }
  }, [page, status, query, kind, category]);
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 600);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController(); void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const open = useCallback(async (id: string, signal?: AbortSignal, row?: DiscountApplication) => {
    const sequence = ++reviewSequence.current;
    if (row) setSelected(row);
    setDocumentPending(true);
    try {
      const data = await renewalRequest<ApplicationsPage>(`/api/admin/discount-applications?id=${encodeURIComponent(id)}`, { signal });
      if (!signal?.aborted && sequence === reviewSequence.current && data.data[0]) setSelected(data.data[0]);
    } catch (err) { if (!signal?.aborted && sequence === reviewSequence.current) setError(err instanceof Error ? err.message : 'Unable to open application.'); }
    finally { if (!signal?.aborted && sequence === reviewSequence.current) setDocumentPending(false); }
  }, []);
  useEffect(() => {
    if (!initialId) return;
    const controller = new AbortController(); void open(initialId, controller.signal);
    return () => controller.abort();
  }, [initialId, open]);
  const review = async (decision: string, reason?: string) => {
    if (!selected || busy) return;
    setBusy(true); setError('');
    try {
      await renewalRequest(`/api/admin/discount-applications/${encodeURIComponent(selected.id)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, reason, revision: selected.revision }) });
      const renewal = selected.request_type === 'RENEWAL';
      const label = DISCOUNT_CATEGORIES[selected.requested_type];
      setSelected(null);
      setOutcome(decision === 'NEEDS_CORRECTION'
        ? { title: 'Corrections requested', message: renewal ? 'The commuter has seven days to respond.' : 'The application stays open until the commuter resubmits.' }
        : decision === 'APPROVED'
          ? (renewal ? { title: 'Student renewal approved', message: 'The commuter stays Student.' } : { title: `${label} discount approved`, message: `The commuter's account is now ${label}.` })
          : (renewal ? { title: 'Renewal rejected', message: 'The commuter is now Regular.' } : { title: 'Application rejected', message: 'The account remains Regular.' }));
      onReviewed?.();
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to review application.'); void open(selected.id); }
    finally { setBusy(false); }
  };
  const columns = [
    { key: 'commuter', label: 'Commuter', render: (_: never, item: DiscountApplication) => <div><p className="font-medium text-white admin-light:text-slate-900">{item.commuter?.first_name} {item.commuter?.surname}</p><p className="text-xs text-slate-400 admin-light:text-slate-500">{item.commuter?.email}</p></div> },
    { key: 'request_type', label: 'Request', cellClassName: 'whitespace-nowrap', render: (_: never, item: DiscountApplication) => item.request_type === 'RENEWAL'
      ? <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-200 admin-light:text-amber-700"><RotateCw size={14} aria-hidden="true" className="shrink-0" />Renewal</span>
      : <span className="text-sm font-medium text-[#99C1F1] admin-light:text-[#1A5FB4]">Application</span> },
    { key: 'requested_type', label: 'Discount category', cellClassName: 'whitespace-nowrap', render: (_: never, item: DiscountApplication) => <CommuterTypeLabel type={DISCOUNT_CATEGORIES[item.requested_type]} /> },
    { key: 'school_name', label: 'Supporting details', render: (_: never, item: DiscountApplication) => item.requested_type === 'STUDENT' ? <div>{item.school_name}<p className="text-xs text-slate-400 admin-light:text-slate-500">{item.school_year}</p></div> : `${DISCOUNT_CATEGORIES[item.requested_type]} ID/card` },
    { key: 'submitted_at', label: 'Submitted', render: (_: never, item: DiscountApplication) => new Date(item.submitted_at).toLocaleDateString('en-PH') },
    { key: 'status', label: 'Status', render: (_: never, item: DiscountApplication) => discountStatusLabel(item) },
    { key: 'actions', label: 'Action', render: (_: never, item: DiscountApplication) => <button onClick={() => void open(item.id, undefined, item)} className="min-h-11 px-3 text-sm text-[#99C1F1] admin-light:text-[#1A5FB4]">{item.status === 'PENDING' ? 'Review' : 'View'}</button> },
  ];

  return <div className="flex min-h-0 flex-1 flex-col gap-3">
    {/* Same shape as the other User Management tabs: search + Filters toggle
        on phones, with the filters and the Register action collapsing together. */}
    <div className="flex w-full flex-col gap-3 lg:flex-row lg:items-center">
      <div className="flex min-w-0 items-center gap-2 lg:w-72 lg:shrink-0">
        <SearchBar value={search} onChange={setSearch} placeholder="Search discount applications..." className="min-w-0 flex-1 [&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm" />
        <button
          type="button"
          onClick={() => setFiltersOpen(open => !open)}
          aria-expanded={filtersOpen}
          aria-controls="discount-application-filters"
          className={`inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors md:hidden ${filtersOpen ? 'border-[#62A0EA]/40 admin-light:border-[#1A5FB4]/40 bg-[#62A0EA]/10 admin-light:bg-[#1A5FB4]/10 text-[#62A0EA] admin-light:text-[#1A5FB4]' : 'border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white text-slate-300 admin-light:text-slate-700'}`}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          Filters
          <ChevronUp size={14} className={filtersOpen ? '' : 'rotate-180'} aria-hidden="true" />
        </button>
      </div>
      <div id="discount-application-filters" className={`${filtersOpen ? 'block' : 'hidden'} md:block lg:ml-auto`}>
        <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center md:gap-3">
          <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} aria-label="Application status" className="h-11 w-full min-w-0 rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white px-3 text-base text-white admin-light:text-slate-900 scheme-dark admin-light:scheme-light md:w-auto md:text-sm"><option value="">All Statuses</option>{(['PENDING', 'NEEDS_CORRECTION', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const).map(value => <option key={value} value={value}>{APPLICATION_LABELS[value]}</option>)}</select>
          <select value={kind} onChange={e => { setKind(e.target.value); setPage(1); }} aria-label="Request type" className="h-11 w-full min-w-0 rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white px-3 text-base text-white admin-light:text-slate-900 scheme-dark admin-light:scheme-light md:w-auto md:text-sm"><option value="">All requests</option><option value="APPLICATION">Applications</option><option value="RENEWAL">Renewals</option></select>
          <select value={category} onChange={e => { setCategory(e.target.value); setPage(1); }} aria-label="Discount category" className="h-11 w-full min-w-0 rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white px-3 text-base text-white admin-light:text-slate-900 scheme-dark admin-light:scheme-light col-span-2 md:w-auto md:text-sm"><option value="">All categories</option>{Object.entries(DISCOUNT_CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        </div>
      </div>
      {registerAction && <div className={`${filtersOpen ? 'block' : 'hidden'} md:hidden`}>{registerAction}</div>}
    </div>
    {error && <p role="alert" className="text-sm text-red-300 admin-light:text-red-700">{error}</p>}
    {loading && <p role="status" className="text-sm text-slate-400 admin-light:text-slate-500">Loading applications...</p>}
    <DataTable data={result?.data ?? []} columns={columns} searchQuery="" emptyMessage="No discount applications match this status." onRowDoubleClick={item => void open(item.id, undefined, item)} height="100%" mobileCards />
    {result && <TablePagination currentPage={result.current_page} totalPages={result.last_page} total={result.total} from={result.from ?? 0} to={result.to ?? 0} onPageChange={setPage} label="applications" />}
    <ReviewRequestModal key={selected ? `${selected.id}:${selected.revision}` : 'closed'} renewal={selected} errorMessage={error} isOpen={selected !== null} request={selected ? reviewRequest(selected) : null} onClose={() => { if (busy) return; ++reviewSequence.current; setDocumentPending(false); setSelected(null); }} isProcessing={busy} documentLoading={documentPending && !selected?.document_url} onApprove={() => void review('APPROVED')} onReject={(reason, final) => void review(final ? 'REJECTED' : 'NEEDS_CORRECTION', reason)} />
    <OperationResultModal isOpen={outcome !== null} type="success" title={outcome?.title ?? ''} message={outcome?.message ?? ''} onClose={() => setOutcome(null)} />
  </div>;
}
