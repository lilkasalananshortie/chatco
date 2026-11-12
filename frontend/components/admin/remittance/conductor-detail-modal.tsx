// components/admin/remittance/conductor-detail-modal.tsx
'use client';

import { useState, useEffect } from 'react';
import { Modal } from '@/components/admin/ui/modal';
import { PageTabs, type PageTab } from '@/components/admin/ui/page-tabs';
import { AdminDatePicker } from '@/components/admin/ui/admin-date-picker';
import { RemittanceStatusText } from '@/components/admin/remittance/remittance-status-text';
import { getInitials } from '@/components/admin/layout/admin-identity';
import {
  fetchRemittances,
  type RemittanceRecord,
} from '@/app/(admin)/remittance/data/remittance-data';
import type { RemittanceStatus } from '@/types';
import {
  Banknote, ReceiptText, MapPin,
  ChevronLeft, ChevronRight, Search, X,
} from 'lucide-react';
import { formatPeso } from '@/lib/utils/display';

// ─── Remittance History pagination ─────────────────────────────────────
const REMIT_PAGE_SIZE = 15;
type RemitFilter = 'All' | 'Remitted' | 'Pending';
type ModalTab = 'remittance' | 'transactions';

// Statuses still waiting on the conductor's cash — the same set the header's
// pending total counts, so the "Pending" filter and that figure always agree.
const PENDING_STATUSES: RemittanceStatus[] = ['Pending', 'Not Remitted', 'For Cash Declaration', 'Overdue'];
// Shifts whose cash was handed over, including those with a discrepancy.
const REMITTED_STATUSES: RemittanceStatus[] = ['Settled', 'Shortage', 'Overage'];

const REMIT_FILTERS: RemitFilter[] = ['All', 'Remitted', 'Pending'];

const TABS: PageTab<ModalTab>[] = [
  { id: 'remittance', label: 'Remittance history', icon: Banknote },
  { id: 'transactions', label: 'Transactions', icon: ReceiptText },
];

// ─── Helper ────────────────────────────────────────────────────────────
const fmt = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatLogTime = (iso: string) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-PH', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
};

/** HH:MM straight from the ISO string, as the shift times were shown before. */
const hhmm = (iso?: string | null) => iso?.split('T')[1]?.slice(0, 5) || '—';

// ─── Real Transaction type (from API) ──────────────────────────────────
interface ApiTransaction {
  transaction_id: string;
  shift_id: string;
  payment_method: string;
  status: string;
  final_amount: string | number;
  passenger_name: string | null;
  payer_name?: string | null;
  payer_name_snapshot?: string | null;
  total_passengers?: number;
  passenger_breakdown?: Array<{ passenger_type: string; quantity: number }>;
  pickup_name: string | null;
  dropoff_name: string | null;
  created_at: string;
}

type PaymentKind = 'cash' | 'gcash' | 'voucher';

const paymentKind = (method: string): PaymentKind => {
  if (method === 'GCASH' || method === 'GCash_Scanned' || method === 'GCash_Direct') return 'gcash';
  if (method === 'VOUCHER' || method === 'Voucher') return 'voucher';
  return 'cash';
};

// Payment method as plain text (UI rule: no colour coding); the label tells them apart.
const PAYMENT_STYLES: Record<PaymentKind, { label: string; text: string }> = {
  cash: { label: 'Cash', text: 'text-slate-300 admin-light:text-slate-700' },
  gcash: { label: 'GCash', text: 'text-slate-300 admin-light:text-slate-700' },
  voucher: { label: 'Voucher', text: 'text-slate-300 admin-light:text-slate-700' },
};

// The remittances endpoint caps per_page at 100 server-side (see
// AdminController::remittances()) — this is the "complete history" the
// modal fetches, independent of whatever page/date filter is active on the
// table underneath it.
const CONDUCTOR_HISTORY_PAGE_SIZE = 100;
// Matches the per_page the receipts module already requests against this
// same endpoint — comfortably covers every PAID transaction across a
// conductor's fetched shifts in one batched call.
const TRANSACTIONS_BATCH_PAGE_SIZE = 500;

// Ledger columns: shift · driver & time · GCash · Cash · Total · status.
const LEDGER_COLUMNS = 'md:grid-cols-[minmax(0,1.35fr)_minmax(0,1.35fr)_repeat(3,minmax(0,0.8fr))_minmax(0,1fr)]';

