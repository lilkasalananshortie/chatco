// app/(admin)/receipts/data/receipt-status.ts
//
// Single source of truth for how a receipt's payment status is presented.
// Payment methods are plain neutral text with an icon (receipts-ledger.tsx).
//
// This used to live inline in the receipts column renderer, with a `default:`
// arm that rendered a green "Completed" badge. That made any status the
// frontend didn't recognise — including a null/missing one — look like a
// settled payment. For a financial record the fail-safe must be the other
// way round: if we don't know, we say we don't know.

import type { BadgeVariant } from '@/components/shared/badge';
import type { ReceiptStatus } from './receipts-data';

/**
 * Badge colour per status.
 *
 * Grouping rationale (mirrors backend App\Enums\PaymentStatus):
 *   success  — money settled.
 *   warning  — still in flight; the row may still change on its own.
 *   danger   — terminal, no money moved. Expired belongs here, NOT with
 *              Pending: an expired QR is dead, and colouring it the same
 *              yellow as Pending made admins read it as "still processing".
 *   neutral  — unrecognised. See statusBadge() below.
 *
 * Refunded is neutral because the payment was returned and is no longer fare
 * revenue, while remaining an explicit provider-audited state.
 */
const STATUS_VARIANTS: Record<ReceiptStatus, BadgeVariant> = {
  Completed: 'success',
  Pending: 'warning',
  Failed: 'danger',
  Cancelled: 'danger',
  Expired: 'danger',
  Refunded: 'neutral',
  Unknown: 'neutral',
};

/**
 * Resolve a status to its label + badge variant. Anything not in the map —
 * a new backend enum case, a null column, a malformed payload — resolves to
 * a neutral "Unknown" badge rather than silently reading as paid.
 */
export function statusBadge(status: string): { label: string; variant: BadgeVariant } {
  const variant = STATUS_VARIANTS[status as ReceiptStatus];
  return variant
    ? { label: status, variant }
    : { label: 'Unknown', variant: 'neutral' };
}
