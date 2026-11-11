// components/conductor/remittance/OfficialReportModal.tsx
import { createPortal } from "react-dom";
import { type RemittanceRecord } from "@/lib/conductor/services/remittance.service";
import { formatTime } from "@/lib/conductor/services/shift.service";
import { FileText, X } from "lucide-react";
import { fmt, fmtDate, fmtDateTime } from "@/app/(conductor)/conductor-dashboard/end-of-day/helpers";
import { APP_DIALOG as D } from "@/components/shared/app-dialog-styles";

interface OfficialReportModalProps { show: boolean; onClose: () => void; activeReport: RemittanceRecord; route: string; }

/**
 * Grand total = GCash + cash. `cashlessBreakdown` / `totalCashless` are NOT
 * added on top: every GCASH payment is mapped to "GCash_Scanned"
 * (lib/conductor/server/mappers.ts), so they hold the same money as
 * `gcashTotal`, and adding them counted GCash twice. Prepaid and voucher no
 * longer exist as separate methods. Matches the end-of-day summary and the
 * admin remittance table (cash + GCash).
 */
function reportTotals(report: RemittanceRecord) {
  const gcashTotal = report.gcashTotal ?? 0;
  const cashTotal = report.cashTotal ?? 0;
  return { gcashTotal, cashTotal, grandTotal: gcashTotal + cashTotal };
}

/** Escape text before interpolating it into the print HTML string — this is written via doc.write() into a live iframe, so unescaped `<`/`&` in a name or route would be parsed as markup. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildPrintHTML(report: RemittanceRecord, route: string): string {
  const { gcashTotal, cashTotal, grandTotal } = reportTotals(report);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>CHATCO - End of Day Remittance Report</title>
  <style>
    @page { margin: 1.5cm; size: A4; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      color: #111;
      background: #fff;
      padding: 24px;
      font-size: 13px;
      line-height: 1.5;
    }
    .header {
      text-align: center;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 2px solid #1A5FB4;
    }
    .header h1 {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: 0.05em;
      color: #071A2E;
    }
    .header p {
      font-size: 11px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.2em;
      margin-top: 4px;
    }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px 24px;
      margin-bottom: 20px;
    }
    .info-item label {
      display: block;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #64748b;
    }
    .info-item span {
      font-size: 13px;
      font-weight: 600;
      color: #111;
    }
    .section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #64748b;
      margin-bottom: 8px;
      margin-top: 16px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
    }
    table th {
      text-align: left;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #64748b;
      padding: 8px 12px;
      border-bottom: 2px solid #e2e8f0;
    }
    table th:last-child { text-align: right; }
    table td {
      padding: 8px 12px;
      border-bottom: 1px solid #f1f5f9;
      font-size: 13px;
    }
    table td:last-child {
      text-align: right;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    table tfoot td {
      border-top: 2px solid #e2e8f0;
      border-bottom: none;
      font-weight: 700;
      padding-top: 10px;
    }
    table tfoot td:last-child { font-size: 15px; }
    .summary-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
    }
    .summary-row.grand {
      border-top: 2px solid #1A5FB4;
      margin-top: 4px;
      padding-top: 12px;
    }
    .summary-row .label { font-size: 12px; color: #475569; }
    .summary-row .value { font-weight: 700; font-variant-numeric: tabular-nums; }
    .summary-row.grand .label { font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; font-size: 11px; }
    .summary-row.grand .value { color: #1A5FB4; font-size: 22px; font-weight: 800; }
    .status-box {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 10px 14px;
      margin-top: 16px;
      background: #f8fafc;
    }
    .status-box .status-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #64748b;
    }
    .status-box .status-text {
      font-size: 12px;
      font-weight: 600;
      color: #111;
    }
    .status-value {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #475569;
    }
    .footer {
      text-align: center;
      margin-top: 20px;
      padding-top: 12px;
      border-top: 1px solid #e2e8f0;
    }
    .footer p {
      font-size: 10px;
      color: #94a3b8;
      font-family: monospace;
    }
    .divider {
      border: none;
      border-top: 1px solid #e2e8f0;
      margin: 16px 0;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>CHATCO</h1>
    <p>End of Day Remittance Report</p>
  </div>

  <div class="info-grid">
    <div class="info-item"><label>Date</label><span>${escapeHtml(fmtDate(report.date))}</span></div>
    <div class="info-item"><label>Shift ID</label><span style="font-family:monospace">${escapeHtml(report.shiftId)}</span></div>
    <div class="info-item"><label>Conductor</label><span>${escapeHtml(report.conductorName)}</span></div>
    <div class="info-item"><label>Driver</label><span>${escapeHtml(report.driverName)}</span></div>
    <div class="info-item"><label>Time In</label><span>${escapeHtml(formatTime(report.timeIn))}</span></div>
    <div class="info-item"><label>Time Out</label><span>${escapeHtml(formatTime(report.timeOut))}</span></div>
    <div class="info-item"><label>Unit Number</label><span>${escapeHtml(report.unitNumber)}</span></div>
    <div class="info-item"><label>Route</label><span>${escapeHtml(route)}</span></div>
  </div>

  <hr class="divider" />

  <p class="section-title">Payment Breakdown</p>
  <table>
    <thead>
      <tr><th>Method</th><th style="text-align:right">Amount</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>GCash</td>
        <td>${fmt(gcashTotal)}</td>
      </tr>
      <tr>
        <td>Cash</td>
        <td>${fmt(cashTotal)}</td>
      </tr>
    </tbody>
    <tfoot>
      <tr>
        <td>GRAND TOTAL</td>
        <td>${fmt(grandTotal)}</td>
      </tr>
    </tfoot>
  </table>

  <hr class="divider" />

  <div class="summary-row grand">
    <span class="label">Grand Total</span>
    <span class="value">${fmt(grandTotal)}</span>
  </div>

  <hr class="divider" />

  <div class="status-box">
    <div>
      <p class="status-label">Remittance Status</p>
      <p class="status-text">Submitted to Admin</p>
    </div>
    <span class="status-value">${escapeHtml(report.remittanceStatus)}</span>
  </div>

  <div class="footer">
    <p>Generated: ${escapeHtml(fmtDateTime())}</p>
  </div>
</body>
</html>`;
}

/** Print a remittance report through a hidden iframe. Shared by End-of-Day and Settings. */
export function printRemittanceReport(record: RemittanceRecord, route: string) {
  const html = buildPrintHTML(record, route);
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "none";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (doc) { doc.open(); doc.write(html); doc.close(); }
  iframe.onload = () => {
    setTimeout(() => {
      try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); }
      catch { const pw = window.open("", "_blank"); if (pw) { pw.document.write(html); pw.document.close(); pw.onload = () => { pw.print(); pw.close(); }; } }
      setTimeout(() => { if (iframe.parentNode) document.body.removeChild(iframe); }, 1000);
    }, 300);
  };
}

