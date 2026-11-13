"use client";

import { formatTime } from "@/lib/conductor/services/shift.service";
import { formatPeso } from "@/lib/utils/display";
import { ConductorStatus } from "./use-dashboard-state";
import { BreakToggleButton } from "./break-toggle-button";
import { TripDirectionButton } from "./trip-direction-button";
import { unitStatusOptionClass } from "./unit-status-styles";
import { ConductorAvatar } from "@/components/conductor/conductor-avatar";

interface DesktopDashboardBarProps {
  unitNumber: string;
  route: string;
  conductorName: string;
  conductorPhotoUrl: string | null;
  status: ConductorStatus;
  setStatus: (s: ConductorStatus) => void;
  total: number;
  gcash: number;
  cash: number;
  isOnBreak: boolean;
  breakBusy: boolean;
  shiftTimeIn: string | undefined;
  onOpenBreakModal: () => void;
  tripDestination: string;
  onOpenTripModal: () => void;
  canOperate: boolean;
}

// One neutral dot for every unit status; the status text beside it says which.
const STATUS_DOT_CLASS = "bg-white/60 light:bg-gray-500";

/**
 * Wide-screen (xl:+) counterpart to DesktopDashboardCard — same data and
 * actions, reflowed into a horizontal strip docked top-center over the map
 * instead of a vertical stack docked bottom-right. Below xl:, the original
 * vertical card still renders (see conductor-dashboard.tsx) — this is an
 * additive breakpoint, not a replacement, so nothing regresses on narrower
 * "large" screens (1024–1279px).
 */
export function DesktopDashboardBar({
  unitNumber,
  route,
  conductorName,
  conductorPhotoUrl,
  status,
  setStatus,
  total,
  gcash,
  cash,
  isOnBreak,
  breakBusy,
  shiftTimeIn,
  onOpenBreakModal,
  tripDestination,
  onOpenTripModal,
  canOperate,
}: DesktopDashboardBarProps) {
  return (
    <div className="hidden xl:flex absolute top-4 left-1/2 -translate-x-1/2 z-10 pointer-events-auto items-stretch divide-x divide-white/10 bg-[#071A2E]/95 backdrop-blur-xl rounded-2xl border border-white/10 shadow-2xl shadow-black/10 overflow-hidden light:divide-gray-200 light:bg-white/95 light:border-gray-200">
      {/* Identity */}
      <div className="flex items-center gap-3 px-4 py-3">
        <span role="img" aria-label={isOnBreak ? `${conductorName}, on break` : `${conductorName}, on duty`} className="flex-shrink-0">
          <ConductorAvatar src={conductorPhotoUrl} isOnBreak={isOnBreak} className="w-10 h-10 shadow-lg" iconClassName="w-5 h-5" sizes="40px" />
        </span>
        <div className="min-w-0">
          <h1 className="text-white light:text-gray-900 font-bold text-sm leading-tight whitespace-nowrap">Unit: {unitNumber}</h1>
          <p className="text-[11px] text-white/50 light:text-gray-500 font-medium max-w-[180px] truncate mt-0.5">{route}</p>
        </div>
      </div>

      {/* Break + trip direction — Payment (and Payment History inside it)
          lives in the navbar (ConductorDock at xl:+), so neither needs an
          entry here. */}
      <div className="flex items-center gap-2 px-4 py-3">
        <BreakToggleButton
          isOnBreak={isOnBreak}
          busy={breakBusy}
          disabled={breakBusy || !canOperate}
          onClick={onOpenBreakModal}
          className="px-4 py-2.5 text-xs"
        />
        <TripDirectionButton destination={tripDestination} onClick={onOpenTripModal} className="px-4 py-2.5 text-xs" />
      </div>

      {/* Unit Status */}
      <div className="flex flex-col justify-center gap-1.5 px-4 py-3">
        <div className="flex items-center gap-1.5">
          <div
            className={`w-2 h-2 rounded-full ${STATUS_DOT_CLASS}`}
          />
          <p className="text-[10px] font-semibold text-white/50 light:text-gray-500 uppercase tracking-wider whitespace-nowrap">
            {isOnBreak ? "On Break" : "Unit Status"}
          </p>
        </div>
        <div className="flex gap-1">
          {(["Available", "Standing", "Full"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              disabled={isOnBreak || !canOperate}
              className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-colors border disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap ${
                unitStatusOptionClass(status === s)
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Total collected + breakdown */}
      <div className="flex items-center gap-4 px-4 py-3">
        <div>
          <p className="text-[10px] font-semibold text-[#62A0EA]/60 light:text-[#1A5FB4]/70 uppercase tracking-wider whitespace-nowrap">Total Collected</p>
          <p className="text-xl font-extrabold text-[#62A0EA] light:text-[#1A5FB4] mt-0.5 whitespace-nowrap">{formatPeso(total)}</p>
        </div>
        <div className="flex flex-col gap-1 border-l border-white/10 light:border-gray-200 pl-4">
          <div className="flex items-center gap-1.5">
            <span className="w-11 text-[9px] font-semibold text-white/40 light:text-gray-500 uppercase tracking-wider">GCash</span>
            <span className="text-[11px] font-bold text-white light:text-gray-900 tabular-nums whitespace-nowrap">{formatPeso(gcash)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-11 text-[9px] font-semibold text-white/40 light:text-gray-500 uppercase tracking-wider">Cash</span>
            <span className="text-[11px] font-bold text-white light:text-gray-900 tabular-nums whitespace-nowrap">{formatPeso(cash)}</span>
          </div>
        </div>
      </div>

      {/* Shift started */}
      {shiftTimeIn && (
        <div className="flex items-center gap-2 px-4 py-3">
          {/* Bare icon, 24px — inside the old 32px box's footprint, so the bar's height doesn't change. */}
          <svg className="w-6 h-6 flex-shrink-0 text-white light:text-gray-900" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
          <div>
            <p className="text-[9px] font-bold text-white/25 light:text-gray-400 uppercase tracking-wider whitespace-nowrap">Shift Started</p>
            <p className="text-xs font-semibold text-white/60 light:text-gray-700 mt-0.5 whitespace-nowrap">{formatTime(shiftTimeIn)}</p>
          </div>
        </div>
      )}
    </div>
  );
}
