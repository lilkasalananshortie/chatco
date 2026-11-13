// components/admin/receipts/receipts-ledger.tsx
'use client';

import { Banknote, Ticket, Wallet, type LucideIcon } from 'lucide-react';
import type { Receipt } from '@/app/(admin)/receipts/data/receipts-data';
import { statusBadge } from '@/app/(admin)/receipts/data/receipt-status';
import { Badge } from '@/components/admin/ui/badge';
import { formatPeso } from '@/lib/utils/display';

// One neutral tone for every method; the icon tells them apart.
const METHOD_ICON: Partial<Record<Receipt['paymentMethod'], LucideIcon>> = { Cash: Banknote, Gcash: Wallet, Voucher: Ticket };
const METHOD_LABEL: Partial<Record<Receipt['paymentMethod'], string>> = { Gcash: 'GCash' };

export interface DayStats {
  count: number;
  settledTotal: number;
}

/** "2026-10-19" (local, as receipts-data builds it) → "Mon, Oct 19, 2026". */
function formatDay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate || 'Unknown date';
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** Consecutive receipts on the same date, in the order they arrive. */
function groupByDay(rows: Receipt[]): { date: string; rows: Receipt[] }[] {
  const groups: { date: string; rows: Receipt[] }[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.date === row.date) last.rows.push(row);
    else groups.push({ date: row.date, rows: [row] });
  }
  return groups;
}

function rider(receipt: Receipt): string {
  const named = receipt.commuterName && receipt.commuterName !== 'Passenger' ? `${receipt.commuterName} · ` : '';
  return `${named}${receipt.commuterRole}`;
}

function receiptTitle(receipt: Receipt): string {
  return receipt.multiplePaymentReference ? `${receipt.id}\nGroup payment ${receipt.multiplePaymentReference}` : receipt.id;
}

function DayHeading({ date, stats }: { date: string; stats?: DayStats }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span className="text-xs font-semibold uppercase tracking-widest text-slate-300 admin-light:text-slate-700">{formatDay(date)}</span>
      {stats && (
        <span className="text-xs text-slate-400 admin-light:text-slate-500">
          {stats.count} {stats.count === 1 ? 'receipt' : 'receipts'} · <span className="font-semibold tabular-nums text-slate-200 admin-light:text-slate-800">{formatPeso(stats.settledTotal)}</span> settled
        </span>
      )}
    </div>
  );
}

function Status({ receipt }: { receipt: Receipt }) {
  const { label, variant } = statusBadge(receipt.status);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Badge variant={variant}>{label}</Badge>
      {receipt.reconciliationStatus === 'REFUND_REQUIRED' && (
        <span className="truncate font-semibold text-amber-300 admin-light:text-amber-700" title={receipt.reconciliationReason ?? undefined}>· Refund required</span>
      )}
    </span>
  );
}

function voucherTitle(voucher: NonNullable<Receipt['voucher']>): string {
  return `Voucher ${voucher.code} · ${voucher.description}`;
}

/**
 * The method that settled the fare, plus a "+ Voucher" line when a voucher
 * was applied too (a discount voucher leaves the method Cash/GCash). A
 * Voucher-method row is already labelled, so it only gains the code on hover.
 */
function Payment({ receipt }: { receipt: Receipt }) {
  const { paymentMethod: method, voucher } = receipt;
  const Icon = METHOD_ICON[method];
  return (
    <span className="inline-flex min-w-0 flex-col gap-0.5">
      <span
        className="inline-flex items-center gap-1.5 text-slate-300 admin-light:text-slate-700"
        title={method === 'Voucher' && voucher ? voucherTitle(voucher) : undefined}
      >
        {Icon && <Icon size={14} aria-hidden="true" className="shrink-0 text-slate-500" />}
        {METHOD_LABEL[method] ?? method}
      </span>
      {voucher && method !== 'Voucher' && (
        <span className="inline-flex items-center gap-1 text-xs text-slate-400 admin-light:text-slate-500" title={voucherTitle(voucher)}>
          <Ticket size={12} aria-hidden="true" className="shrink-0 text-slate-500" />
          + Voucher
        </span>
      )}
    </span>
  );
}

function Amount({ receipt }: { receipt: Receipt }) {
  const discountTitle = `${formatPeso(receipt.grossFare)} less ${formatPeso(receipt.discountAmount)} discount${
    receipt.voucher ? ` (includes voucher ${receipt.voucher.code}, ${receipt.voucher.description})` : ''
  }`;
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className="font-semibold text-white admin-light:text-slate-900">{formatPeso(receipt.fare)}</span>
      {receipt.discountAmount > 0 && (
        <span className="ml-1.5 text-xs text-slate-400 admin-light:text-slate-500" title={discountTitle}>
          −{formatPeso(receipt.discountAmount)}
        </span>
      )}
    </span>
  );
}

/**
 * Fare receipts as a calm ledger: one line per receipt under day headings
 * that carry the day's count and settled total. The amount is the strongest
 * text; colour is reserved for the status dot and a refund flag.
 *
 * Day totals come from `dayStats` (the whole filtered set, settled receipts
 * only — same rule as the page summary), not just the rows on this page.
 */