export default function OfficialReportModal({ show, onClose, activeReport, route }: OfficialReportModalProps) {
  if (!show) return null;

  const { gcashTotal, cashTotal, grandTotal } = reportTotals(activeReport);
  const details = [
    { label: "Date", value: fmtDate(activeReport.date) },
    { label: "Shift ID", value: activeReport.shiftId, mono: true },
    { label: "Conductor", value: activeReport.conductorName },
    { label: "Driver", value: activeReport.driverName },
    { label: "Time in", value: formatTime(activeReport.timeIn) },
    { label: "Time out", value: formatTime(activeReport.timeOut) },
    { label: "Unit", value: activeReport.unitNumber },
    { label: "Route", value: route },
  ];

  // Portaled to <body>: opened from the xl:+ End-of-Day popover, a transformed
  // ancestor would otherwise trap this fixed overlay inside the panel.
  return createPortal(
    <div className={D.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="official-report-title" className={`${D.panel} max-w-md overflow-hidden animate-fade-in`}>
        <div className={`flex shrink-0 items-center gap-2.5 border-b px-5 py-4 pr-14 sm:px-6 ${D.hairline}`}>
          <FileText size={22} aria-hidden="true" className={`shrink-0 ${D.blueIcon}`} />
          <h2 id="official-report-title" className="text-base font-semibold text-white light:text-gray-900">Official report</h2>
          <button type="button" onClick={onClose} aria-label="Close official report" className={D.close}><X size={18} /></button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
          <div className="text-center">
            <p className="text-xl font-bold tracking-[0.08em] text-white light:text-gray-900">CHATCO</p>
            <p className={`mt-0.5 ${D.label}`}>End-of-day remittance report</p>
          </div>

          <dl className={`grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-4 ${D.hairline}`}>
            {details.map((item) => (
              <div key={item.label} className="min-w-0">
                <dt className={D.label}>{item.label}</dt>
                <dd className={`mt-0.5 text-sm font-medium break-words text-white/90 light:text-gray-800 ${item.mono ? "font-mono text-xs" : ""}`}>{item.value}</dd>
              </div>
            ))}
          </dl>

          <section aria-labelledby="official-report-breakdown">
            <h3 id="official-report-breakdown" className={D.label}>Payment breakdown</h3>
            <dl className={`mt-1.5 divide-y border-y text-sm ${D.divide} ${D.hairline}`}>
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className={D.muted}>GCash</dt>
                <dd className="font-medium tabular-nums text-white light:text-gray-900">{fmt(gcashTotal)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className={D.muted}>Cash</dt>
                <dd className="font-medium tabular-nums text-white light:text-gray-900">{fmt(cashTotal)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="font-semibold text-white light:text-gray-900">Grand total</dt>
                <dd className="text-lg font-bold tabular-nums text-white light:text-gray-900">{fmt(grandTotal)}</dd>
              </div>
            </dl>
          </section>

          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
            <span className={D.muted}>Remittance status</span>
            <span className="font-semibold text-white light:text-gray-900">{activeReport.remittanceStatus}</span>
          </div>
          <p className={`text-center font-mono text-[10px] ${D.muted}`}>Generated {fmtDateTime()}</p>
        </div>

        <div className={`shrink-0 border-t px-5 py-4 sm:px-6 ${D.hairline}`}>
          <button type="button" onClick={onClose} className={`${D.button} ${D.secondary} w-full`}>Close</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
