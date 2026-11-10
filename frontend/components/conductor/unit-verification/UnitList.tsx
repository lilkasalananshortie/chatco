// app/components/conductor/unit-verification/UnitList.tsx
import { ChevronRight } from "lucide-react";
import Image from "next/image";
import minibusFront from "@/assets/minibus-front.svg";
import type { ConductorUnit } from "@/lib/conductor/types";

const statusLabel: Record<ConductorUnit["status"], string> = {
  available: "Available",
  "in-use": "In Use",
  maintenance: "Maintenance",
  assigned: "Assigned",
};

export default function UnitList({
  units,
  onSelect,
  onUnavailable,
}: {
  units: ConductorUnit[];
  onSelect: (unit: ConductorUnit) => void;
  /** Tapping a unit that can't be used reports why instead of selecting it. */
  onUnavailable?: (unit: ConductorUnit) => void;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1 sm:max-h-[68dvh] lg:max-h-[74dvh]">
      {units.map((unit) => {
        const isAvailable = unit.status === "available";
        return (
          <button key={unit.id} type="button" onClick={() => (isAvailable ? onSelect(unit) : onUnavailable?.(unit))} aria-disabled={!isAvailable}
            className={`flex w-full items-center gap-4 rounded-xl border px-4 py-3.5 text-left transition-colors ${isAvailable ? "cursor-pointer border-[#1C3350] light:border-gray-200 bg-[#0B1E33] light:bg-white hover:border-[#1A5FB4] hover:bg-[#10273F] light:hover:bg-gray-100 active:scale-[0.99]" : "cursor-not-allowed border-[#142640] light:border-gray-200 bg-[#081626] light:bg-gray-100"}`}>
            {/* Full-colour art, so an unavailable unit is greyed and faded rather than tinted. */}
            <Image src={minibusFront} alt="" width={36} height={36} className={`h-9 w-9 shrink-0 ${isAvailable ? "" : "grayscale opacity-40"}`} />

            <div className="min-w-0 flex-1">
              <p className={`text-base font-semibold ${isAvailable ? "text-white light:text-gray-900" : "text-slate-500 light:text-gray-500"}`}>{unit.unitNumber}</p>
              <p className={`mt-0.5 text-xs font-medium ${isAvailable ? "text-slate-400 light:text-gray-600" : "text-slate-600 light:text-gray-400"}`}>{unit.plateNumber}</p>
              {!isAvailable && unit.unavailableReason && (
                <p className="mt-1 text-xs text-slate-400 light:text-gray-600">{unit.unavailableReason}</p>
              )}
            </div>
            <span className={`shrink-0 text-[11px] font-semibold uppercase tracking-wider ${isAvailable ? "text-slate-300 light:text-gray-700" : "text-slate-500 light:text-gray-500"}`}>{statusLabel[unit.status]}</span>
            {isAvailable && <ChevronRight size={18} className="-ml-2 shrink-0 text-slate-500 light:text-gray-500" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