export function ReceiptsLedger({ rows, dayStats, emptyMessage }: { rows: Receipt[]; dayStats: Map<string, DayStats>; emptyMessage: string }) {
  if (rows.length === 0) {
    return <div className="flex h-full min-h-48 items-center justify-center px-4 text-center text-sm text-slate-400 admin-light:text-slate-500">{emptyMessage}</div>;
  }

  const groups = groupByDay(rows);
  const th = 'px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 admin-light:text-slate-500';
  const td = 'px-3 py-3 align-middle';

  return (
    <>
      {/* Desktop / tablet: a real table. */}
      <div className="hidden h-full overflow-auto scrollbar-themed sm:block">
        <table className="w-full min-w-[760px] table-fixed border-separate border-spacing-0 text-sm">
          <colgroup>
            <col className="w-24" />
            <col className="w-36" />
            <col className="w-[15%]" />
            <col className="w-28" />
            <col />
            <col className="w-40" />
            <col className="w-[14%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-[#0B1220] admin-light:bg-white">
            <tr>
              <th scope="col" className={`${th} border-b border-[#1E2D45] admin-light:border-[#E2E8F0]`}>Time</th>
              <th scope="col" className={`${th} border-b border-[#1E2D45] text-right! admin-light:border-[#E2E8F0]`}>Amount</th>
              <th scope="col" className={`${th} border-b border-[#1E2D45] admin-light:border-[#E2E8F0]`}>Fare type</th>
              <th scope="col" className={`${th} border-b border-[#1E2D45] admin-light:border-[#E2E8F0]`}>Payment</th>
              <th scope="col" className={`${th} border-b border-[#1E2D45] admin-light:border-[#E2E8F0]`}>Unit · route</th>
              <th scope="col" className={`${th} border-b border-[#1E2D45] admin-light:border-[#E2E8F0]`}>Status</th>
              <th scope="col" className={`${th} border-b border-[#1E2D45] admin-light:border-[#E2E8F0]`}>Receipt</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.date}>
              <tr>
                <th scope="rowgroup" colSpan={7} className="border-b border-[#1E2D45] bg-[#0E1628] px-3 py-2.5 text-left font-normal admin-light:border-[#E2E8F0] admin-light:bg-[#F8FAFC]">
                  <DayHeading date={group.date} stats={dayStats.get(group.date)} />
                </th>
              </tr>
              {group.rows.map((receipt) => (
                <tr key={`${receipt.id}-${receipt.time}`} className="transition-colors hover:bg-[#111A2B] admin-light:hover:bg-[#F8FAFC]">
                  <td className={`${td} border-b border-[#162033] whitespace-nowrap tabular-nums text-slate-300 admin-light:border-[#EEF2F7] admin-light:text-slate-700`}>{receipt.time}</td>
                  <td className={`${td} border-b border-[#162033] text-right admin-light:border-[#EEF2F7]`}><Amount receipt={receipt} /></td>
                  <td className={`${td} border-b border-[#162033] truncate text-slate-300 admin-light:border-[#EEF2F7] admin-light:text-slate-700`} title={receipt.paidBy ? `${rider(receipt)} · paid by ${receipt.paidBy}` : rider(receipt)}>
                    {rider(receipt)}
                    {receipt.paidBy && <span className="text-slate-500"> · paid by {receipt.paidBy}</span>}
                  </td>
                  <td className={`${td} border-b border-[#162033] admin-light:border-[#EEF2F7]`}><Payment receipt={receipt} /></td>
                  <td className={`${td} border-b border-[#162033] truncate admin-light:border-[#EEF2F7]`} title={`${receipt.plateNumber} · ${receipt.route}`}>
                    <span className="font-medium text-slate-200 admin-light:text-slate-800">{receipt.plateNumber}</span>
                    <span className="text-slate-400 admin-light:text-slate-500"> · {receipt.route}</span>
                  </td>
                  <td className={`${td} border-b border-[#162033] admin-light:border-[#EEF2F7]`}><Status receipt={receipt} /></td>
                  <td className={`${td} border-b border-[#162033] truncate font-mono text-xs text-slate-500 admin-light:border-[#EEF2F7]`} title={receiptTitle(receipt)}>
                    {receipt.id}
                    {receipt.multiplePaymentReference && <span className="font-sans"> · group</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      {/* Phones: the same ledger as stacked lines under the same day headings. */}
      <div className="h-full overflow-y-auto scrollbar-themed sm:hidden">
        {groups.map((group) => (
          <section key={group.date} aria-label={formatDay(group.date)}>
            <div className="border-b border-[#1E2D45] bg-[#0E1628] px-3 py-2.5 admin-light:border-[#E2E8F0] admin-light:bg-[#F8FAFC]">
              <DayHeading date={group.date} stats={dayStats.get(group.date)} />
            </div>
            <ul>
              {group.rows.map((receipt) => (
                <li key={`${receipt.id}-${receipt.time}`} className="space-y-1 border-b border-[#162033] px-3 py-3 text-sm admin-light:border-[#EEF2F7]">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="tabular-nums text-slate-300 admin-light:text-slate-700">{receipt.time}</span>
                    <Amount receipt={receipt} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="text-slate-300 admin-light:text-slate-700">{rider(receipt)}</span>
                    <Payment receipt={receipt} />
                    <Status receipt={receipt} />
                  </div>
                  <p className="truncate text-xs text-slate-400 admin-light:text-slate-500" title={receipt.route}>
                    <span className="font-medium text-slate-300 admin-light:text-slate-700">{receipt.plateNumber}</span> · {receipt.route}
                  </p>
                  <p className="truncate font-mono text-[11px] text-slate-500" title={receiptTitle(receipt)}>
                    {receipt.id}{receipt.multiplePaymentReference ? ` · ${receipt.multiplePaymentReference}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
