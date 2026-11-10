// components/conductor/remittance/HistorySection.tsx
"use client";

import { useState } from "react";
import { type RemittanceRecord } from "@/lib/conductor/services/remittance.service";
import { fmtDate, fmt } from "@/app/(conductor)/conductor-dashboard/end-of-day/helpers";
import { AdminDatePicker } from "@/components/admin/ui/admin-date-picker";
import { UserAvatar } from "@/components/admin/ui/user-avatar";
import { useConductorProfile } from "@/app/(conductor)/hooks/use-conductor-profile";
import { Check, TrendingDown, TrendingUp } from "lucide-react";

const RECORDS_PER_PAGE = 5;
export type RemittanceHistoryFilter = "today" | "last7" | "week" | "month" | "date";

const FILTER_OPTIONS: { key: Exclude<RemittanceHistoryFilter, "date">; label: string }[] = [
  { key: "week", label: "This Week" },
  { key: "today", label: "Today" },
  { key: "last7", label: "Last 7 Days" },
  { key: "month", label: "This Month" },
];

/** Records in the chosen period. Shared by End-of-Day and Settings so both lists agree. */
export function filterRemittanceHistory(history: RemittanceRecord[], filter: RemittanceHistoryFilter, dateFrom: string, dateTo: string): RemittanceRecord[] {
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const daysFromMonday = (startOfToday.getDay() + 6) % 7;
  const weekStart = new Date(startOfToday);
  weekStart.setDate(startOfToday.getDate() - daysFromMonday);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const monthStart = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);

  return history.filter((record) => {
    const recordDate = String(record.date).slice(0, 10);
    const date = new Date(`${recordDate}T00:00:00`);
    if (Number.isNaN(date.getTime())) return false;
    if (filter === "today") return recordDate === startOfToday.toISOString().slice(0, 10);
    if (filter === "last7") return date >= new Date(startOfToday.getTime() - 6 * 86400000) && date <= startOfToday;
    if (filter === "week") return date >= weekStart && date <= weekEnd;
    if (filter === "month") return date >= monthStart && date <= startOfToday;
    if (filter === "date") {
      if (dateFrom && dateTo) return recordDate >= dateFrom && recordDate <= dateTo;
      const selectedDate = dateFrom || dateTo;
      return selectedDate ? recordDate === selectedDate : true;
    }
    return true;
  });
}

interface HistorySectionProps {
  showHistory: boolean;
  setShowHistory: (v: boolean) => void;
  filteredHistory: RemittanceRecord[];
  historyFilter: RemittanceHistoryFilter;
  setHistoryFilter: (v: RemittanceHistoryFilter) => void;
  historyDateFrom: string;
  setHistoryDateFrom: (v: string) => void;
  historyDateTo: string;
  setHistoryDateTo: (v: string) => void;
  openOfficialReport: (record?: RemittanceRecord) => void;
  onPrintReport: (record: RemittanceRecord) => void;
}