// Shared surface classes.
const FIELD = 'bg-[#0E1628] admin-light:bg-white border border-[#2A3A55] admin-light:border-[#E2E8F0] rounded-md text-xs text-white admin-light:text-slate-900 focus:outline-none focus:border-[#62A0EA] admin-light:focus:border-[#1A5FB4]';
const PANEL = 'rounded-lg border border-[#2A3A55] admin-light:border-[#E2E8F0] overflow-y-auto scrollbar-themed';
const PAGE_BUTTON = 'p-1.5 rounded-md border border-[#2A3A55] admin-light:border-[#E2E8F0] text-slate-400 admin-light:text-slate-500 hover:bg-white/5 admin-light:hover:bg-[#F1F5F9] disabled:opacity-30 disabled:cursor-not-allowed transition-colors';

// ─── Props ─────────────────────────────────────────────────────────────
interface ConductorDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  record: RemittanceRecord | null;
}

function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  // Always shown (not just once there are multiple pages) so the modal's
  // footer stays consistent; prev/next disable when there's nowhere to go.
  return (
    <div className="flex items-center justify-between mt-3">
      <span className="text-xs text-slate-500 tabular-nums">Page {page} of {totalPages}</span>
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous page" onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1} className={PAGE_BUTTON}>
          <ChevronLeft size={16} />
        </button>
        <button type="button" aria-label="Next page" onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page === totalPages} className={PAGE_BUTTON}>
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

