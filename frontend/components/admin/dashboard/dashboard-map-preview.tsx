"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { MapPin } from "lucide-react";
import { SkeletonMap } from "@/components/admin/ui/skeleton";
import { useFleetPoll, toLiveVehicleMarkers } from "@/lib/admin/services/monitoring.service";
import { useMonitoringData } from "@/app/(admin)/monitoring/data/data-monitoring";

const AdminCommuterMap = dynamic(() => import("@/components/admin/admin-commuter-map"), {
  ssr: false,
  loading: () => <SkeletonMap height="100%" label="Live Map Loading…" />,
});

export function DashboardMapPreview() {
  // Same live feeds as the Monitoring map (5s fleet poll + demand zones), so
  // the preview shows the same units, crew popups and demand overlay.
  const { fleet } = useFleetPoll(5000);
  const { data } = useMonitoringData(1, "", "recent", false);
  const liveVehicles = useMemo(() => toLiveVehicleMarkers(fleet), [fleet]);

  return (
    <div className="bg-[#131C2E] admin-light:bg-white border border-[#1E2D45] admin-light:border-[#E2E8F0] rounded-lg p-1 h-[380px] flex flex-col">
      <div className="px-4 pt-3 pb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white admin-light:text-slate-900 flex items-center gap-2">
          <MapPin className="w-4 h-4 text-[#62A0EA] admin-light:text-[#1A5FB4]" /> Live Monitoring
        </h3>
        <Link href="/monitoring" className="text-xs text-[#62A0EA] admin-light:text-[#1A5FB4] hover:underline">View Full Map</Link>
      </div>
      <div className="flex-1 rounded-md overflow-hidden border border-[#162033] admin-light:border-[#E2E8F0] mx-1 mb-1">
        <AdminCommuterMap liveVehicles={liveVehicles} demandZones={data.demandZones} />
      </div>
    </div>
  );
}
