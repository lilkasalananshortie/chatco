// components/admin/lost-found/lost-found-grid.tsx
import { useEffect, useRef, type ReactNode } from 'react';
import {
  Archive,
  Check,
  CheckCircle2,
  Minus,
  Clock3,
  Eye,
  ListChecks,
  PackageSearch,
  Pencil,
  RotateCcw,
  UserRound,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { isItemEditable, type LostFoundItem } from '@/app/(admin)/lost-found/data/lost-found-data';

interface LostFoundGridProps {
  items: LostFoundItem[];
  claimSummaries?: Record<string, { total: number; pending: number; accepted: number; hasNewPending?: boolean }>;
  onViewClaims: (itemId: string) => void;
  onViewDetails: (itemId: string) => void;
  onEdit: (item: LostFoundItem) => void;
  onClose?: (itemId: string) => void;
  onReactivate?: (itemId: string) => void;
  isActing?: boolean;
  /** Expired tab: show a checkbox on each card for bulk reactivation. */
  selectable?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (itemId: string) => void;
}

/**
 * Admin checkbox: a real (visually hidden) input for keyboard/screen
 * readers, drawn as a small square in the admin tones. `indeterminate`
 * covers the "some on this page selected" state of a select-all box.
 */
export function SelectCheckbox({ checked, indeterminate = false, onChange, disabled, label, showLabel = false }: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
  showLabel?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  const marked = checked || indeterminate;

  return (
    <label className={`inline-flex items-center gap-2.5 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
      <input ref={inputRef} type="checkbox" checked={checked} onChange={onChange} disabled={disabled} aria-label={showLabel ? undefined : label} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-[#62A0EA] admin-light:peer-focus-visible:ring-[#1A5FB4] peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-[#0B1120] admin-light:peer-focus-visible:ring-offset-white ${
          marked ? 'border-[#62A0EA] admin-light:border-[#1A5FB4] bg-[#62A0EA] admin-light:bg-[#1A5FB4] text-[#0B1120] admin-light:text-white' : 'border-slate-500 admin-light:border-slate-400 bg-[#0B1120]/80 admin-light:bg-white/90'
        }`}
      >
        {checked ? <Check className="h-3 w-3" strokeWidth={3.5} /> : indeterminate ? <Minus className="h-3 w-3" strokeWidth={3.5} /> : null}
      </span>
      {showLabel && <span className="text-xs font-semibold text-slate-300 admin-light:text-slate-700">{label}</span>}
    </label>
  );
}

function formatPostedDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/** Status as plain text + icon (no pill); the icon tells states apart and only a rejection is red. */
const STATUS_TEXT = 'text-slate-200 admin-light:text-slate-800';
const STATUS_STYLES: Record<LostFoundItem['status'], { icon: LucideIcon; text: string }> = {
  Unmatched: { icon: Clock3, text: STATUS_TEXT },
  Claimed: { icon: UserRound, text: STATUS_TEXT },
  Released: { icon: CheckCircle2, text: STATUS_TEXT },
  Returned: { icon: CheckCircle2, text: STATUS_TEXT },
  Closed: { icon: CheckCircle2, text: STATUS_TEXT },
  Rejected: { icon: XCircle, text: 'text-red-300 admin-light:text-red-700' },
  Expired: { icon: Archive, text: STATUS_TEXT },
};
const FALLBACK_STATUS = { icon: Clock3, text: 'text-slate-400 admin-light:text-slate-500' };

function DetailField({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
      <dd className="mt-0.5 truncate text-xs text-slate-200 admin-light:text-slate-800" title={value}>{value}</dd>
    </div>
  );
}

function ActionButton({ onClick, label, className = '', children }: { onClick: () => void; label: string; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`relative inline-flex h-10 min-w-0 items-center justify-center gap-1.5 px-1 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#62A0EA]/60 admin-light:focus-visible:ring-[#1A5FB4]/60 active:bg-[#1A2540] admin-light:active:bg-[#EEF2F7] ${className}`}
    >
      {children}
    </button>
  );
}

