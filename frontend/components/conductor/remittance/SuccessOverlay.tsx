// app/components/conductor/remittance/SuccessOverlay.tsx
import { createPortal } from "react-dom";
import { CheckCircle2 } from "lucide-react";
import { fmt } from "@/app/(conductor)/conductor-dashboard/end-of-day/helpers";
import { APP_DIALOG as D } from "@/components/shared/app-dialog-styles";

interface SuccessOverlayProps {
  show: boolean;
  onClose: () => void;
  gcashTotal: number;
  cashTotal: number;
  grandTotal: number;
  unitNumber: string;
  /** Where the conductor goes next: login after today's shift, unit verification after an earlier one. */
  redirectLabel?: string;
}

export default function SuccessOverlay({ show, onClose, gcashTotal, cashTotal, grandTotal, unitNumber, redirectLabel = "login" }: SuccessOverlayProps) {
  // Guard: ensure numeric values even if undefined slips through
  const safeGcash = gcashTotal ?? 0;
  const safeCash = cashTotal ?? 0;
  const safeGrand = grandTotal ?? 0;

  if (!show) return null;

  // Payment methods are told apart by their labels only (UI rule: no colour coding).
  const rows = [
    { label: "GCash (digital)", value: safeGcash },
    { label: "Cash to hand over", value: safeCash },
  ];

  // Portaled to <body> for the same reason as ConfirmModal: inside the xl:+
  // End-of-Day popover a transformed ancestor would pin this fixed overlay to
  // the panel instead of the viewport. z-[110]: above the popover (z-[100]).
  return createPortal(
    <div className={`${D.overlay.replace("z-[100]", "z-[110]")} animate-fade-in`}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="eod-success-title" aria-describedby="eod-success-body" className={`${D.panel} max-w-sm p-5 sm:p-6`}>
        <div className="flex items-start gap-3">
          <CheckCircle2 size={32} aria-hidden="true" className={`shrink-0 animate-scale-in ${D.blueIcon}`} />
          <div className="min-w-0">
            <h2 id="eod-success-title" className={D.title}>Submitted to Admin</h2>
            <p className={`mt-1 text-sm leading-relaxed ${D.muted}`}>
              Report for <span className="font-semibold text-white light:text-gray-900">{unitNumber}</span> submitted successfully.
            </p>
          </div>
        </div>

        <dl className={`mt-5 divide-y border-y text-sm ${D.divide} ${D.hairline}`}>
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4 py-3">
              <dt className={D.muted}>{row.label}</dt>
              <dd className="font-semibold tabular-nums text-white light:text-gray-900">{fmt(row.value)}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-4 py-3">
            <dt className="font-semibold text-white light:text-gray-900">Total</dt>
            <dd className="text-lg font-bold tabular-nums text-white light:text-gray-900">{fmt(safeGrand)}</dd>
          </div>
        </dl>

        <p id="eod-success-body" className={`mt-4 text-xs leading-relaxed ${D.muted}`}>
          Hand the cash to the admin. They count it and record the cash declaration. Redirecting to {redirectLabel}…
        </p>
        <button type="button" onClick={onClose} autoFocus className={`${D.button} ${D.primary} mt-5 w-full`}>Done</button>
      </div>
    </div>,
    document.body
  );
}