export default function HistorySection({ showHistory, setShowHistory, filteredHistory, historyFilter, setHistoryFilter, historyDateFrom, setHistoryDateFrom, historyDateTo, setHistoryDateTo, openOfficialReport, onPrintReport }: HistorySectionProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const conductorPhotoUrl = useConductorProfile()?.photoUrl ?? null;

  const totalPages = Math.max(1, Math.ceil(filteredHistory.length / RECORDS_PER_PAGE));
  const activePage = Math.min(currentPage, totalPages);
  const paginatedHistory = filteredHistory.slice(
    (activePage - 1) * RECORDS_PER_PAGE,
    activePage * RECORDS_PER_PAGE
  );
  const activeFilterLabel = historyFilter === "date"
    ? historyDateFrom && historyDateTo
      ? `${fmtDate(historyDateFrom)} – ${fmtDate(historyDateTo)}`
      : historyDateFrom || historyDateTo
        ? fmtDate(historyDateFrom || historyDateTo)
        : "Custom Date"
    : FILTER_OPTIONS.find((option) => option.key === historyFilter)?.label ?? "This Week";

  const handleFilterChange = (filter: RemittanceHistoryFilter) => {
    setHistoryFilter(filter);
    if (filter !== "date") {
      setHistoryDateFrom("");
      setHistoryDateTo("");
    }
    setCurrentPage(1);
  };

  const handleDateChange = (edge: "from" | "to", date: string) => {
    if (edge === "from") setHistoryDateFrom(date);
    else setHistoryDateTo(date);

    const hasDate = edge === "from"
      ? Boolean(date || historyDateTo)
      : Boolean(historyDateFrom || date);
    setHistoryFilter(hasDate ? "date" : "week");
    setCurrentPage(1);
  };

  return (
    <div className="space-y-3">
      <button onClick={() => setShowHistory(!showHistory)} className="w-full bg-[#071A2E] light:bg-white border border-white/[0.06] light:border-gray-200 rounded-2xl p-4 flex items-center justify-between hover:border-white/[0.1] light:hover:border-gray-300 transition-all active:scale-[0.99]">
        <div className="flex items-center gap-3"><div className="w-9 h-9 rounded-xl bg-white/5 light:bg-gray-100 flex items-center justify-center"><svg className="w-4.5 h-4.5 text-white/30 light:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg></div><div className="text-left"><p className="text-xs font-semibold text-white/60 light:text-gray-800">Remittance History <span className="text-white/35 light:text-gray-500">({activeFilterLabel})</span></p><p className="text-[10px] text-white/25 light:text-gray-500 mt-0.5">{filteredHistory.length} record{filteredHistory.length !== 1 ? "s" : ""} total</p></div></div>
        <svg className={`w-5 h-5 text-white/20 light:text-gray-500 transition-transform duration-300 ${showHistory ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
      </button>
      <div className="overflow-hidden transition-all duration-300 ease-in-out" style={{ maxHeight: showHistory ? "2000px" : "0px", opacity: showHistory ? 1 : 0 }}>
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="col-span-2 flex min-w-0 flex-col items-start gap-1 text-[10px] font-semibold text-white/40 light:text-gray-600 sm:col-span-1">
              <label htmlFor="remittance-history-period">Period</label>
              <select
                id="remittance-history-period"
                aria-label="Filter remittance history period"
                value={historyFilter}
                onChange={(event) => handleFilterChange(event.target.value as RemittanceHistoryFilter)}
                className="h-8 w-full min-w-0 rounded-lg border border-white/10 light:border-gray-300 bg-[#071A2E] light:bg-white px-2.5 text-[11px] font-semibold text-white/80 light:text-gray-800 outline-none transition-all [color-scheme:dark] light:[color-scheme:light] hover:bg-[#0A2038] light:hover:bg-gray-50 focus:border-[#1A5FB4]/70 focus:bg-[#0A2038] light:focus:bg-white"
              >
                {historyFilter === "date" && <option className="bg-[#071A2E] light:bg-white text-white light:text-gray-900" value="date">Selected Date/Range</option>}
                {FILTER_OPTIONS.map((option) => (
                  <option className="bg-[#071A2E] light:bg-white text-white light:text-gray-900" key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex min-w-0 flex-col items-start gap-1 text-[10px] font-semibold text-white/40 light:text-gray-600">
              <span>From</span>
              <AdminDatePicker
                ariaLabel="Filter remittance history from date"
                popover
                yearNavigation
                value={historyDateFrom}
                onChange={(date) => handleDateChange("from", date)}
                className="w-full min-w-0"
                triggerClassName="h-8 w-full min-w-0 py-1.5"
                placeholder="Select date"
                max={historyDateTo || undefined}
              />
            </div>
            <div className="flex min-w-0 flex-col items-start gap-1 text-[10px] font-semibold text-white/40 light:text-gray-600">
              <span>To</span>
              <AdminDatePicker
                ariaLabel="Filter remittance history to date"
                popover
                yearNavigation
                value={historyDateTo}
                onChange={(date) => handleDateChange("to", date)}
                className="w-full min-w-0"
                triggerClassName="h-8 w-full min-w-0 py-1.5"
                placeholder="Select date"
                min={historyDateFrom || undefined}
              />
            </div>
          </div>
          {filteredHistory.length === 0 ? (
            <div className="bg-[#071A2E] light:bg-white border border-white/[0.04] light:border-gray-200 rounded-2xl p-8 flex flex-col items-center"><div className="w-12 h-12 rounded-full bg-white/5 light:bg-gray-100 flex items-center justify-center mb-3"><svg className="w-6 h-6 text-white/15 light:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg></div><p className="text-xs font-medium text-white/20 light:text-gray-600">No records yet</p><p className="text-[10px] text-white/15 light:text-gray-500 mt-0.5">Remittances will appear here after each shift</p></div>
          ) : (
            <>
              <div className="space-y-2.5">
                {paginatedHistory.map((record, idx) => {
                  const totalCollected = record.cashTotal + record.gcashTotal;
                  const isAwaitingCashDeclaration = ["Pending", "Not Remitted", "For Cash Declaration", "Overdue"].includes(record.remittanceStatus);
                  const StatusIcon = record.remittanceStatus === "Overage"
                    ? TrendingUp
                    : record.remittanceStatus === "Shortage"
                      ? TrendingDown
                      : record.remittanceStatus === "Settled"
                        ? Check
                        : null;

                  return (
                  <div key={`${record.shiftId}-${idx}`} className="bg-[#071A2E] light:bg-white border border-white/[0.06] light:border-gray-200 rounded-2xl p-4 space-y-2.5">
                    <div className="flex items-center justify-between"><span className="text-xs font-bold text-white/70 light:text-gray-800">{fmtDate(record.date)}</span><span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-white/60 light:text-gray-600">{record.remittanceStatus}{StatusIcon && <StatusIcon size={12} strokeWidth={2} aria-hidden="true" />}</span></div>
                    <div className="flex items-center gap-3 text-[11px] text-white/35 light:text-gray-500 font-medium flex-wrap">
                      {conductorPhotoUrl && <UserAvatar src={conductorPhotoUrl} alt="" className="h-5 w-5" sizes="20px" fallback={<span aria-hidden="true" />} surfaceClassName="rounded-full border-2 border-white/20 bg-[#1A5FB4] light:border-[#DAEEFF]" />}
                      <span className="text-white/60 light:text-gray-700 font-semibold">{record.conductorName}</span>
                      <span className="text-white/50 light:text-gray-600">{record.driverName}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-white/[0.03] light:bg-gray-50 rounded-lg px-2.5 py-2"><p className="text-[8px] font-semibold text-blue-400/40 light:text-gray-600 uppercase tracking-wider">GCash</p><p className="text-sm font-extrabold text-blue-400 light:text-gray-900 mt-0.5 tabular-nums">{fmt(record.gcashTotal)}</p></div>
                      <div className="bg-white/[0.03] light:bg-gray-50 rounded-lg px-2.5 py-2"><p className="text-[8px] font-semibold text-emerald-400/40 light:text-gray-600 uppercase tracking-wider">Cash</p><p className="text-sm font-extrabold text-emerald-400 light:text-gray-900 mt-0.5 tabular-nums">{fmt(record.cashTotal)}</p></div>
                      <div className="bg-white/[0.03] light:bg-gray-50 rounded-lg px-2.5 py-2"><p className="text-[8px] font-semibold text-white/30 light:text-gray-600 uppercase tracking-wider">Cashless</p><p className="text-sm font-extrabold text-[#62A0EA] light:text-gray-900 mt-0.5 tabular-nums">{fmt(record.totalCashless)}</p></div>
                    </div>
                    <div className="flex items-center justify-between gap-3 pt-1 border-t border-white/[0.04]">
                      <div className="space-y-0.5">
                        <p className="text-xs font-bold text-white/40 light:text-gray-600">
                          Total <span className="text-white light:text-gray-900 font-extrabold tabular-nums">{fmt(totalCollected)}</span>
                        </p>
                        <p className="text-[10px] font-semibold text-white/35 light:text-gray-500">
                          Admin declared cash <span className="text-white/70 light:text-gray-700 tabular-nums">{isAwaitingCashDeclaration ? "Awaiting" : fmt(record.cashDeclared)}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-2"><button onClick={() => openOfficialReport(record)} className="flex items-center gap-1 text-[#62A0EA]/70 light:text-[#1A5FB4] hover:text-[#62A0EA] light:hover:text-[#164A8F] transition-colors active:scale-95"><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg><span className="text-[10px] font-semibold">View</span></button><button onClick={(e) => { e.stopPropagation(); onPrintReport(record); }} className="flex items-center gap-1 text-emerald-400/70 light:text-gray-700 hover:text-emerald-400 light:hover:text-gray-900 transition-colors active:scale-95"><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18.75 7.131H5.25" /></svg><span className="text-[10px] font-semibold">Print</span></button></div>
                    </div>
                  </div>
                  );
                })}
              </div>

              {/* Pagination Controls */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between bg-[#071A2E] light:bg-white border border-white/[0.06] light:border-gray-200 rounded-xl px-4 py-3">
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={activePage === 1}
                    className={`flex items-center gap-1.5 text-[11px] font-semibold transition-all ${
                      activePage === 1
                        ? "text-white/15 light:text-gray-300 cursor-not-allowed"
                        : "text-white/50 light:text-gray-600 hover:text-white light:hover:text-gray-900 active:scale-95"
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    Prev
                  </button>

                  <div className="flex items-center gap-1.5">
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                      <button
                        key={page}
                        onClick={() => setCurrentPage(page)}
                        className={`w-7 h-7 rounded-lg text-[11px] font-bold transition-all ${
                          activePage === page
                            ? "bg-[#1A5FB4] text-white"
                            : "text-white/30 light:text-gray-600 hover:text-white/60 light:hover:text-gray-900 hover:bg-white/5 light:hover:bg-gray-100"
                        }`}
                      >
                        {page}
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={activePage === totalPages}
                    className={`flex items-center gap-1.5 text-[11px] font-semibold transition-all ${
                      activePage === totalPages
                        ? "text-white/15 light:text-gray-300 cursor-not-allowed"
                        : "text-white/50 light:text-gray-600 hover:text-white light:hover:text-gray-900 active:scale-95"
                    }`}
                  >
                    Next
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
