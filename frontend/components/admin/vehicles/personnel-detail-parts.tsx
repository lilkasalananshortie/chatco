// components/admin/vehicles/personnel-detail-parts.tsx
'use client';

// Presentational pieces shared by the Driver and Conductor detail modals
// (Fleet Management > Personnel). Data fetching stays in each modal; these
// only lay it out, so the two views can't drift apart.

import type { ReactNode, Ref } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { UserAvatar } from '@/components/admin/ui/user-avatar';

export type PersonnelRole = 'Driver' | 'Conductor';

// Role colour, same blue/amber split as the Personnel table's role indicator.
const ROLE_STYLES: Record<PersonnelRole, { text: string }> = {
  Driver: {
    text: 'text-[#62A0EA] admin-light:text-[#1A5FB4]',
  },
  Conductor: {
    text: 'text-amber-400 admin-light:text-amber-700',
  },
};

const HAIRLINE = 'border-[#1E2D45] admin-light:border-[#E2E8F0]';
const DIVIDE = 'divide-[#1E2D45] admin-light:divide-[#E2E8F0]';

export function calculateAge(birthday: string | null): string {
  if (!birthday) return '—';
  try {
    const birth = new Date(birthday);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const m = today.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
    return `${age} years old`;
  } catch {
    return '—';
  }
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: '2-digit' });
  } catch {
    return dateStr;
  }
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return dateStr;
  }
}

/** ACTIVE reads as active; a disabled/deactivated account matches the
 *  Personnel table's quiet slate treatment; anything else stays neutral. */
function StatusText({ status }: { status: string | null }) {
  if (!status) return null;
  const isActive = status === 'ACTIVE';
  const isOff = status === 'DISABLED' || status === 'DEACTIVATED';
  const label = isActive ? 'Active' : isOff ? 'Deactivated' : status.charAt(0) + status.slice(1).toLowerCase();
  return (
    <span className={`inline-flex items-center gap-1.5 ${isActive ? 'text-slate-200 admin-light:text-slate-800' : 'text-slate-400 admin-light:text-slate-500'}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? 'bg-slate-300 admin-light:bg-slate-600' : 'bg-slate-600 admin-light:bg-slate-300'}`} />
      {label}
    </span>
  );
}

interface PersonnelHeaderProps {
  role: PersonnelRole;
  id: string;
  name: string;
  photoUrl: string | null;
  /** Null while the record is still loading. */
  status: string | null;
  vehicle: { unit_number: string; plate_number: string } | null;
  partnerName: string | null;
  isLoaded: boolean;
}

/**
 * Who the person is on the left; what they're running today (unit and
 * partner) as figures on the right, the answer most admins open this for.
 */
export function PersonnelHeader({ role, id, name, photoUrl, status, vehicle, partnerName, isLoaded }: PersonnelHeaderProps) {
  const roleStyle = ROLE_STYLES[role];
  const placeholder = isLoaded ? 'None' : '—';
  return (
    <header className="flex flex-col gap-5 pr-8 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 items-center gap-4">
        <UserAvatar src={photoUrl} alt={`Profile photo of ${name}`} className="h-14 w-14" iconClassName="h-6 w-6" sizes="56px" />
        <div className="min-w-0">
          <h2 className="truncate text-xl font-bold text-white admin-light:text-slate-900">{name}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm">
            <span className={`font-medium ${roleStyle.text}`}>{role}</span>
            {status && <span aria-hidden="true" className="text-slate-600 admin-light:text-slate-300">·</span>}
            <StatusText status={status} />
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-slate-500 admin-light:text-slate-400" title={id}>ID {id.slice(0, 8)}</p>
        </div>
      </div>

      <dl className={`grid shrink-0 grid-cols-2 divide-x ${DIVIDE}`}>
        <div className="pr-6">
          <dt className="text-[10px] uppercase tracking-wider text-slate-500">Current unit</dt>
          <dd className="mt-1">
            {vehicle ? (
              <>
                <p className="text-lg font-semibold text-white admin-light:text-slate-900">{vehicle.unit_number}</p>
                <p className="font-mono text-xs text-slate-500">{vehicle.plate_number}</p>
              </>
            ) : (
              <p className="text-sm italic text-slate-500">{isLoaded ? 'Unassigned' : '—'}</p>
            )}
          </dd>
        </div>
        <div className="min-w-0 pl-6">
          <dt className="text-[10px] uppercase tracking-wider text-slate-500">{role === 'Driver' ? 'Conductor partner' : 'Driver partner'}</dt>
          <dd className="mt-1 max-w-[12rem]">
            {partnerName ? (
              <p className="truncate text-sm font-medium text-white admin-light:text-slate-900" title={partnerName}>{partnerName}</p>
            ) : (
              <p className="text-sm italic text-slate-500">{placeholder}</p>
            )}
          </dd>
        </div>
      </dl>
    </header>
  );
}

