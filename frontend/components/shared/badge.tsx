// components/shared/badge.tsx
// Extracted from admin/ui/badge.tsx — shared across admin & conductor.

import { ReactNode } from 'react';
import { CheckCircle2, XCircle, type LucideIcon } from 'lucide-react';

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

interface BadgeProps {
  children: ReactNode;
  variant: BadgeVariant;
}

// Plain text, no pill or tinted fill. Only a finished state (green) and a
// terminal one (red) get a colour and an icon; the rest read as neutral text.
// `neutral` stays muted: it is also the fallback for values the UI doesn't
// recognise, which must never look like success (see receipt-status.ts).
const VARIANT_STYLES: Record<BadgeVariant, { text: string; icon?: LucideIcon }> = {
  success: { text: 'text-emerald-400 admin-light:text-emerald-700', icon: CheckCircle2 },
  danger: { text: 'text-red-400 admin-light:text-red-600', icon: XCircle },
  warning: { text: 'text-slate-200 admin-light:text-slate-800' },
  info: { text: 'text-slate-200 admin-light:text-slate-800' },
  neutral: { text: 'text-slate-400 admin-light:text-slate-500' },
};

export function Badge({ children, variant }: BadgeProps) {
  const { text, icon: Icon } = VARIANT_STYLES[variant];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${text}`}>
      {Icon && <Icon size={14} aria-hidden="true" className="shrink-0" />}
      {children}
    </span>
  );
}
