"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { CheckCircle2, Clock3, XCircle, type LucideIcon } from "lucide-react";
import {
  fetchPaymentHistory,
  type CommuterPayment,
  type PaymentStatus,
  type PaymentHistoryPage,
  type PaymentVoucher,
} from "@/lib/commuter/services/payment.service";
import FeedbackModal from "@/components/commuter/feedback-modal";
import { AdminDatePicker } from "@/components/admin/ui/admin-date-picker";
import { formatPeso } from "@/lib/utils/display";

interface PaymentHistoryModalProps {
  onClose: () => void;
}

type TimeFilter = "all" | "today" | "week" | "month";

const PER_PAGE = 20;

// ─── Status (covers the full PaymentStatus lifecycle) ────────────────
// Plain text, no tinted pill: the icon carries the meaning and only a failed
// payment is red. Ended-without-payment states are muted.
const STATUS_TEXT = "text-white/85 light:text-gray-700";
const MUTED_TEXT = "text-white/50 light:text-gray-500";
function getStatusBadge(status: PaymentStatus): { text: string; icon?: LucideIcon; label: string } {
  const badges: Record<PaymentStatus, { text: string; icon?: LucideIcon; label: string }> = {
    paid: { text: STATUS_TEXT, icon: CheckCircle2, label: "Paid" },
    pending: { text: STATUS_TEXT, icon: Clock3, label: "Pending" },
    processing: { text: STATUS_TEXT, label: "Processing" },
    failed: { text: "text-red-400 light:text-red-600", icon: XCircle, label: "Failed" },
    cancelled: { text: MUTED_TEXT, label: "Cancelled" },
    expired: { text: MUTED_TEXT, label: "Expired" },
    refunded: { text: STATUS_TEXT, label: "Refunded" },
  };
  return badges[status] ?? { text: MUTED_TEXT, label: status };
}

// Plain text, no colour coding: which voucher was used and what it did.
function voucherLabel(voucher: PaymentVoucher, amountPaid: number): string {
  if (voucher.kind === "free_ride") return "Free ride voucher";
  if (amountPaid <= 0) return "Discount voucher · full fare";
  return voucher.amountOff ? `Discount voucher · ${formatPeso(voucher.amountOff)} off` : "Discount voucher";
}