export function LostFoundGrid({ items, claimSummaries = {}, onViewClaims, onViewDetails, onEdit, onClose, onReactivate, isActing, selectable = false, selectedIds, onToggleSelect }: LostFoundGridProps) {
  return (
    <>
      {items.map((item) => {
        const claimSummary = claimSummaries[item.id] ?? { total: 0, pending: 0, accepted: 0 };
        const hasNewClaims = Boolean(claimSummary.hasNewPending);
        const isClaimed = claimSummary.accepted > 0 || item.status === 'Released' || item.status === 'Closed';
        const status = STATUS_STYLES[item.status] ?? FALLBACK_STATUS;
        const StatusIcon = status.icon;
        const isSelected = selectable && Boolean(selectedIds?.has(item.id));

        return (
          <article
            key={item.id}
            className={`group relative flex min-h-full flex-col overflow-hidden rounded-lg border bg-[#131C2E] admin-light:bg-white transition-colors duration-200 ${
              isSelected ? 'border-[#62A0EA]/70 admin-light:border-[#1A5FB4]/70 ring-1 ring-[#62A0EA]/40 admin-light:ring-[#1A5FB4]/40' : 'border-[#1E2D45] admin-light:border-[#E2E8F0] hover:border-[#62A0EA]/40 admin-light:hover:border-[#1A5FB4]/40'
            }`}
          >
            {selectable && onToggleSelect && (
              // Sibling of the photo button (not inside it), so ticking the
              // box never opens the details view.
              <div className="absolute left-2 top-2 z-10 rounded-md bg-[#0B1120]/80 admin-light:bg-white/90 p-1.5 backdrop-blur-sm">
                <SelectCheckbox
                  checked={isSelected}
                  onChange={() => onToggleSelect(item.id)}
                  disabled={isActing}
                  label={`Select ${item.itemName}`}
                />
              </div>
            )}
            <button
              type="button"
              onClick={() => onViewDetails(item.id)}
              aria-label={`View details for ${item.itemName}`}
              className="relative aspect-4/3 w-full overflow-hidden border-b border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-[#F1F5F9] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#62A0EA]/60 admin-light:focus-visible:ring-[#1A5FB4]/60"
            >
              {item.imageUrl ? (
                <img
                  src={item.imageUrl}
                  alt={item.itemName}
                  className="h-full w-full object-cover opacity-90 transition-[transform,opacity] duration-500 ease-out group-hover:scale-[1.03] group-hover:opacity-100 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-slate-600 admin-light:text-slate-400">
                  <PackageSearch className="h-10 w-10" aria-hidden="true" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider">No photo yet</span>
                </div>
              )}
            </button>

            <div className="flex flex-1 flex-col p-3 sm:p-4">
              {/* Category and status share one quiet line above the title. */}
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-slate-500">{item.category}</span>
                <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold ${status.text}`}>
                  <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  {item.status}
                </span>
              </div>

              <button type="button" onClick={() => onViewDetails(item.id)} className="mt-1.5 block w-full text-left focus:outline-none focus-visible:underline">
                <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-white admin-light:text-slate-900 transition-colors group-hover:text-[#8CB9F0] admin-light:group-hover:text-[#1A5FB4] sm:line-clamp-1 sm:text-base">{item.itemName}</h3>
              </button>
              <p className="mt-1 hidden min-h-8 text-xs leading-4 text-slate-400 admin-light:text-slate-500 sm:line-clamp-2">{item.description}</p>

              <dl className="mt-3 grid grid-cols-1 gap-x-3 gap-y-2 border-t border-[#1E2D45] admin-light:border-[#E2E8F0] pt-3 sm:grid-cols-2">
                <DetailField label="Plate" value={item.plateNumber || 'Plate unavailable'} />
                <DetailField label="Est. time" value={item.estimatedTimeLost || 'Time unavailable'} className="hidden sm:block" />
                <DetailField label="Driver" value={item.driverName || 'Driver unavailable'} />
                <DetailField label="Conductor" value={item.conductorName || 'Conductor unavailable'} className="hidden sm:block" />
              </dl>

              <p className="mt-auto pt-3 text-[10px] text-slate-500">Posted {formatPostedDate(item.datePosted)}</p>

              {onClose && item.status === 'Released' && (
                <button
                  type="button"
                  onClick={() => onClose(item.id)}
                  disabled={isActing}
                  className="mt-3 inline-flex h-9 items-center justify-center gap-2 rounded-md bg-[#62A0EA] admin-light:bg-[#1A5FB4] px-3 text-xs font-semibold text-white transition-colors hover:bg-[#4A8BD4] admin-light:hover:bg-[#164A8F] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  Close after handover
                </button>
              )}

              {onReactivate && item.status === 'Expired' && (
                <button
                  type="button"
                  onClick={() => onReactivate(item.id)}
                  disabled={isActing}
                  className="mt-3 inline-flex h-9 items-center justify-center gap-2 rounded-md bg-[#62A0EA] admin-light:bg-[#1A5FB4] px-3 text-xs font-semibold text-white transition-colors hover:bg-[#4A8BD4] admin-light:hover:bg-[#164A8F] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  Reactivate item
                </button>
              )}
            </div>

            {/* Flat action strip, divided like a table's row actions rather
                than three separate boxed buttons. */}
            <div className="mt-auto grid grid-cols-3 divide-x divide-[#1E2D45] admin-light:divide-[#E2E8F0] border-t border-[#1E2D45] admin-light:border-[#E2E8F0]">
              <ActionButton onClick={() => onViewDetails(item.id)} label="View details" className="text-slate-300 admin-light:text-slate-700 hover:bg-[#1A2540] admin-light:hover:bg-[#EEF2F7] hover:text-white admin-light:hover:text-slate-900">
                <Eye className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Details</span>
              </ActionButton>
              <ActionButton
                onClick={() => onViewClaims(item.id)}
                label={`${isClaimed ? 'View claimed item' : 'View claims'}, ${claimSummary.total} claim${claimSummary.total === 1 ? '' : 's'}${hasNewClaims ? ', new claims' : ''}`}
                className={hasNewClaims
                  ? 'text-white admin-light:text-slate-900 hover:bg-[#1A2540] admin-light:hover:bg-[#EEF2F7]'
                  : 'text-slate-300 admin-light:text-slate-700 hover:bg-[#1A2540] admin-light:hover:bg-[#EEF2F7] hover:text-white admin-light:hover:text-slate-900'}
              >
                {isClaimed ? <UserRound className="h-4 w-4" aria-hidden="true" /> : <ListChecks className="h-4 w-4" aria-hidden="true" />}
                <span className="hidden sm:inline">{isClaimed ? 'Claimed' : 'Claims'}</span>
                <span className={`tabular-nums ${hasNewClaims ? 'text-[#FF6D3A]' : 'text-slate-500'}`}>{claimSummary.total}</span>
                {hasNewClaims && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#FF6D3A]" />}
              </ActionButton>
              {isItemEditable(item.status) && (
                <ActionButton onClick={() => onEdit(item)} label="Edit item" className="text-slate-300 admin-light:text-slate-700 hover:bg-[#1A2540] admin-light:hover:bg-[#EEF2F7] hover:text-white admin-light:hover:text-slate-900">
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Edit</span>
                </ActionButton>
              )}
            </div>
          </article>
        );
      })}
    </>
  );
}
