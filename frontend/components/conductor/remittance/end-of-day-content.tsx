"use client";

import { useState, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/auth-context";
import { clearShift } from "@/lib/conductor/services/shift.service";
import { submitRemittance, type RemittanceRecord } from "@/lib/conductor/services/remittance.service";
import {
  fetchShiftEarnings,
  clearShiftTransactions,
  syncPendingTransactions,
} from "@/lib/conductor/services/transactions.service";
import { getPendingCashTransactions } from "@/lib/conductor/persistence/transactions.store";
import { useRemittanceData } from "@/app/(conductor)/hooks/use-remittance-data";
import { fmt } from "@/app/(conductor)/conductor-dashboard/end-of-day/helpers";

import HistorySection, { filterRemittanceHistory, type RemittanceHistoryFilter } from "@/components/conductor/remittance/HistorySection";
import ConfirmModal from "@/components/conductor/remittance/ConfirmModal";
import SuccessOverlay from "@/components/conductor/remittance/SuccessOverlay";
import OfficialReportModal, { printRemittanceReport } from "@/components/conductor/remittance/OfficialReportModal";
import { UserAvatar } from "@/components/admin/ui/user-avatar";

/**
 * The actual End-of-Day report/remit body — everything except page chrome
 * (the sticky header + back button, which only make sense for a full page,
 * not the xl:+ popover — see ConductorEndOfDayModal). Extracted so the
 * business logic (remittance data, the remit flow, history, official
 * report) has exactly one implementation shared by both:
 *   - the full page (app/(conductor)/conductor-dashboard/end-of-day/page.tsx),
 *     kept for phones/tablets (below xl:) and for anyone linking/refreshing
 *     directly into the URL.
 *   - the xl:+ popover (ConductorEndOfDayModal), opened from ConductorDock
 *     instead of navigating away from whatever tab the conductor was on.
 *
 * Owns useRemittanceData() itself (rather than the caller passing data down)
 * so there is exactly one fetch/poll cycle regardless of which shell is
 * mounted — the page no longer needs its own copy of this hook.
 */
export default function EndOfDayContent() {
  const router = useRouter();
  const { logout } = useAuth();
  const { shift, transactions, earnings, history, status, error } = useRemittanceData();

  const [showConfirm, setShowConfirm] = useState(false);
  const [isRemitting, setIsRemitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [hasRemittedToday, setHasRemittedToday] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<RemittanceHistoryFilter>("week");
  const [historyDateFrom, setHistoryDateFrom] = useState("");
  const [historyDateTo, setHistoryDateTo] = useState("");
  const [showOfficialReport, setShowOfficialReport] = useState(false);
  const [reportForRecord, setReportForRecord] = useState<RemittanceRecord | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const isLoggingOutAfterRemit = useRef(false);
  // Set when the shift just remitted was an earlier one (not today's), so the
  // conductor goes on to unit verification instead of being logged out.
  const remittedPastShift = useRef(false);
  // An earlier shift the daily reset ended while the conductor still held the
  // cash. Only when no shift is running (a new one can't start until these
  // are remitted). History is newest first, so the last match is the oldest:
  // remitted one at a time, oldest first.
  const pendingRemittance = useMemo(() => {
    if (shift) return null;
    const unremitted = history.filter((record) => record.remittanceStatus === "Not Remitted");
    return unremitted[unremitted.length - 1] ?? null;
  }, [history, shift]);

  // Captured totals for the SuccessOverlay. We must store these in state
  // (not just local vars) because the overlay renders AFTER handleRemit
  // finishes, by which point the live summary may have been cleared.
  const [capturedTotals, setCapturedTotals] = useState<{
    gcashTotal: number;
    cashTotal: number;
    grandTotal: number;
  } | null>(null);

  const shiftInfo = {
    conductorName: shift?.conductorName || pendingRemittance?.conductorName || "—",
    driverName: shift?.driverName || pendingRemittance?.driverName || "—",
    unitNumber: shift?.unitNumber || pendingRemittance?.unitNumber || "—",
    route: shift?.route || "—",
    shiftId: shift?.shiftId || pendingRemittance?.shiftId || "",
    timeIn: shift?.timeIn || pendingRemittance?.timeIn || new Date().toISOString(),
    timeOut: shift?.timeOut || pendingRemittance?.timeOut || new Date().toISOString(),
  };
  // ─── Computed breakdown from system-tracked transactions ───
  // S4-T9: Prefer the API-backed `earnings` (from the DB) for the
  // cash_total / gcash_total split. Fall back to computing from the
  // transactions array if earnings is null (e.g., network error).
  const summary = useMemo(() => {
    const keys = ["GCash_Scanned", "GCash_Direct", "Voucher", "Cash"] as const;
    const breakdown: Record<string, { count: number; amount: number }> = {};
    for (const key of keys) {
      const txns = transactions.filter((t) => t.paymentMethod === key);
      breakdown[key] = { count: txns.length, amount: txns.reduce((s, t) => s + t.finalAmount, 0) };
    }

    // An earlier shift's totals come from its remittance row: with no active
    // shift, `earnings` is a zero placeholder and would hide the cash owed.
    if (pendingRemittance) {
      return {
        breakdown,
        totalPassengers: pendingRemittance.totalPassengers,
        gcashTotal: pendingRemittance.gcashTotal,
        cashTotal: pendingRemittance.cashTotal,
        grandTotal: pendingRemittance.cashTotal + pendingRemittance.gcashTotal,
      };
    }

    // Use API-backed earnings if available; otherwise compute from transactions
    const cashTotal = earnings?.cash_total ?? (breakdown["Cash"]?.amount ?? 0);
    const gcashTotal = earnings?.gcash_total ??
      ((breakdown["GCash_Scanned"]?.amount ?? 0) + (breakdown["GCash_Direct"]?.amount ?? 0));
    const grandTotal = earnings?.total ?? transactions.reduce((s, t) => s + t.finalAmount, 0);

    return {
      breakdown,
      totalPassengers: transactions.reduce((sum, transaction) => sum + (transaction.totalPassengers ?? 1), 0),
      gcashTotal,
      cashTotal,
      grandTotal,
    };
  }, [transactions, earnings, pendingRemittance]);

  const canRemit = (transactions.length > 0 || pendingRemittance !== null) && !hasRemittedToday;

  const logoutAfterRemittance = async () => {
    if (isLoggingOutAfterRemit.current) return;
    isLoggingOutAfterRemit.current = true;
    setShowSuccess(false);

    // An earlier shift is settled: pick a unit for today (unit verification
    // sends them back here if another earlier shift is still unremitted).
    // Today's shift is the end of the day, so sign out.
    if (remittedPastShift.current) {
      router.replace("/unit-verification");
      return;
    }

    await logout();
  };

  const filteredHistory = useMemo(
    () => filterRemittanceHistory(history, historyFilter, historyDateFrom, historyDateTo),
    [history, historyFilter, historyDateFrom, historyDateTo],
  );

  const activeReport = reportForRecord || {
    shiftId: shiftInfo.shiftId,
    date: new Date().toISOString().split("T")[0],
    conductorName: shiftInfo.conductorName,
    driverName: shiftInfo.driverName,
    unitNumber: shiftInfo.unitNumber,
    totalPassengers: summary.totalPassengers,
    cashlessBreakdown: {
      gcashScanned: summary.breakdown["GCash_Scanned"]?.amount ?? 0,
      gcashDirect: summary.breakdown["GCash_Direct"]?.amount ?? 0,
      voucher: summary.breakdown["Voucher"]?.amount ?? 0,
    },
    totalCashless: (summary.breakdown["GCash_Scanned"]?.amount ?? 0) + (summary.breakdown["GCash_Direct"]?.amount ?? 0) + (summary.breakdown["Voucher"]?.amount ?? 0),
    cashDeclared: 0,
    gcashTotal: summary.gcashTotal,
    cashTotal: summary.cashTotal,
    remittanceStatus: "Pending" as const,
    timeIn: shiftInfo.timeIn,
    timeOut: shiftInfo.timeOut,
  };

  const handleRemit = async () => {
    setIsRemitting(true);
    setSubmitError(null);

    try {
      // Offline cash is only a local receipt until the server accepts it. Do
      // not submit a remittance snapshot that could omit those fares.
      await syncPendingTransactions();
      const pendingForShift = getPendingCashTransactions().filter(
        (item) => item.shiftId === shiftInfo.shiftId,
      );
      if (pendingForShift.length > 0) {
        throw new Error(
          "Some cash transactions are still waiting to sync. Reconnect to the internet and try again before submitting remittance.",
        );
      }

      // Query the earnings API DIRECTLY to get the real DB totals right
      // before remitting. Don't rely on the possibly-stale `summary` which
      // may show ₱0 if the hook hasn't refreshed.
      let realCashTotal = summary.cashTotal;
      let realGcashTotal = summary.gcashTotal;
      let realGrandTotal = summary.grandTotal;

      if (shiftInfo.shiftId) {
        try {
          const earnings = await fetchShiftEarnings(shiftInfo.shiftId);
          realCashTotal = Number(earnings.cash_total) || 0;
          realGcashTotal = Number(earnings.gcash_total) || 0;
          realGrandTotal = Number(earnings.total) || 0;
        } catch {
          // If earnings API fails, fall back to computing from transactions
        }
      }

      // Ultimate fallback: if API returned 0, compute from the transactions
      // array that's already loaded in the page (from useRemittanceData).
      if (realCashTotal === 0 && transactions.length > 0) {
        realCashTotal = transactions
          .filter((t) => t.paymentMethod === "Cash")
          .reduce((sum, t) => sum + (Number(t.finalAmount) || 0), 0);
      }
      if (realGcashTotal === 0 && transactions.length > 0) {
        realGcashTotal = transactions
          .filter((t) => t.paymentMethod === "GCash_Scanned" || t.paymentMethod === "GCash_Direct")
          .reduce((sum, t) => sum + (Number(t.finalAmount) || 0), 0);
      }
      if (realGrandTotal === 0) {
        realGrandTotal = realCashTotal + realGcashTotal;
      }

      // Capture the totals BEFORE ending the shift.
      const finalGcashTotal = realGcashTotal;
      const finalCashTotal = realCashTotal;
      const finalGrandTotal = realGrandTotal;
      const finalTotalPassengers = summary.totalPassengers;
      const finalBreakdown = summary.breakdown;

      const record: RemittanceRecord = {
        shiftId: shiftInfo.shiftId,
        date: pendingRemittance?.date ?? new Date().toISOString().split("T")[0],
        conductorName: shiftInfo.conductorName,
        driverName: shiftInfo.driverName,
        unitNumber: shiftInfo.unitNumber,
        totalPassengers: finalTotalPassengers,
        cashlessBreakdown: {
          gcashScanned: finalBreakdown["GCash_Scanned"]?.amount ?? 0,
          gcashDirect: finalBreakdown["GCash_Direct"]?.amount ?? 0,
          voucher: finalBreakdown["Voucher"]?.amount ?? 0,
        },
        totalCashless:
          (finalBreakdown["GCash_Scanned"]?.amount ?? 0) +
          (finalBreakdown["GCash_Direct"]?.amount ?? 0) +
          (finalBreakdown["Voucher"]?.amount ?? 0),
        // Cash is no longer declared by the conductor — admin declares it
        // later in the Remittance Module. The real status is unknowable here.
        cashDeclared: 0,
        gcashTotal: finalGcashTotal,
        cashTotal: finalCashTotal,
        remittanceStatus: "For Cash Declaration" as const,
        timeIn: shiftInfo.timeIn,
        timeOut: pendingRemittance?.timeOut || new Date().toISOString(),
      };
      // Captured before the request: after it, history refreshes and the
      // pending record is gone.
      const isPastShift = pendingRemittance !== null;
      // submitRemittance posts to Laravel /conductor/remittances, which is
      // the ONE authoritative way a shift ends (endShiftViaRemittance:
      // creates the remittance row + flips shift_logs to ENDED).
      // Only reached if the server actually ended the shift — submitRemittance
      // now propagates failures instead of silently writing to localStorage,
      // so a failed remit falls into the catch below and leaves the shift
      // alone rather than showing a success overlay for a shift that is still
      // ACTIVE on the server.
      await submitRemittance(record);
      // Forget the locally-cached active shift so the UI reflects ended state.
      clearShift();
      // Drop this shift's cached transactions too. They're now persisted in
      // the remittance record, and leaving them behind means the offline
      // fallback can still read a remitted shift's fares back out.
      clearShiftTransactions(shiftInfo.shiftId);

      // Capture the totals into state BEFORE showing the overlay.
      // endShift() clears the shift data, so the live summary will be 0.
      // The overlay must show the REAL totals from the just-ended shift.
      setCapturedTotals({
        gcashTotal: finalGcashTotal,
        cashTotal: finalCashTotal,
        grandTotal: finalGrandTotal,
      });

      // Show the success overlay. Do NOT call refresh() here — it would
      // clear the shift and transactions, making the overlay show ₱0.
      setShowConfirm(false);
      remittedPastShift.current = isPastShift;
      setShowSuccess(true);
      setHasRemittedToday(true);
      setTimeout(() => {
        void logoutAfterRemittance();
      }, 3000);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Unable to submit remittance."
      );
    } finally {
      setIsRemitting(false);
    }
  };

  const openOfficialReport = (record?: RemittanceRecord) => { setReportForRecord(record || null); if (!record) setReportForRecord({ ...activeReport, remittanceStatus: hasRemittedToday ? "For Cash Declaration" : "Pending" }); setShowOfficialReport(true); };

  const printReport = (record: RemittanceRecord) => printRemittanceReport(record, shiftInfo.route);

  if (status === "loading") {
    return (
      <div className="px-4 pt-5 space-y-5 animate-pulse">
        <div className="h-20 bg-white/[0.04] light:bg-gray-200 rounded-2xl" />
        <div className="h-28 bg-white/[0.04] light:bg-gray-200 rounded-2xl" />
        <div className="h-48 bg-white/[0.04] light:bg-gray-200 rounded-2xl" />
        <div className="h-32 bg-white/[0.04] light:bg-gray-200 rounded-2xl" />
        <div className="h-14 bg-white/[0.04] light:bg-gray-200 rounded-2xl" />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-red-300 light:text-red-700 text-sm">{error}</p>
      </div>
    );
  }

  return (
    <>
      <div className="px-4 pt-5 space-y-5">
        {/* Driver info */}
        <div className="bg-[#071A2E] light:bg-white border border-white/[0.06] light:border-gray-200 rounded-2xl p-4 flex items-center justify-between"><div className="flex items-center gap-3"><UserAvatar alt="" surfaceClassName="rounded-full bg-[#1A5FB4] text-white" /><div><p className="text-sm font-bold text-white light:text-gray-900">{shiftInfo.driverName}</p><p className="text-[11px] text-white/40 light:text-gray-500 font-medium">{shiftInfo.unitNumber} · {shiftInfo.route}</p></div></div></div>

        {/* Grand Total card */}
        <div className="bg-[#071A2E] light:bg-white border border-white/[0.06] light:border-gray-200 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-1">
            <svg className="w-5 h-5 flex-shrink-0 text-[#62A0EA] light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z" />
            </svg>
            <p className="text-[10px] font-semibold text-white/40 light:text-gray-500 uppercase tracking-wider">Total Collections</p>
            {/* Shift start, not today: a pending remittance can be for an
                earlier, auto-closed shift. */}
            <p className="ml-auto text-[11px] font-medium text-white/60 light:text-gray-600">
              {new Date(shiftInfo.timeIn).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
            </p>
          </div>
          <p className="text-5xl font-extrabold leading-tight tracking-tight tabular-nums text-white light:text-gray-900">{fmt(summary.grandTotal)}</p>
          <p className="text-[11px] text-white/25 light:text-gray-500 mt-1">{summary.totalPassengers} passenger{summary.totalPassengers !== 1 ? "s" : ""} · {transactions.length} transaction{transactions.length !== 1 ? "s" : ""}</p>
        </div>

        {/* Collection Summary — GCash vs Cash high-level */}
        <div className="bg-[#071A2E] light:bg-white border border-white/[0.06] light:border-gray-200 rounded-2xl p-4 space-y-3">
          <p className="text-[10px] font-bold text-white/50 light:text-gray-600 uppercase tracking-wider">Collection Summary</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[#0A2038] light:bg-gray-50 rounded-xl p-3 border border-white/[0.06] light:border-gray-200">
              <p className="text-[10px] font-semibold text-white/50 light:text-gray-600 uppercase tracking-wider">GCash</p>
              <p className="text-lg font-extrabold text-white light:text-gray-900 mt-0.5">{fmt(summary.gcashTotal)}</p>
            </div>
            <div className="bg-[#0A2038] light:bg-gray-50 rounded-xl p-3 border border-white/[0.06] light:border-gray-200">
              <p className="text-[10px] font-semibold text-white/50 light:text-gray-600 uppercase tracking-wider">Cash</p>
              <p className="text-lg font-extrabold text-white light:text-gray-900 mt-0.5">{fmt(summary.cashTotal)}</p>
            </div>
          </div>
          <div className="h-px bg-white/10 light:bg-gray-200" />
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-white/70 light:text-gray-700 uppercase tracking-wider">Grand Total</span>
            <span className="text-2xl font-extrabold text-white light:text-gray-900 tabular-nums">{fmt(summary.grandTotal)}</span>
          </div>
        </div>

        {/* Remit section */}
        {!hasRemittedToday ? (
          <div className="space-y-3">
            <div className="bg-white/[0.03] light:bg-gray-50 border border-white/[0.06] light:border-gray-200 rounded-xl p-3.5 flex items-center gap-3">
              <svg className="w-5 h-5 flex-shrink-0 text-[#62A0EA] light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A9 9 0 0 1 3 12c0-1.47.353-2.856.978-4.082" /></svg>
              <div>
                <p className="text-xs font-semibold text-white/70 light:text-gray-800">Remittance to Admin</p>
                <p className="text-[10px] text-white/30 light:text-gray-500 mt-0.5">All recorded transactions will be submitted to admin</p>
              </div>
            </div>
            <button
              onClick={() => canRemit && setShowConfirm(true)}
              disabled={!canRemit}
              className={`w-full py-4 rounded-2xl text-sm font-bold transition-all duration-200 ${
                canRemit
                  ? "bg-[#1A5FB4] text-white hover:bg-[#165a9f] active:scale-[0.98]"
                  : "bg-white/5 light:bg-gray-100 text-white/20 light:text-gray-400 cursor-not-allowed border border-white/5 light:border-gray-200"
              }`}
            >
              {!canRemit ? "No pending remittance" : pendingRemittance ? "Complete Pending Remittance" : "Remit to Admin"}
            </button>
          </div>
        ) : (
          <div className="bg-emerald-500/8 light:bg-gray-50 border border-emerald-500/20 light:border-gray-200 rounded-2xl p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-emerald-500/15 light:bg-gray-100 flex items-center justify-center flex-shrink-0">
              <svg className="w-5 h-5 text-emerald-400 light:text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
            </div>
            <div>
              <p className="text-sm font-bold text-emerald-400 light:text-gray-800">Submitted to Admin</p>
              <p className="text-[11px] text-white/30 light:text-gray-500 mt-0.5">
                GCash {fmt(summary.gcashTotal)} · Cash {fmt(summary.cashTotal)} · Total {fmt(summary.grandTotal)}
              </p>
            </div>
          </div>
        )}

        <HistorySection showHistory={showHistory} setShowHistory={setShowHistory} filteredHistory={filteredHistory} historyFilter={historyFilter} setHistoryFilter={setHistoryFilter} historyDateFrom={historyDateFrom} setHistoryDateFrom={setHistoryDateFrom} historyDateTo={historyDateTo} setHistoryDateTo={setHistoryDateTo} openOfficialReport={openOfficialReport} onPrintReport={printReport} />
      </div>

      {submitError && (
        <div className="px-4 pb-4">
          <p className="text-center text-xs text-red-300 light:text-red-700">{submitError}</p>
        </div>
      )}

      <ConfirmModal show={showConfirm} onClose={() => setShowConfirm(false)} onConfirm={handleRemit} isRemitting={isRemitting} shiftInfo={shiftInfo} gcashTotal={summary.gcashTotal} cashTotal={summary.cashTotal} grandTotal={summary.grandTotal} totalPassengers={summary.totalPassengers} />

      {/* SuccessOverlay uses captured totals so the values persist even
          after endShift() clears the live shift data. */}
      <SuccessOverlay
        show={showSuccess}
        onClose={() => { void logoutAfterRemittance(); }}
        gcashTotal={capturedTotals?.gcashTotal ?? summary.gcashTotal}
        cashTotal={capturedTotals?.cashTotal ?? summary.cashTotal}
        grandTotal={capturedTotals?.grandTotal ?? summary.grandTotal}
        unitNumber={shiftInfo.unitNumber}
        redirectLabel={remittedPastShift.current ? "unit verification" : "login"}
      />
      <OfficialReportModal show={showOfficialReport} onClose={() => setShowOfficialReport(false)} activeReport={activeReport} route={shiftInfo.route} />
    </>
  );
}
