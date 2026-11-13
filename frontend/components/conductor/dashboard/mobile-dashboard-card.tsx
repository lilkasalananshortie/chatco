"use client";

import { TripDirectionButton } from "./trip-direction-button";
import { ConductorStatus } from "./use-dashboard-state";
import { formatPeso } from "@/lib/utils/display";
import { BreakToggleButton } from "./break-toggle-button";
import { unitStatusOptionClass, UNIT_STATUS_PANEL_CLASS } from "./unit-status-styles";
import { ConductorAvatar } from "@/components/conductor/conductor-avatar";

interface MobileDashboardCardProps {
  unitNumber: string;
  route: string;
  conductorName: string;
  conductorPhotoUrl: string | null;
  elapsed: string | null;
  status: ConductorStatus;
  setStatus: (s: ConductorStatus) => void;
  mobileCardExpanded: boolean;
  setMobileCardExpanded: (v: boolean) => void;
  total: number;
  gcash: number;
  cash: number;
  isOnBreak: boolean;
  breakBusy: boolean;
  onOpenBreakModal: () => void;
  tripDestination: string;
  onOpenTripModal: () => void;
  canOperate: boolean;
}

export function MobileDashboardCard({
  unitNumber,
  route,
  conductorName,
  conductorPhotoUrl,
  elapsed,
  status,
  setStatus,
  mobileCardExpanded,
  setMobileCardExpanded,
  total,
  gcash,
  cash,
  isOnBreak,
  breakBusy,
  onOpenBreakModal,
  tripDestination,
  onOpenTripModal,
  canOperate,
}: MobileDashboardCardProps) {
  return (
    <div className="lg:hidden bg-[#071A2E]/95 backdrop-blur-xl border-b border-white/10 light:bg-white/95 light:border-gray-200">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-white light:text-gray-900 font-bold text-sm truncate">Unit: {unitNumber}</h1>
          </div>
          <p className="text-[10px] text-white/40 light:text-gray-500 font-medium mt-0.5 truncate">{route}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          <span role="img" aria-label={isOnBreak ? `${conductorName}, on break` : `${conductorName}, on duty`}>
            <ConductorAvatar src={conductorPhotoUrl} isOnBreak={isOnBreak} className="w-8 h-8 shadow-lg" iconClassName="w-4 h-4" sizes="32px" />
          </span>
        </div>
      </div>

      <div
        className="grid overflow-hidden transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: mobileCardExpanded ? "1fr" : "0fr" }}
        inert={!mobileCardExpanded}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="grid grid-cols-2 gap-2 px-4 pb-3">
            <BreakToggleButton
              isOnBreak={isOnBreak}
              busy={breakBusy}
              disabled={breakBusy || !canOperate}
              onClick={onOpenBreakModal}
              className="min-h-11 w-full px-4 py-2.5 text-sm"
            />
            <TripDirectionButton
              destination={tripDestination}
              onClick={onOpenTripModal}
              className="min-h-11 w-full px-4 py-2.5 text-sm"
            />
          </div>
          <div className="px-4 pb-3 space-y-2.5">
            {/* Status row (Payment History lives in the Collect Payment modal) */}
            <div className="flex items-center gap-2">
              <div className={`flex-1 rounded-xl border px-3 py-2 ${UNIT_STATUS_PANEL_CLASS}`}>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <div className="w-2 h-2 rounded-full bg-white/60 light:bg-gray-500" />
                  <span className="text-[10px] font-bold text-white/50 light:text-gray-500 uppercase tracking-wider">Status</span>
                  <span className={`ml-auto text-[10px] font-bold ${isOnBreak ? "text-white light:text-gray-900" : "text-white/60 light:text-gray-700"}`}>
                    {isOnBreak ? "On Break" : status}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  {(["Available", "Standing", "Full"] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatus(s)}
                      disabled={isOnBreak || !canOperate}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-[10px] font-bold transition-colors border disabled:cursor-not-allowed disabled:opacity-40 ${
                        unitStatusOptionClass(status === s)
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-[#1A5FB4]/10 border border-[#1A5FB4]/20 rounded-xl p-3 light:bg-[#F0F7FF] light:border-[#DAEEFF]">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[9px] font-semibold text-[#62A0EA]/60 light:text-[#1A5FB4]/70 uppercase tracking-wider">Total Collected</p>
                <p className="text-xl font-extrabold text-[#62A0EA] light:text-[#1A5FB4]">{formatPeso(total)}</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-white/5 rounded-lg p-2 border border-white/5 light:bg-white light:border-[#DAEEFF]">
                  <p className="text-[8px] font-semibold text-white/40 light:text-gray-500 uppercase tracking-wider">GCash</p>
                  <p className="text-sm font-extrabold text-white light:text-gray-900">{formatPeso(gcash)}</p>
                </div>
                <div className="bg-white/5 rounded-lg p-2 border border-white/5 light:bg-white light:border-[#DAEEFF]">
                  <p className="text-[8px] font-semibold text-white/40 light:text-gray-500 uppercase tracking-wider">Cash</p>
                  <p className="text-sm font-extrabold text-white light:text-gray-900">{formatPeso(cash)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <button
        onClick={() => setMobileCardExpanded(!mobileCardExpanded)}
        aria-expanded={mobileCardExpanded}
        aria-label={mobileCardExpanded ? "Collapse dashboard card" : "Expand dashboard card"}
        className="flex-shrink-0 flex items-center justify-center py-1.5 w-full border-t border-white/5 hover:bg-white/5 transition-colors active:bg-white/10 light:border-gray-200 light:hover:bg-gray-50 light:active:bg-gray-100"
      >
        <svg className={`w-4 h-4 text-white/30 light:text-gray-400 transition-transform duration-300 ${mobileCardExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 15.75 7.5-7.5 7.5 7.5" />
        </svg>
      </button>
    </div>
  );
}