/** A labelled group of label/value rows, separated by hairlines. */
export function DetailSection({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

export function DetailRow({ label, children, hint, mono = false }: { label: string; children: ReactNode; hint?: string; mono?: boolean }) {
  return (
    <div className={`grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 border-b py-2.5 last:border-b-0 ${HAIRLINE}`}>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="min-w-0">
        <p className={`break-words text-sm text-slate-200 admin-light:text-slate-800 ${mono ? 'font-mono' : ''}`}>{children}</p>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </dd>
    </div>
  );
}

/** Row placeholders while the record loads, in the same two-column shape. */
export function DetailSkeleton() {
  const rows = (count: number) =>
    [...Array(count)].map((_, i) => (
      <div key={i} className={`grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 border-b py-3.5 last:border-b-0 ${HAIRLINE}`}>
        <div className="h-3 w-20 rounded bg-[#1A2540] admin-light:bg-[#EEF2F7] animate-pulse" />
        <div className="h-3 w-40 max-w-full rounded bg-[#1A2540] admin-light:bg-[#EEF2F7] animate-pulse" />
      </div>
    ));
  return (
    <div className="grid grid-cols-1 gap-x-10 md:grid-cols-2">
      <div>{rows(6)}</div>
      <div>{rows(3)}</div>
    </div>
  );
}

/** Two-column body of the info tab, divided by a vertical hairline on md+. */
export function DetailColumns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className={`grid grid-cols-1 gap-y-6 md:grid-cols-2 md:divide-x ${DIVIDE}`}>
      <div className="min-w-0 md:pr-8">{left}</div>
      <div className="min-w-0 space-y-6 md:pl-8">{right}</div>
    </div>
  );
}

/**
 * Both tab bodies in one box. Personal Info stays in the flow (hidden, not
 * unmounted, while History is open), so it alone sets the modal's height;
 * History is laid over that same box and its ledger fills what's left. The
 * modal is as tall as the info it shows (no empty space below it), and
 * switching tabs neither resizes it nor moves the tab bar. The floor keeps
 * the ledger usable when the info is short.
 */
export function DetailTabPanels({ showHistory, info, history }: { showHistory: boolean; info: ReactNode; history: ReactNode }) {
  return (
    <div className="relative min-h-72">
      <div role="tabpanel" className={showHistory ? 'invisible' : undefined}>{info}</div>
      {showHistory && (
        <div role="tabpanel" className="absolute inset-0 flex flex-col">{history}</div>
      )}
    </div>
  );
}

export interface ShiftLedgerEntry {
  shift_id: string;
  unit_number: string | null;
  plate_number: string | null;
  time_in: string | null;
  time_out: string | null;
  status: string;
}

const LEDGER_COLUMNS = 'md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1fr)_5.5rem]';

interface ShiftLedgerProps<T extends ShiftLedgerEntry> {
  entries: T[];
  /** Third column: route for a driver, driver name for a conductor. */
  middleLabel: string;
  middleValue: (entry: T) => string | null;
  isFirstPageLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  emptyMessage: string;
  /** The ledger's own scroll area — the infinite-scroll observer's root. */
  listRef: Ref<HTMLDivElement>;
  sentinelRef: Ref<HTMLDivElement>;
}

/**
 * Assignment history as a ledger: one hairline-separated row per shift,
 * with a sticky column header on md+. It fills the History panel (sized by
 * the Personal Info tab, see DetailTabPanels) rather than its own content,
 * so the modal doesn't resize between loading, empty and filled states.
 */
export function ShiftLedger<T extends ShiftLedgerEntry>({
  entries, middleLabel, middleValue, isFirstPageLoading, isLoadingMore, hasMore, emptyMessage, listRef, sentinelRef,
}: ShiftLedgerProps<T>) {
  return (
    <div ref={listRef} className={`min-h-0 flex-1 overflow-y-auto rounded-lg border scrollbar-themed ${HAIRLINE}`}>
      {isFirstPageLoading ? (
        <div className="flex h-full items-center justify-center">
          <Loader2 size={20} className="animate-spin text-slate-500" aria-label="Loading assignment history" />
        </div>
      ) : entries.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <FileText size={28} className="text-slate-600 admin-light:text-slate-300" aria-hidden="true" />
          <p className="text-sm text-slate-500">{emptyMessage}</p>
        </div>
      ) : (
        <>
          <div className={`sticky top-0 z-10 hidden gap-4 border-b bg-[#1A2540] admin-light:bg-white px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-500 md:grid ${HAIRLINE} ${LEDGER_COLUMNS}`}>
            <span>Date</span>
            <span>Unit</span>
            <span>{middleLabel}</span>
            <span>Time in → out</span>
            <span className="text-right">Status</span>
          </div>
          <ul className={`divide-y ${DIVIDE}`}>
            {entries.map((entry) => {
              const isActive = entry.status === 'ACTIVE';
              return (
                <li key={entry.shift_id} className={`grid grid-cols-2 gap-x-4 gap-y-1 px-4 py-3 md:items-center ${LEDGER_COLUMNS}`}>
                  <p className="text-sm font-medium tabular-nums text-white admin-light:text-slate-900">{formatDate(entry.time_in)}</p>
                  <p className="text-right text-xs font-medium md:order-last">
                    <span className={isActive ? 'text-slate-200 admin-light:text-slate-800' : 'text-slate-400 admin-light:text-slate-500'}>
                      {isActive ? 'On shift' : 'Ended'}
                    </span>
                  </p>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-200 admin-light:text-slate-800">{entry.unit_number || '—'}</p>
                    <p className="font-mono text-xs text-slate-500">{entry.plate_number || '—'}</p>
                  </div>
                  <p className="min-w-0 truncate text-right text-sm text-slate-300 admin-light:text-slate-700 md:text-left">{middleValue(entry) || '—'}</p>
                  <p className="col-span-2 text-xs tabular-nums text-slate-400 admin-light:text-slate-500 md:col-span-1">
                    {formatTime(entry.time_in)} → {entry.time_out ? formatTime(entry.time_out) : isActive ? <span className="font-semibold text-slate-200 admin-light:text-slate-800">now</span> : '—'}
                  </p>
                </li>
              );
            })}
          </ul>
          {/* Infinite-scroll sentinel — fetches the next page only once this
              scrolls into view inside the ledger's own scroll area. */}
          {hasMore && (
            <div ref={sentinelRef} className="flex items-center justify-center py-3">
              {isLoadingMore && <Loader2 size={16} className="animate-spin text-slate-500" />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
