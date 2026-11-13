import { AlertTriangle, CheckCircle2, Clock3, type LucideIcon } from 'lucide-react';
import type { RemittanceStatus } from '@/types';
import type { BadgeVariant } from '@/components/shared/badge';
import { remittanceStatusVariant } from '@/lib/shared/remittance-status';

/**
 * Text colour per status variant — dark and admin light mode. Only a money
 * problem (shortage/overage) is red; every other status is plain white text.
 * Also used for the summary cards and the table's difference amounts.
 */
export const STATUS_TEXT_CLASSES: Record<BadgeVariant, string> = {
  success: 'text-slate-200 admin-light:text-slate-800',
  warning: 'text-slate-200 admin-light:text-slate-800',
  danger: 'text-red-400 admin-light:text-red-600',
  info: 'text-slate-200 admin-light:text-slate-800',
  neutral: 'text-slate-400 admin-light:text-slate-600',
};

/** The icon carries the meaning the colour used to; For Cash Declaration has none. */
const STATUS_ICONS: Partial<Record<BadgeVariant, LucideIcon>> = {
  success: CheckCircle2,
  warning: Clock3,
  danger: AlertTriangle,
};

/**
 * Remittance status as text with a leading icon, not a pill — the same
 * treatment as vehicle status in Fleet Management.
 */
export function RemittanceStatusText({ status }: { status: RemittanceStatus }) {
  const variant = remittanceStatusVariant(status);
  const Icon = STATUS_ICONS[variant];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${STATUS_TEXT_CLASSES[variant]}`}>
      {Icon && <Icon size={14} aria-hidden="true" className={`shrink-0 ${variant === 'danger' ? '' : 'text-slate-400 admin-light:text-slate-500'}`} />}
      {status}
    </span>
  );
}