function PanelMessage({ loading, children }: { loading?: boolean; children: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-12 text-center">
      {loading
        ? <div className="w-7 h-7 border-2 border-[#62A0EA] admin-light:border-[#1A5FB4] border-t-transparent rounded-full animate-spin" />
        : <Banknote size={28} className="text-slate-600 admin-light:text-slate-400" />}
      <p className="text-sm text-slate-500">{children}</p>
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────
export function ConductorDetailModal({ isOpen, onClose, record }: ConductorDetailModalProps) {
  const [activeTab, setActiveTab] = useState<ModalTab>('remittance');
  const [expandedShift, setExpandedShift] = useState<string | null>(null);
  const [shiftTransactions, setShiftTransactions] = useState<Record<string, ApiTransaction[]>>({});
  const [isLoadingTxns, setIsLoadingTxns] = useState(false);
  const [remitFilter, setRemitFilter] = useState<RemitFilter>('All');
  const [remitSearch, setRemitSearch] = useState('');
  const [remitDate, setRemitDate] = useState('');
  const [remitPage, setRemitPage] = useState(1);
  const [txnPage, setTxnPage] = useState(1);

  // The conductor's complete record set, fetched fresh when the modal opens —
  // independent of the table's active date filter/pagination, which only
  // ever holds a slice of the conductor's real history.
  const [conductorRecords, setConductorRecords] = useState<RemittanceRecord[]>([]);
  const [conductorRecordsTotal, setConductorRecordsTotal] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  useEffect(() => {
    if (!record || !isOpen) {
      setConductorRecords([]);
      setConductorRecordsTotal(0);
      setShiftTransactions({});
      setActiveTab('remittance');
      setExpandedShift(null);
      setRemitFilter('All');
      setRemitSearch('');
      setRemitDate('');
      setRemitPage(1);
      setTxnPage(1);
      return;
    }

    let cancelled = false;
    setIsLoadingHistory(true);
    setIsLoadingTxns(true);

    fetchRemittances(1, '', '', 'All', '', record.conductorName, '', CONDUCTOR_HISTORY_PAGE_SIZE)
      .then(({ records, total }) => {
        if (cancelled) return;
        setConductorRecords(records);
        setConductorRecordsTotal(total);
        setIsLoadingHistory(false);

        const shiftIds = records.map(r => r.shiftId);
        if (shiftIds.length === 0) {
          setShiftTransactions({});
          setIsLoadingTxns(false);
          return;
        }

        // One batched request (shift_id as a comma-separated list) instead of
        // one fetch per shift.
        return fetch(
          `/api/admin/transactions?shift_id=${encodeURIComponent(shiftIds.join(','))}&per_page=${TRANSACTIONS_BATCH_PAGE_SIZE}`,
          { headers: { Accept: 'application/json' } }
        )
          .then(res => res.json())
          .then(json => {
            if (cancelled) return;
            // The proxy returns Laravel's paginator, so the transaction array
            // is nested at json.data.data (json.data is the paginator object).
            const rows = (json.data?.data ?? json.data ?? []) as ApiTransaction[];
            // Only PAID transactions actually count toward a shift's cash/GCash
            // totals. The admin transactions endpoint returns every transaction
            // (including PENDING/EXPIRED/FAILED GCash attempts that were never
            // collected), so filter to PAID here — otherwise the list shows
            // fares that legitimately don't appear in the totals.
            const map: Record<string, ApiTransaction[]> = {};
            for (const shiftId of shiftIds) map[shiftId] = [];
            for (const txn of rows) {
              if (txn.status !== 'PAID') continue;
              (map[txn.shift_id] ??= []).push(txn);
            }
            setShiftTransactions(map);
          });
      })
      .catch(() => {
        if (cancelled) return;
        setConductorRecords([]);
        setConductorRecordsTotal(0);
        setShiftTransactions({});
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoadingHistory(false);
        setIsLoadingTxns(false);
      });

    return () => {
      cancelled = true;
    };
  }, [record, isOpen]);

  if (!record) return null;

  const totalPending = conductorRecords
    .filter(r => PENDING_STATUSES.includes(r.remittanceStatus))
    .reduce((s, r) => s + r.gcashTotal + r.cashTotal, 0);

  // ─── Remittance History: filter + paginate ───────────────────────────
  // The status filter was compared to the raw status before, so "Remitted"
  // (no record has that status) always came back empty and "Pending" missed
  // Overdue / For Cash Declaration shifts. It now matches status groups.
  const search = remitSearch.trim().toLowerCase();
  const filteredRecords = conductorRecords.filter(r => {
    const matchesStatus = remitFilter === 'All'
      || (remitFilter === 'Remitted' && REMITTED_STATUSES.includes(r.remittanceStatus))
      || (remitFilter === 'Pending' && PENDING_STATUSES.includes(r.remittanceStatus));
    const matchesSearch = !search || r.shiftId.toLowerCase().includes(search);
    const matchesDate = !remitDate || r.date === remitDate;
    return matchesStatus && matchesSearch && matchesDate;
  });
  const remitTotalPages = Math.max(1, Math.ceil(filteredRecords.length / REMIT_PAGE_SIZE));
  const safeRemitPage = Math.min(remitPage, remitTotalPages);
  const pagedRecords = filteredRecords.slice(
    (safeRemitPage - 1) * REMIT_PAGE_SIZE,
    safeRemitPage * REMIT_PAGE_SIZE
  );
  const applyRemitFilter = (f: RemitFilter) => { setRemitFilter(f); setRemitPage(1); };

  // ─── Transactions: paginate the shift list (same page size as Remittance
  // History, for consistency) ────────────────────────────────────────────
  const txnTotalPages = Math.max(1, Math.ceil(conductorRecords.length / REMIT_PAGE_SIZE));
  const safeTxnPage = Math.min(txnPage, txnTotalPages);
  const pagedTxnRecords = conductorRecords.slice(
    (safeTxnPage - 1) * REMIT_PAGE_SIZE,
    safeTxnPage * REMIT_PAGE_SIZE
  );

  // Per-shift Cash/GCash/Voucher breakdown, shown in the collapsed row so an
  // admin doesn't have to expand every shift just to see the payment mix.
  const countByMethod = (txns: ApiTransaction[]) => {
    const counts: Record<PaymentKind, number> = { cash: 0, gcash: 0, voucher: 0 };
    for (const txn of txns) counts[paymentKind(txn.payment_method)]++;
    return counts;
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="max-w-5xl" rounded="rounded-xl" adminThemed>
      {/* ── Header: who, and what they still owe ── */}
      <header className="flex flex-col gap-5 pr-8 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-[#2A3A55] admin-light:border-[#E2E8F0] bg-[#131C2E] admin-light:bg-[#F1F5F9] text-base font-semibold text-slate-200 admin-light:text-slate-700">
            {getInitials(record.conductorName)}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold text-white admin-light:text-slate-900">{record.conductorName}</h2>
            <p className="text-sm text-slate-400 admin-light:text-slate-500">Conductor <span aria-hidden="true">·</span> {record.unitNumber}</p>
          </div>
        </div>
        <dl className="grid grid-cols-2 divide-x divide-[#2A3A55] admin-light:divide-[#E2E8F0]">
          <div className="pr-6">
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">Shifts</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-white admin-light:text-slate-900">
              {conductorRecords.length}
              {conductorRecordsTotal > conductorRecords.length && (
                <span className="text-sm font-normal text-slate-500"> of {conductorRecordsTotal}</span>
              )}
            </dd>
          </div>
          <div className="pl-6">
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">Pending remittance</dt>
            <dd className={`mt-1 text-xl font-semibold tabular-nums text-white admin-light:text-slate-900`}>
              {fmt(totalPending)}
            </dd>
          </div>
        </dl>
      </header>

      <PageTabs tabs={TABS} activeId={activeTab} onChange={setActiveTab} className="mt-6 mb-4" />

      {activeTab === 'remittance' && (
        <div role="tabpanel">
          {/* Toolbar: search sized to a shift ID, then date and status. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={remitSearch}
                onChange={(e) => { setRemitSearch(e.target.value); setRemitPage(1); }}
                placeholder="Search Shift ID…"
                aria-label="Search by shift ID"
                className={`w-full pl-9 pr-8 py-2 placeholder:text-slate-500 ${FIELD}`}
              />
              {remitSearch && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => { setRemitSearch(''); setRemitPage(1); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 admin-light:hover:text-slate-700"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <AdminDatePicker
              accent="blue"
              popover
              yearNavigation
              ariaLabel="Filter shifts by date"
              value={remitDate}
              onChange={(next) => { setRemitDate(next); setRemitPage(1); }}
              triggerClassName="w-full sm:w-44 py-2"
              className="w-full sm:w-44"
            />
            <div role="group" aria-label="Filter by status" className="inline-flex rounded-md border border-[#2A3A55] admin-light:border-[#E2E8F0] p-0.5">
              {REMIT_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={remitFilter === f}
                  onClick={() => applyRemitFilter(f)}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    remitFilter === f
                      ? 'bg-[#62A0EA] text-[#0B1120] admin-light:bg-[#1A5FB4] admin-light:text-white'
                      : 'text-slate-400 hover:text-white admin-light:text-slate-500 admin-light:hover:text-slate-900'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
            <span className="ml-auto text-xs text-slate-500 tabular-nums">{filteredRecords.length} shift{filteredRecords.length === 1 ? '' : 's'}</span>
          </div>

          {/* Ledger. Fixed height (not max-height) so the modal doesn't
              shrink when the last page has fewer than REMIT_PAGE_SIZE rows. */}
          <div className={`h-[46vh] ${PANEL}`}>
            {isLoadingHistory ? (
              <PanelMessage loading>Loading remittance history…</PanelMessage>
            ) : filteredRecords.length === 0 ? (
              <PanelMessage>No records found.</PanelMessage>
            ) : (
              <>
                <div className={`sticky top-0 z-10 hidden gap-4 border-b border-[#2A3A55] admin-light:border-[#E2E8F0] bg-[#1A2540] admin-light:bg-white px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-500 md:grid ${LEDGER_COLUMNS}`}>
                  <span>Shift</span>
                  <span>Driver &amp; time</span>
                  <span className="text-right">GCash</span>
                  <span className="text-right">Cash</span>
                  <span className="text-right">Total</span>
                  <span className="text-right">Status</span>
                </div>
                <ul className="divide-y divide-[#2A3A55] admin-light:divide-[#E2E8F0]">
                  {pagedRecords.map((rec) => (
                    <li key={rec.shiftId} className={`grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 md:items-center ${LEDGER_COLUMNS}`}>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white admin-light:text-slate-900" title={rec.shiftId}>{rec.shiftId}</p>
                        <p className="text-xs text-slate-500 tabular-nums">{rec.date}</p>
                      </div>
                      <div className="justify-self-end md:hidden">
                        <RemittanceStatusText status={rec.remittanceStatus} />
                      </div>
                      <div className="col-span-2 min-w-0 md:col-span-1">
                        <p className="truncate text-xs text-slate-300 admin-light:text-slate-700">{rec.driverName || '—'}</p>
                        <p className="text-xs text-slate-500 tabular-nums">
                          {hhmm(rec.timeIn)} → {hhmm(rec.timeOut)}
                        </p>
                      </div>
                      <div className="col-span-2 grid grid-cols-3 gap-4 md:contents">
                        <div className="md:text-right">
                          <p className="text-[10px] uppercase text-slate-500 md:hidden">GCash</p>
                          <p className="text-sm tabular-nums text-slate-200 admin-light:text-slate-800">{fmt(rec.gcashTotal)}</p>
                        </div>
                        <div className="md:text-right">
                          <p className="text-[10px] uppercase text-slate-500 md:hidden">Cash</p>
                          <p className="text-sm tabular-nums text-slate-200 admin-light:text-slate-800">{fmt(rec.cashTotal)}</p>
                        </div>
                        <div className="md:text-right">
                          <p className="text-[10px] uppercase text-slate-500 md:hidden">Total</p>
                          <p className="text-sm font-semibold tabular-nums text-white admin-light:text-slate-900">{fmt(rec.gcashTotal + rec.cashTotal)}</p>
                        </div>
                      </div>
                      <div className="hidden text-right md:block">
                        <RemittanceStatusText status={rec.remittanceStatus} />
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <Pagination page={safeRemitPage} totalPages={remitTotalPages} onChange={setRemitPage} />
        </div>
      )}

      {activeTab === 'transactions' && (
        <div role="tabpanel">
          {/* Same height as the history ledger plus its toolbar, so switching
              tabs doesn't resize the modal. */}
          <div className={`h-[calc(46vh+3.25rem)] ${PANEL}`}>
            {isLoadingTxns ? (
              <PanelMessage loading>Loading transactions…</PanelMessage>
            ) : conductorRecords.length === 0 ? (
              <PanelMessage>No shift records found.</PanelMessage>
            ) : (
              <ul className="divide-y divide-[#2A3A55] admin-light:divide-[#E2E8F0]">
                {pagedTxnRecords.map((rec) => {
                  const isExp = expandedShift === rec.shiftId;
                  const txns = shiftTransactions[rec.shiftId] || [];
                  const counts = countByMethod(txns);
                  const collected = txns.reduce((sum, txn) => sum + Number(txn.final_amount), 0);
                  return (
                    <li key={rec.shiftId}>
                      <button
                        type="button"
                        aria-expanded={isExp}
                        onClick={() => setExpandedShift(isExp ? null : rec.shiftId)}
                        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/3 admin-light:hover:bg-[#F8FAFC]"
                      >
                        <ChevronRight size={16} aria-hidden="true" className={`text-slate-500 transition-transform ${isExp ? 'rotate-90' : ''}`} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white admin-light:text-slate-900">{rec.shiftId}</p>
                          <p className="text-xs text-slate-500 tabular-nums">
                            {formatLogTime(rec.timeIn)}{rec.timeOut ? ` → ${hhmm(rec.timeOut)}` : ' (active)'}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold tabular-nums text-white admin-light:text-slate-900">{formatPeso(collected)}</p>
                          <p className="text-[11px] tabular-nums text-slate-500">
                            {txns.length} fare{txns.length === 1 ? '' : 's'}
                            {(Object.keys(counts) as PaymentKind[]).filter((kind) => counts[kind] > 0).map((kind) => (
                              <span key={kind} className={PAYMENT_STYLES[kind].text}> · {counts[kind]} {PAYMENT_STYLES[kind].label}</span>
                            ))}
                          </p>
                        </div>
                      </button>
                      {isExp && (
                        txns.length === 0 ? (
                          <p className="border-t border-[#2A3A55] admin-light:border-[#E2E8F0] py-4 text-center text-xs text-slate-500">No transactions.</p>
                        ) : (
                          <ol className="divide-y divide-[#2A3A55] admin-light:divide-[#E2E8F0] border-t border-[#2A3A55] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-[#F8FAFC]">
                            {txns.map((txn) => {
                              const style = PAYMENT_STYLES[paymentKind(txn.payment_method)];
                              const pax = txn.total_passengers ?? 1;
                              return (
                                <li key={txn.transaction_id} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-start gap-3 py-2.5 pl-11 pr-4">
                                  <span className={`pt-0.5 text-xs font-semibold ${style.text}`}>{style.label}</span>
                                  <div className="min-w-0">
                                    <p className="truncate text-sm text-white admin-light:text-slate-900">
                                      {txn.payment_method === 'GCASH'
                                        ? txn.payer_name_snapshot || txn.payer_name || txn.passenger_name || 'GCash Payer'
                                        : txn.passenger_name || 'Cash Passenger'}
                                    </p>
                                    <p className="flex items-center gap-1 truncate text-xs text-slate-500">
                                      <MapPin size={10} aria-hidden="true" />
                                      {txn.pickup_name || '—'} → {txn.dropoff_name || '—'}
                                    </p>
                                    <p className="truncate text-[10px] text-slate-500">
                                      {pax} passenger{pax === 1 ? '' : 's'}
                                      {txn.passenger_breakdown?.length ? ` · ${txn.passenger_breakdown.map((line) => `${line.passenger_type} × ${line.quantity}`).join(', ')}` : ''}
                                    </p>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-sm font-medium tabular-nums text-white admin-light:text-slate-900">{formatPeso(Number(txn.final_amount))}</p>
                                    <p className="text-[10px] tabular-nums text-slate-500">
                                      {new Date(txn.created_at).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', hour12: true })}
                                    </p>
                                  </div>
                                </li>
                              );
                            })}
                          </ol>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <Pagination page={safeTxnPage} totalPages={txnTotalPages} onChange={setTxnPage} />
        </div>
      )}
    </Modal>
  );
}