export default function PaymentHistoryModal({ onClose }: PaymentHistoryModalProps) {
  const [history, setHistory] = useState<CommuterPayment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [lastPage, setLastPage] = useState(1);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  // Picked dates (YYYY-MM-DD). Either one set = custom range, which replaces
  // the preset tabs: one date shows that day, both show from-to.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [summary, setSummary] = useState<PaymentHistoryPage["summary"]>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ─── S6-T7 feedback state ─────────────────────────────────────
  // The ride whose feedback modal is currently open (null = closed).
  const [activeFeedbackRide, setActiveFeedbackRide] = useState<CommuterPayment | null>(null);
  // Transient success toast ("Feedback submitted").
  const [toast, setToast] = useState<string | null>(null);

  // Below lg the panel slides up on mount and back down before unmounting.
  // Two frames so the off-screen start position paints before the slide.
  const [isShown, setIsShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setIsShown(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  // lg+ (and reduced motion) closes instantly, as ShareRideModal does; no transitionend would fire.
  const requestClose = useCallback(() => {
    if (window.matchMedia("(min-width: 1024px), (prefers-reduced-motion: reduce)").matches) onClose();
    else setIsShown(false);
  }, [onClose]);

  // Auto-dismiss the toast after 2.5s.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // Bumped on every page-1 fetch (mount + each filter switch) so a stale
  // in-flight response from a filter/page the user has since navigated away
  // from can't land late and corrupt `history` with mismatched rows. Rapid
  // tab-switching is the case this guards: switching filtering to the
  // backend means a tab switch is now a real request instead of a re-filter
  // of already-loaded data, so two requests can race.
  const requestIdRef = useRef(0);

  const loadPage = useCallback(async (target: number, filter: TimeFilter, from = "", to = "") => {
    const requestId = target === 1 ? ++requestIdRef.current : requestIdRef.current;
    if (target === 1) {
      setIsLoading(true);
      // Clear immediately (not just on success) so a filter switch can't
      // flash the previous filter's rows for a frame before this resolves.
      setHistory([]);
    } else {
      setIsLoadingMore(true);
    }
    setError(null);
    try {
      const result = await fetchPaymentHistory(target, PER_PAGE, filter, { from, to });
      if (requestId !== requestIdRef.current) return; // superseded by a newer filter/page-1 fetch
      setHistory((prev) => (target === 1 ? result.items : [...prev, ...result.items]));
      if (target === 1) setSummary(result.summary);
      setPage(result.page);
      setLastPage(result.lastPage);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Unable to load payment history.");
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, []);

  // Fetch page 1 for the active filter — on mount, and again whenever the
  // filter tab changes. The backend now applies the time-window filter
  // (PaymentController::history's `filter` param), so `history` only ever
  // holds rows that already match `timeFilter` — no client-side re-filtering.
  useEffect(() => {
    void loadPage(1, timeFilter, dateFrom, dateTo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeFilter, dateFrom, dateTo]);

  const hasMore = page < lastPage;
  const isCustomRange = dateFrom !== "" || dateTo !== "";
  // Custom ranges can span months, so they page with "Load more" instead of
  // auto-paging, and take their totals from the backend summary.
  const isDateFilter = timeFilter !== "all" && !isCustomRange;
  const todayISO = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local day

  const selectPreset = (key: TimeFilter) => {
    setTimeFilter(key);
    setDateFrom("");
    setDateTo("");
  };
  const selectDates = (from: string, to: string) => {
    setTimeFilter("all");
    setDateFrom(from);
    setDateTo(to);
  };

  // While a date filter (Today/Week/Month) is active, keep auto-paging until
  // every matching row is loaded (mirrors the old client-filter UX where
  // narrow filters never showed a "Load more" button) — but now bounded by
  // the backend's own accurate pagination for the filtered query, not by
  // walking the commuter's full unfiltered history.
  const filterNeedsMorePages = isDateFilter && hasMore;

  // Stats cover every PAID row the current filter matches. They're complete
  // whenever the filter is complete; under "All" with more pages left they
  // describe only what's loaded, which the caption below makes explicit.
  const paid = history.filter((tx) => tx.status === "paid");
  const rangeSummary = isCustomRange ? summary : null;
  const totalSpent = rangeSummary ? rangeSummary.totalSpent : paid.reduce((s, tx) => s + tx.amount, 0);
  const rideCount = rangeSummary ? rangeSummary.rideCount : paid.length;
  const avgFare = rangeSummary ? rangeSummary.averageFare : rideCount > 0 ? totalSpent / rideCount : 0;
  const statsArePartial = hasMore && !rangeSummary;

  // Keep pulling pages while the active date filter still has unfetched rows.
  useEffect(() => {
    // Bail on error too: a failed fetch leaves `page` unchanged, so without
    // this the condition stays true and the effect re-fires forever.
    if (error || isLoading || isLoadingMore || !filterNeedsMorePages) return;
    void loadPage(page + 1, timeFilter);
  }, [filterNeedsMorePages, error, isLoading, isLoadingMore, page, timeFilter, loadPage]);

  const formatDateTime = (isoString: string) => {
    const date = new Date(isoString);
    return {
      date: date.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }),
      time: date.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", hour12: true }),
    };
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className={`absolute inset-0 bg-black/60 backdrop-blur-sm max-lg:transition-opacity max-lg:duration-300 ${isShown ? "" : "max-lg:opacity-0"}`} onClick={requestClose} />

      {/* Fixed height, not max-height: the panel used to grow and shrink with
          the row count, so it jumped as you switched time filters or expanded a
          row. A constant frame keeps the header, stats and tabs anchored and
          lets the list scroll inside it. Capped at 85vh so short viewports
          still fit. Below lg it slides up/down; lg+ uses ShareRideModal's fade-in. */}
      <div
        onTransitionEnd={(e) => { if (e.target === e.currentTarget && !isShown) onClose(); }}
        className={`relative bg-[#071A2E] light:bg-white sm:rounded-3xl rounded-t-3xl shadow-2xl w-full sm:max-w-md overflow-hidden flex flex-col pb-safe h-[85vh] sm:h-[620px] sm:max-h-[85vh] lg:animate-fade-in max-lg:transition-transform max-lg:duration-300 max-lg:ease-out motion-reduce:transition-none ${isShown ? "" : "max-lg:translate-y-[100dvh]"}`}
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between p-5 border-b border-white/10 light:border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-white light:text-[#071A2E]">Payment History</h2>
            <p className="text-xs text-white/60 light:text-gray-500 mt-0.5">Your ride payments</p>
          </div>
          <button
            onClick={requestClose}
            className="w-8 h-8 rounded-full bg-white/10 light:bg-gray-100 hover:bg-white/15 light:hover:bg-gray-200 flex items-center justify-center transition-colors"
          >
            <svg className="w-4 h-4 text-white/60 light:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Summary Stats */}
        <div className="flex-shrink-0 grid grid-cols-3 gap-2 px-5 pt-4 pb-2">
          <div className="bg-[#1A5FB4]/15 light:bg-[#F0F7FF] rounded-xl p-3 text-center">
            <p className="text-[10px] font-semibold text-white/50 light:text-gray-400 uppercase tracking-wider">Total Spent</p>
            <p className="text-sm font-bold text-white light:text-[#071A2E] mt-0.5">₱{totalSpent.toFixed(0)}</p>
          </div>
          <div className="bg-[#1A5FB4]/15 light:bg-[#F0F7FF] rounded-xl p-3 text-center">
            <p className="text-[10px] font-semibold text-white/50 light:text-gray-400 uppercase tracking-wider">Rides</p>
            <p className="text-sm font-bold text-white light:text-[#071A2E] mt-0.5">{rideCount}</p>
          </div>
          <div className="bg-[#1A5FB4]/15 light:bg-[#F0F7FF] rounded-xl p-3 text-center">
            <p className="text-[10px] font-semibold text-white/50 light:text-gray-400 uppercase tracking-wider">Avg Fare</p>
            <p className="text-sm font-bold text-white light:text-[#071A2E] mt-0.5">₱{avgFare.toFixed(0)}</p>
          </div>
        </div>

        {/* Under "All" the totals only cover the pages fetched so far, so say
            that rather than presenting a partial sum as the lifetime figure. */}
        {statsArePartial && !isLoading && (
          <p className="flex-shrink-0 px-5 text-[10px] text-white/50 light:text-gray-400 text-center">
            {filterNeedsMorePages
              ? "Loading the rest of this range…"
              : "Covers the rides loaded so far — tap Load more for the full total."}
          </p>
        )}

        {/* Time Filter Tabs */}
        <div className="flex-shrink-0 flex gap-2 px-5 pt-2 pb-3">
          {([
            { key: "all" as TimeFilter, label: "All" },
            { key: "today" as TimeFilter, label: "Today" },
            { key: "week" as TimeFilter, label: "This Week" },
            { key: "month" as TimeFilter, label: "This Month" },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => selectPreset(tab.key)}
              className={`px-3 py-1.5 rounded-lg border text-[11px] font-semibold transition-colors ${
                timeFilter === tab.key && !isCustomRange
                  ? "border-[#1A5FB4] bg-[#1A5FB4] text-white"
                  : "border-[#1E3A5C] bg-[#0B223A] light:border-gray-200 light:bg-gray-100 text-white/70 light:text-gray-600 hover:bg-[#13283F] light:hover:bg-gray-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Custom range. One date = that day; both = from-to. */}
        <div className="flex-shrink-0 grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-5 pb-3">
          <AdminDatePicker
            value={dateFrom}
            onChange={(next) => selectDates(next, dateTo)}
            max={dateTo || todayISO}
            ariaLabel="From date"
            placeholder="From"
            clearLabel="Clear from date"
            popover
            yearNavigation
            className="min-w-0"
            triggerClassName="w-full py-2"
          />
          <span className="text-[11px] text-white/40 light:text-gray-400">to</span>
          <AdminDatePicker
            value={dateTo}
            onChange={(next) => selectDates(dateFrom, next)}
            min={dateFrom || undefined}
            max={todayISO}
            align="right"
            ariaLabel="To date"
            placeholder="To"
            clearLabel="Clear to date"
            popover
            yearNavigation
            className="min-w-0"
            triggerClassName="w-full py-2"
          />
        </div>

        {/* Scrollable List */}
        <div className="flex-1 overflow-y-auto px-5 pb-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-8 h-8 border-2 border-[#62A0EA] light:border-[#1A5FB4] border-t-transparent light:border-t-transparent rounded-full animate-spin" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-red-400 light:text-red-500 font-medium text-sm mb-3">{error}</p>
              <button
                onClick={() => loadPage(1, timeFilter, dateFrom, dateTo)}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#1A5FB4] text-white hover:bg-[#164A8F]"
              >
                Try again
              </button>
            </div>
          ) : history.length === 0 && (filterNeedsMorePages || isLoadingMore) ? (
            // Still paging back toward the filter's cutoff — claiming there are
            // none yet would be a lie we'd contradict a moment later.
            <div className="flex items-center justify-center py-16">
              <div className="w-8 h-8 border-2 border-[#62A0EA] light:border-[#1A5FB4] border-t-transparent light:border-t-transparent rounded-full animate-spin" />
            </div>
          ) : history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <svg className="w-16 h-16 text-white/20 light:text-gray-200 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
              <p className="text-white/50 light:text-gray-400 font-medium text-sm">
                {timeFilter === "all" && !isCustomRange
                  ? "No transactions found"
                  : "No rides in this period"}
              </p>
            </div>
          ) : (
            <div className="mt-1 space-y-2">
              {history.map((tx) => {
                const { date, time } = formatDateTime(tx.createdAt);
                const badge = getStatusBadge(tx.status);
                const isExpanded = expandedId === tx.id;

                return (
                  <div
                    key={tx.id}
                    className={`rounded-xl border transition-colors ${
                      isExpanded ? "border-[#62A0EA]/30 light:border-[#1A5FB4]/20 bg-[#1A5FB4]/15 light:bg-[#F0F7FF]/50" : "border-white/10 light:border-gray-100 bg-[#071A2E] light:bg-white hover:bg-white/5 light:hover:bg-gray-50"
                    }`}
                  >
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : tx.id)}
                      className="w-full flex items-center gap-3 p-3 text-left"
                    >
                      <div className="w-10 h-10 rounded-xl bg-[#1A5FB4]/15 light:bg-[#F0F7FF] flex items-center justify-center flex-shrink-0">
                        <svg className="w-5 h-5 text-[#62A0EA] light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z" />
                        </svg>
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-white light:text-[#071A2E] truncate">
                          {tx.pickupName} → {tx.dropoffName}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[11px] text-white/50 light:text-gray-400">{date}</span>
                          <span className="w-1 h-1 rounded-full bg-white/20 light:bg-gray-300" />
                          <span className="text-[11px] text-white/50 light:text-gray-400">{time}</span>
                          {tx.voucher && (
                            <>
                              <span className="w-1 h-1 rounded-full bg-white/20 light:bg-gray-300" />
                              <span className="truncate text-[11px] font-medium text-white/70 light:text-gray-600">
                                {tx.voucher.kind === "free_ride" ? "Free ride" : "Discount voucher"}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="text-right flex-shrink-0 flex flex-col items-end gap-1">
                        <p className="text-sm font-bold text-white light:text-[#071A2E]">
                          {tx.voucher && tx.amount <= 0 ? "Free" : `- ${formatPeso(tx.amount)}`}
                        </p>
                        <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${badge.text}`}>
                          {badge.icon && <badge.icon size={12} aria-hidden="true" className="shrink-0" />}
                          {badge.label}
                        </span>
                      </div>

                      <svg
                        className={`w-4 h-4 text-white/50 light:text-gray-400 transition-transform flex-shrink-0 ${isExpanded ? "rotate-180" : ""}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                      </svg>
                    </button>

                    {isExpanded && (
                      <div className="px-3 pb-3 pt-0">
                        <div className="bg-white/5 light:bg-gray-50 rounded-lg p-3 space-y-2 text-xs">
                          <div className="flex justify-between">
                            <span className="text-white/50 light:text-gray-400">Pickup</span>
                            <span className="font-medium text-white light:text-[#071A2E]">{tx.pickupName}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-white/50 light:text-gray-400">Drop-off</span>
                            <span className="font-medium text-white light:text-[#071A2E]">{tx.dropoffName}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-white/50 light:text-gray-400">Payment</span>
                            <span className="font-medium text-white light:text-[#071A2E]">
                              {tx.voucher && tx.method !== "Voucher" ? `${tx.method} + voucher` : tx.method}
                            </span>
                          </div>
                          {tx.voucher && (
                            <div className="flex justify-between">
                              <span className="text-white/50 light:text-gray-400">Voucher</span>
                              <span className="font-medium text-white light:text-[#071A2E]">{voucherLabel(tx.voucher, tx.amount)}</span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span className="text-white/50 light:text-gray-400">Ref ID</span>
                            <span className="font-mono text-white light:text-[#071A2E]">{tx.id}</span>
                          </div>
                          {tx.conductorName && (
                            <div className="flex justify-between">
                              <span className="text-white/50 light:text-gray-400">Conductor</span>
                              <span className="font-medium text-white light:text-[#071A2E]">{tx.conductorName}</span>
                            </div>
                          )}
                          {tx.unitNumber && (
                            <div className="flex justify-between">
                              <span className="text-white/50 light:text-gray-400">Unit</span>
                              <span className="font-medium text-white light:text-[#071A2E]">{tx.unitNumber}</span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span className="text-white/50 light:text-gray-400">Fare</span>
                            <span className="font-bold text-white light:text-[#071A2E]">
                              {tx.voucher && tx.amount <= 0 ? "Covered by voucher" : formatPeso(tx.amount)}
                            </span>
                          </div>
                        </div>

                        {/* Group payment — this fare was part of a conductor-recorded
                            multi-passenger payment (one payer settles for the group).
                            Shows the shared receipt total/reference and every rider
                            covered, since the commuter's own row otherwise gives no
                            indication anyone else was included. Absent entirely for a
                            normal individual payment. */}
                        {tx.group && (
                          <div className="mt-2 bg-[#1A5FB4]/15 light:bg-[#F0F7FF] rounded-lg p-3 space-y-1.5 text-xs border border-[#62A0EA]/20 light:border-[#DAEEFF]">
                            <div className="flex items-center justify-between">
                              <span className="font-semibold text-white light:text-[#071A2E]">
                                Group Payment · {tx.group.passengerCount} passenger{tx.group.passengerCount === 1 ? "" : "s"}
                              </span>
                              {tx.group.referenceNumber && (
                                <span className="font-mono text-white/50 light:text-gray-400">{tx.group.referenceNumber}</span>
                              )}
                            </div>
                            <div className="flex justify-between">
                              <span className="text-white/50 light:text-gray-400">Total paid</span>
                              <span className="font-semibold text-white light:text-[#071A2E]">{formatPeso(tx.group.totalAmount)}</span>
                            </div>
                            <div className="space-y-1 pt-1 border-t border-[#62A0EA]/20 light:border-[#DAEEFF]">
                              {tx.group.passengers.map((passenger) => (
                                <div key={passenger.id} className="flex items-center justify-between">
                                  <span className="text-white/60 light:text-gray-500">
                                    {passenger.isYou ? "You" : passenger.name ?? "Passenger"}
                                    {passenger.role ? ` · ${passenger.role}` : ""}
                                  </span>
                                  <span className="font-medium text-white light:text-[#071A2E]">
                                    {passenger.voucher
                                      ? passenger.amount <= 0 ? "Covered by voucher" : `${formatPeso(passenger.amount)} · voucher`
                                      : formatPeso(passenger.amount)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* S6-T7 — Leave / View Feedback. Only on PAID rides that
                            are bound to a shift (shiftId present). Submitted rides
                            show a read-only "View Feedback" + checkmark; others
                            show "Leave Feedback" which opens the submit modal. */}
                        {tx.shiftId && (tx.feedback || tx.canLeaveFeedback) && (
                          <button
                            onClick={() => setActiveFeedbackRide(tx)}
                            className={`w-full mt-2 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                              tx.feedback
                                ? "border border-[#2A4A70] bg-[#13283F] text-white hover:bg-[#1A3350] light:border-gray-200 light:bg-white light:text-gray-800 light:hover:bg-gray-50"
                                : "bg-[#1A5FB4] text-white hover:bg-[#155a9c]"
                            }`}
                          >
                            {tx.feedback ? (
                              <>
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                                </svg>
                                Feedback Submitted · View
                              </>
                            ) : (
                              <>
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" />
                                </svg>
                                Leave Feedback
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Only under "All" — a date filter auto-pages itself to
                  completion above (filterNeedsMorePages), so it never has a
                  dangling "more" to offer. */}
              {hasMore && !isDateFilter && (
                <button
                  onClick={() => loadPage(page + 1, timeFilter, dateFrom, dateTo)}
                  disabled={isLoadingMore}
                  className="w-full mt-2 py-2.5 rounded-xl text-xs font-semibold bg-white/10 light:bg-gray-100 text-white/70 light:text-gray-600 hover:bg-white/15 light:hover:bg-gray-200 disabled:opacity-60"
                >
                  {isLoadingMore ? "Loading…" : "Load more"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* S6-T7 — Feedback modal overlay. Rendered above this modal (z-110 vs
          this modal's z-100). The same modal handles both submit (no existing
          feedback) and read-only view (existing feedback present) modes. */}
      {activeFeedbackRide && (
        <FeedbackModal
          ride={activeFeedbackRide}
          existingFeedback={activeFeedbackRide.feedback}
          onClose={() => setActiveFeedbackRide(null)}
          onSubmitted={(feedback) => {
            // Add to the map so the row instantly flips to "View Feedback".
            setHistory((previous) => previous.map((payment) =>
              payment.shiftId === feedback.shiftId
                ? {
                    ...payment,
                    feedback,
                    feedbackExists: true,
                    canLeaveFeedback: false,
                  }
                : payment
            ));
            setActiveFeedbackRide(null);
            setToast("Feedback submitted — thank you!");
          }}
          onAlreadySubmitted={() => {
            // 409 — feedback was created in another session since the map was
            // built. Refetch so the modal flips to read-only with the real row.
            if (activeFeedbackRide.shiftId) {
              setHistory((previous) => previous.map((payment) =>
                payment.shiftId === activeFeedbackRide.shiftId
                  ? { ...payment, feedbackExists: true, canLeaveFeedback: false }
                  : payment
              ));
            }
            setActiveFeedbackRide(null);
            setToast("Feedback was already submitted for this ride.");
          }}
        />
      )}

      {/* S6-T7 — transient success toast (auto-dismisses after 2.5s). */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] bg-[#071A2E] light:bg-white text-white light:text-[#071A2E] border border-white/10 light:border-gray-200 text-sm font-medium px-4 py-2.5 rounded-full shadow-lg flex items-center gap-2">
          <svg className="w-4 h-4 text-green-400 light:text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          {toast}
        </div>
      )}
    </div>
  );
}
