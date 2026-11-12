// app/(admin)/monitoring/page.tsx
'use client';

import { useEffect, useState, useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  Gauge, MapPin, AlertCircle, Coffee, Search, X, LocateFixed,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
import { useFleetPoll, toLiveVehicleMarkers } from '@/lib/admin/services/monitoring.service';
import {
  useMonitoringData,
  type DemandZone,
  type SafetyHistorySort,
} from './data/data-monitoring';
import { SkeletonMetric, SkeletonTable, SkeletonMap } from '@/components/admin/ui/skeleton';
import { StickyPageHeader } from '@/components/admin/layout/sticky-page-header';
import { AdminDatePicker } from '@/components/admin/ui/admin-date-picker';
import { formatElapsedMinutes } from '@/lib/utils/display';
import { useAdminNotifications } from '@/contexts/admin-notifications-context';

// Dynamically import the map and disable SSR (Leaflet requires the window object)
const AdminCommuterMap = dynamic<{
  liveVehicles?: import('@/components/admin/admin-commuter-map').LiveVehicleMarker[];
  demandZones?: DemandZone[];
  focusPosition?: [number, number] | null;
  focusNonce?: number;
}>(() => import('@/components/admin/admin-commuter-map'), {
  ssr: false,
  loading: () => <SkeletonMap height="100%" label="Live Map Loading…" />,
});

// Highlight threshold for the live fleet table's speed column. Mirrors the
// backend's default `speed_limit_kmh` (LocationService::speedLimitKmh) — the
// recorded overspeed rows carry their own `threshold`, so this only tints the
// live readout.
const SPEED_LIMIT_KMH = 50;

// Fleet table filter buttons: solid surfaces, Sky Blue only on the selected one.
const MONITOR_FILTER_ON = 'bg-[#62A0EA] font-semibold text-[#0B1120] admin-light:bg-[#1A5FB4] admin-light:text-white';
const MONITOR_FILTER_OFF = 'bg-[#0E1628] font-medium text-slate-300 hover:text-white admin-light:bg-white admin-light:text-slate-600 admin-light:hover:text-slate-900';

function TableHeading({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <th scope="col" className={`sticky top-0 z-10 border-b border-[#26354D] admin-light:border-[#E2E8F0] bg-[#101A2B] admin-light:bg-[#F8FAFC] px-5 py-3 text-xs font-medium text-slate-400 admin-light:text-slate-500 ${className}`}>{children}</th>;
}

function HistoryPagination({ page, pages, start, end, count, onChange }: {
  page: number; pages: number; start: number; end: number; count: number; onChange: (page: number) => void;
}) {
  const buttonClass = 'flex min-h-9 items-center gap-1.5 rounded-md border border-[#2A3A52] admin-light:border-[#E2E8F0] px-3 text-xs font-medium text-slate-300 admin-light:text-slate-700 transition-colors hover:bg-white/5 admin-light:hover:bg-[#F8FAFC] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] admin-light:focus-visible:ring-[#1A5FB4] disabled:cursor-default disabled:opacity-35';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#1E2D45] admin-light:border-[#E2E8F0] px-5 py-4">
      <p className="text-xs text-slate-400 admin-light:text-slate-500 tabular-nums">Showing <span className="text-slate-200 admin-light:text-slate-700">{start}–{end}</span> of {count} records</p>
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous history page" disabled={page === 1} onClick={() => onChange(page - 1)} className={buttonClass}><ChevronLeft size={14} />Previous</button>
        <span className="px-2 text-xs text-slate-400 admin-light:text-slate-500 tabular-nums">{page} / {pages}</span>
        <button type="button" aria-label="Next history page" disabled={page === pages} onClick={() => onChange(page + 1)} className={buttonClass}>Next<ChevronRight size={14} /></button>
      </div>
    </div>
  );
}

export default function MonitoringPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { markRead: markMonitoringNotificationsRead } = useAdminNotifications().monitoring;
  // Opening the Monitoring module clears the nav badge — mirrors
  // Remittance's markRead-on-open.
  useEffect(() => {
    markMonitoringNotificationsRead();
  }, [markMonitoringNotificationsRead]);

  const [overspeedPage, setOverspeedPage] = useState(1);
  const [filterOverspeedDate, setFilterOverspeedDate] = useState('');
  const [historySort, setHistorySort] = useState<SafetyHistorySort>('recent');
  const ROWS_PER_PAGE = 10;
  const [filterBreakOnly, setFilterBreakOnly] = useState(false);

  // Live fleet data (real API, 5s poll)
  const { fleet, isLoading, lastFetchedAt, error, refetch } = useFleetPoll(5000);
  // Real overspeed feed + demand zones.
  const { data } = useMonitoringData(overspeedPage, filterOverspeedDate, historySort);
  const [fleetSearch, setFleetSearch] = useState('');

  // ─── Deep-link from the notification bell ──────────────────────
  // OVERSPEED_FLAGGED links here as ?overspeedId={id}. It has no per-item
  // modal — it renders inline as a history table row — so the deep-link
  // scrolls to and highlights the matching row instead, same idea as
  // handleFocusVehicle's scroll-into-view for a fleet row.
  const [highlightedOverspeedId, setHighlightedOverspeedId] = useState<string | null>(null);
  useEffect(() => {
    const overspeedId = searchParams.get('overspeedId');
    if (overspeedId) {
      setHighlightedOverspeedId(overspeedId);
      // A freshly-flagged episode is always "today" — clear any leftover
      // date filter/page so it's guaranteed to be on the page it lands on.
      setFilterOverspeedDate('');
      setOverspeedPage(1);
      setHistorySort('recent');
    }
    // Strip any notification params (overspeed, or legacy SOS links).
    if (searchParams.size > 0) router.replace('/monitoring');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately mount-only: reacting to `router`/`searchParams` would re-fire after router.replace() strips the params.
  }, []);
  useEffect(() => {
    if (!highlightedOverspeedId) return;
    document.getElementById(`overspeed-log-${highlightedOverspeedId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightedOverspeedId, data.overspeedHistory]);

  // Map focus — clicking a row flies the camera to that unit. This only moves
  // the viewport; the full marker set stays rendered so the rest of the fleet
  // remains visible around the focused unit.
  const [focusedVehicleId, setFocusedVehicleId] = useState<string | null>(null);
  const [focusPosition, setFocusPosition] = useState<[number, number] | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);

  const handleFocusVehicle = (v: { id: string; lat: number | null; lng: number | null }) => {
    if (v.lat === null || v.lng === null) return; // Nothing to fly to yet.
    setFocusedVehicleId(v.id);
    setFocusPosition([v.lat, v.lng]);
    setFocusNonce(n => n + 1); // Re-fly even if the same row is clicked again.
    document.getElementById('monitoring-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // Reuse the fleet feed's active-shift break state for counts, list, and filter.
  const breakUnits = useMemo(() => fleet.filter(v => v.is_on_break), [fleet]);
  const breakCount = breakUnits.length;
  const activeCount = fleet.length;

  // A scheduled break is ordinary shift activity, so neither count escalates.
  const metrics = [
    { title: 'Active Vehicles', hint: 'On shift today', value: activeCount.toString(), icon: MapPin },
    { title: 'On break', hint: 'Active units with a scheduled break', value: breakCount.toString(), icon: Coffee },
  ];

  const filteredFleet = useMemo(() => {
    const query = fleetSearch.trim().toLowerCase();
    return (filterBreakOnly ? breakUnits : fleet).filter((vehicle) => !query || [
      vehicle.unit_number, vehicle.plate_number, vehicle.driver_name, vehicle.conductor_name, vehicle.route_name,
    ].some((value) => value?.toLowerCase().includes(query)));
  }, [fleet, breakUnits, filterBreakOnly, fleetSearch]);

  // Map fleet data to the map component's LiveVehicleMarker format
  const liveMapVehicles = useMemo(() => toLiveVehicleMarkers(fleet), [fleet]);

  const filteredOverspeedHistory = data.overspeedHistory;

  // The history feed re-polls every 5s and can shrink under the viewer (a
  // filter narrows). The page number is therefore clamped to the valid range
  // on every render rather than trusted as-is — otherwise the "Next" guard
  // (page === totalPages) never matches an out-of-range page and you can walk
  // forward through empty tables indefinitely.
  const totalOverspeedPages = Math.max(1, data.overspeedLastPage);
  const safeOverspeedPage = Math.min(Math.max(overspeedPage, 1), totalOverspeedPages);
  const goToOverspeedPage = (page: number) => setOverspeedPage(Math.min(Math.max(page, 1), totalOverspeedPages));
  const currentOverspeedData = filteredOverspeedHistory;

  // ── Loading State ──
  // Mirrors the loaded layout: status strip → map → fleet table.
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 rounded bg-gray-700 admin-light:bg-slate-200 animate-pulse" />
        <SkeletonMetric count={2} />
        <SkeletonMap height="440px" label="Loading Monitoring Map…" />
        <SkeletonTable rows={5} columns={6} title="Active Vehicle Tracking" />
      </div>
    );
  }

  // ── Error State ──
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertCircle className="h-12 w-12 text-red-400 admin-light:text-red-600 mb-4" />
        <h2 className="text-lg font-semibold text-white admin-light:text-slate-900 mb-2">Failed to load monitoring data</h2>
        <p className="text-sm text-slate-400 admin-light:text-slate-500 mb-4">{error}</p>
        <button onClick={() => refetch()} className="px-4 py-2 bg-[#62A0EA] admin-light:bg-[#1A5FB4] hover:bg-[#99C1F1] admin-light:hover:bg-[#164A8F] text-white rounded-md text-sm font-medium transition-colors">Try Again</button>
      </div>
    );
  }

  // Keep fleet counts together above the map, with room for labels on desktop.
  const statusStrip = (
    <div className="mb-5 grid grid-cols-2 overflow-hidden rounded-xl border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#101A2B] admin-light:bg-[#F8FAFC] divide-x divide-[#1E2D45] admin-light:divide-[#E2E8F0]">
      {metrics.map((item) => {
        const Icon = item.icon;
        return (
          <div
            key={item.title}
            title={item.hint}
            className="flex items-center gap-3 px-3 py-3 md:px-5 lg:gap-4 lg:py-4 transition-colors"
          >
            <Icon size={18} className="hidden sm:block flex-shrink-0 text-slate-500" />
            <div className="min-w-0">
              <p className="text-xl font-semibold leading-tight tabular-nums lg:text-2xl text-white admin-light:text-slate-900">{item.value}</p>
              <p className="mt-1 text-[11px] font-medium text-slate-400 admin-light:text-slate-500 truncate lg:text-xs">{item.title}</p>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      {/* Must stay the FIRST child: StickyPageHeader carries a negative top
          margin to reclaim <main>'s padding, so anything above it would lose
          16px underneath. */}
      <StickyPageHeader className="mb-4 md:mb-5 md:flex md:items-center md:justify-between md:gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white admin-light:text-slate-900">Live Monitoring</h1>
          <p className="mt-1.5 hidden text-sm text-slate-400 admin-light:text-slate-500 md:block">Fleet locations and overspeeding records.</p>
        </div>
        <div className="hidden shrink-0 items-center gap-3 md:flex">
          <div className="text-right text-xs text-slate-400 admin-light:text-slate-500">
            <p className="flex items-center justify-end gap-1.5"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Auto-refresh · 5s</p>
            {lastFetchedAt && <p className="mt-1 text-slate-500 tabular-nums">Updated {lastFetchedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</p>}
          </div>
        </div>
      </StickyPageHeader>

      {statusStrip}

      {/* Map and overspeeding history share a row from xl; below that they stack. */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <section aria-label="Live fleet map" className="min-w-0">
        <div id="monitoring-map" className="flex h-[340px] min-w-0 flex-col overflow-hidden rounded-xl border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#131C2E] admin-light:bg-white sm:h-[400px] lg:h-[440px] 2xl:h-[480px]">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1E2D45] admin-light:border-[#E2E8F0] px-4 py-3.5">
            <h2 className="text-sm font-semibold text-white admin-light:text-slate-900">Fleet map</h2>
            <p className="text-xs text-slate-400 admin-light:text-slate-500 tabular-nums">{liveMapVehicles.length} units with GPS</p>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <AdminCommuterMap
              liveVehicles={liveMapVehicles}
              demandZones={data.demandZones}
              focusPosition={focusPosition}
              focusNonce={focusNonce}
            />
          </div>
        </div>
      </section>

      <section aria-labelledby="history-heading" className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#131C2E] admin-light:bg-white xl:h-[440px] 2xl:h-[480px]">
        <div className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b border-[#1E2D45] admin-light:border-[#E2E8F0] px-5 py-4">
          <div>
            <h2 id="history-heading" className="flex items-center gap-2 text-base font-semibold text-white admin-light:text-slate-900"><Gauge size={16} aria-hidden="true" className="text-slate-500" />Overspeeding history</h2>
            <p className="mt-1 text-xs text-slate-400 admin-light:text-slate-500">Recorded overspeeding incidents.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AdminDatePicker popover yearNavigation triggerClassName="w-40 min-h-9 py-2" align="right" ariaLabel="Filter overspeeding history by date" value={filterOverspeedDate} onChange={(next) => { setFilterOverspeedDate(next); setOverspeedPage(1); }} />
            <select
              aria-label="Sort overspeeding history"
              value={historySort}
              onChange={(event) => {
                setHistorySort(event.target.value as SafetyHistorySort);
                setOverspeedPage(1);
              }}
              className="min-h-9 rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white px-3 py-2 text-xs text-slate-300 admin-light:text-slate-700 outline-none focus-visible:border-[#62A0EA] admin-light:focus-visible:border-[#1A5FB4] focus-visible:ring-2 focus-visible:ring-[#62A0EA]/30 admin-light:focus-visible:ring-[#1A5FB4]/30 [color-scheme:dark] admin-light:[color-scheme:light]"
            >
              <option value="recent">Recent first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>
        </div>

        {filteredOverspeedHistory.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center px-5 py-12 text-center"><Gauge size={24} aria-hidden="true" className="mx-auto mb-3 text-slate-500" /><p className="text-sm font-medium text-slate-300 admin-light:text-slate-700">No overspeeding incidents{filterOverspeedDate ? ' for this date' : ' recorded'}</p><p className="mt-1 text-xs text-slate-500">Speed violations will appear here when detected.</p></div>
        ) : (
          <>
            {/* Beside the map (xl+) the panel matches its height: the table
                scrolls inside it and drops its min-width, with tighter cells. */}
            <div className="max-h-[440px] overflow-auto scrollbar-themed xl:max-h-none xl:min-h-0 xl:flex-1">
              <table aria-label="Overspeeding history" className="w-full min-w-[760px] table-fixed text-left xl:min-w-0">
                <thead><tr>
                  <TableHeading className="w-[16%] xl:w-[19%] xl:px-3">Unit / plate</TableHeading>
                  <TableHeading className="w-[23%] xl:w-[21%] xl:px-3">Driver</TableHeading>
                  <TableHeading className="w-[23%] xl:w-[21%] xl:px-3">Conductor</TableHeading>
                  <TableHeading className="w-[17%] text-right xl:px-3">Top speed</TableHeading>
                  <TableHeading className="w-[21%] xl:w-[22%] xl:px-3">Recorded</TableHeading>
                </tr></thead>
                <tbody className="divide-y divide-[#1E2D45] admin-light:divide-[#E2E8F0]">
                  {currentOverspeedData.map((log) => (
                    <tr key={log.id} id={`overspeed-log-${log.id}`} className={`transition-colors ${highlightedOverspeedId === log.id ? 'bg-[#62A0EA]/10 admin-light:bg-[#1A5FB4]/10 ring-1 ring-inset ring-[#62A0EA]/40 admin-light:ring-[#1A5FB4]/40' : 'hover:bg-white/3 admin-light:hover:bg-[#F8FAFC]'}`}>
                      <td className="px-5 py-4 xl:px-3"><span className="block truncate font-mono text-sm font-semibold text-slate-200 admin-light:text-slate-700" title={log.unit}>{log.unit}</span></td>
                      <td className="px-5 py-4 xl:px-3"><span className="block truncate text-sm text-slate-300 admin-light:text-slate-700" title={log.driver}>{log.driver}</span></td>
                      <td className="px-5 py-4 xl:px-3"><span className="block truncate text-sm text-slate-300 admin-light:text-slate-700" title={log.conductor}>{log.conductor}</span></td>
                      <td className="px-5 py-4 text-right whitespace-nowrap xl:px-3"><span className="text-sm font-semibold text-red-300 admin-light:text-red-700 tabular-nums">{log.speed}</span><span className="ml-1 text-[10px] text-slate-500">km/h</span></td>
                      <td className="px-5 py-4 xl:px-3"><p className="truncate text-xs text-slate-300 admin-light:text-slate-700 tabular-nums">{log.loggedDate}</p><p className="mt-1 truncate text-xs text-slate-400 admin-light:text-slate-500">{log.loggedAt}</p></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <HistoryPagination page={safeOverspeedPage} pages={totalOverspeedPages} start={(safeOverspeedPage - 1) * ROWS_PER_PAGE + 1} end={(safeOverspeedPage - 1) * ROWS_PER_PAGE + currentOverspeedData.length} count={data.overspeedTotal} onChange={goToOverspeedPage} />
          </>
        )}
      </section>
      </div>

      <section aria-labelledby="fleet-heading" className="mb-8 mt-5 min-w-0 overflow-hidden rounded-xl border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#131C2E] admin-light:bg-white">
        <div className="border-b border-[#1E2D45] admin-light:border-[#E2E8F0] px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 id="fleet-heading" className="text-base font-semibold text-white admin-light:text-slate-900">Active vehicle tracking</h2>
              <p className="mt-1 text-xs text-slate-400 admin-light:text-slate-500">Units on shift today. Select a unit to view its location.</p>
            </div>
            <span className="shrink-0 text-xs text-slate-400 admin-light:text-slate-500 tabular-nums">{filteredFleet.length} / {fleet.length} units</span>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <label className="flex min-w-0 flex-1 basis-full items-center gap-2.5 rounded-lg border border-[#2A3A52] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white px-3 focus-within:border-[#62A0EA] admin-light:focus-within:border-[#1A5FB4] lg:max-w-sm lg:basis-0">
              <Search size={15} aria-hidden="true" className="shrink-0 text-slate-500" />
              <input type="search" aria-label="Search active fleet" placeholder="Search unit, plate, crew, or route" value={fleetSearch} onChange={(event) => setFleetSearch(event.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-xs text-slate-200 admin-light:text-slate-700 outline-none placeholder:text-slate-500" />
              {fleetSearch && <button type="button" aria-label="Clear fleet search" onClick={() => setFleetSearch('')} className="rounded p-1 text-slate-400 admin-light:text-slate-500 hover:text-white admin-light:hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] admin-light:focus-visible:ring-[#1A5FB4]"><X size={13} /></button>}
            </label>
            {/* Solid segmented filter: Sky Blue marks only the selected option. */}
            <div role="group" aria-label="Filter active vehicles" className="inline-flex items-center gap-0.5 rounded-lg border border-[#2A3A52] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white p-0.5">
              <button type="button" aria-pressed={!filterBreakOnly} onClick={() => setFilterBreakOnly(false)} className={`min-h-8 rounded-md px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] admin-light:focus-visible:ring-[#1A5FB4] ${!filterBreakOnly ? MONITOR_FILTER_ON : MONITOR_FILTER_OFF}`}>All units <span className="ml-1 tabular-nums">{fleet.length}</span></button>
              <button type="button" aria-pressed={filterBreakOnly} onClick={() => setFilterBreakOnly(true)} className={`flex min-h-8 items-center gap-1.5 rounded-md px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] admin-light:focus-visible:ring-[#1A5FB4] ${filterBreakOnly ? MONITOR_FILTER_ON : MONITOR_FILTER_OFF}`}><Coffee size={13} aria-hidden="true" />On break <span className="ml-1 tabular-nums">{breakCount}</span></button>
            </div>
          </div>
        </div>
        <div className="max-h-[440px] overflow-auto scrollbar-themed">
          <table aria-label="Active vehicle tracking" className="w-full min-w-[840px] table-fixed text-left">
            <colgroup><col className="w-[18%]" /><col className="w-[25%]" /><col className="w-[16%]" /><col className="w-[16%]" /><col className="w-[18%]" /><col className="w-[7%]" /></colgroup>
            <thead><tr>
              <TableHeading>Unit / plate</TableHeading>
              <TableHeading>Crew</TableHeading>
              <TableHeading className="pr-8 text-right">Speed</TableHeading>
              <TableHeading>Capacity</TableHeading>
              <TableHeading>Status</TableHeading>
              <TableHeading className="px-2"><span className="sr-only">Map location</span></TableHeading>
            </tr></thead>
            <tbody className="divide-y divide-[#1E2D45] admin-light:divide-[#E2E8F0]">
              {filteredFleet.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-12 text-center">
                  <p className="text-sm font-medium text-slate-300 admin-light:text-slate-700">{fleet.length === 0 ? 'No vehicles on shift' : 'No matching vehicles'}</p>
                  <p className="mt-1 text-xs text-slate-500">{fleet.length === 0 ? 'Active units will appear here when their shift starts.' : 'Try another search or switch to all units.'}</p>
                </td></tr>
              ) : filteredFleet.map((v) => (
                <tr key={v.id} id={`fleet-unit-${v.id}`} onClick={() => handleFocusVehicle(v)} className={`group transition-colors ${v.has_gps ? 'cursor-pointer' : ''} ${focusedVehicleId === v.id ? 'bg-[#62A0EA]/10 admin-light:bg-[#1A5FB4]/10 ring-1 ring-inset ring-[#62A0EA]/40 admin-light:ring-[#1A5FB4]/40' : 'hover:bg-white/3 admin-light:hover:bg-[#F8FAFC]'}`}>
                  <td className="px-5 py-4"><p className="truncate text-sm font-semibold text-white admin-light:text-slate-900" title={v.unit_number}>{v.unit_number}</p><p className="mt-1 truncate font-mono text-[11px] text-slate-400 admin-light:text-slate-500" title={v.plate_number}>{v.plate_number}</p></td>
                  <td className="px-5 py-4">
                    <p className="truncate text-sm text-slate-200 admin-light:text-slate-700" title={v.driver_name ?? undefined}>{v.driver_name ?? 'Unassigned driver'}</p>
                    <p className="mt-1 truncate text-xs text-slate-400 admin-light:text-slate-500" title={v.conductor_name ?? undefined}>Conductor: {v.conductor_name ?? 'Unassigned'}</p>
                  </td>
                  <td className="pl-5 pr-8 py-4 text-right whitespace-nowrap"><span className={`text-sm font-semibold tabular-nums ${v.speed !== null && v.speed > SPEED_LIMIT_KMH ? 'text-red-300 admin-light:text-red-700' : 'text-slate-200 admin-light:text-slate-700'}`}>{v.speed ?? '—'}</span>{v.speed !== null && <span className="ml-1 text-[10px] text-slate-500">km/h</span>}</td>
                  <td className="px-5 py-4"><span className={`text-xs font-medium ${v.capacity_status === 'AVAILABLE' ? 'text-emerald-300 admin-light:text-emerald-700' : v.capacity_status === 'STANDING' ? 'text-amber-300 admin-light:text-amber-700' : 'text-red-300 admin-light:text-red-700'}`}>{v.capacity_status === 'AVAILABLE' ? 'Available' : v.capacity_status === 'STANDING' ? 'Standing' : 'Full'}</span></td>
                  <td className="px-5 py-4">
                    {v.is_on_break ? <div><span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-200 admin-light:text-slate-700"><Coffee size={13} aria-hidden="true" className="text-slate-400 admin-light:text-slate-500" />On break</span><p className="mt-1 text-[11px] text-slate-400 admin-light:text-slate-500">{formatElapsedMinutes(v.break_duration_minutes)} elapsed</p></div> : !v.has_gps ? <span className="text-xs text-slate-400 admin-light:text-slate-500">Awaiting GPS</span> : v.is_stale ? (
                      <div><span className="text-xs font-medium text-amber-300 admin-light:text-amber-700">GPS delayed</span><p className="mt-1 text-[11px] text-slate-400 admin-light:text-slate-500">{formatElapsedMinutes(v.minutes_since_update)} ago</p></div>
                    ) : <span className="text-xs text-slate-200 admin-light:text-slate-700">Live</span>}
                  </td>
                  <td className="px-2 py-4"><button type="button" onClick={(event) => { event.stopPropagation(); handleFocusVehicle(v); }} disabled={!v.has_gps} aria-label={`Locate unit ${v.unit_number} on map`} title={v.has_gps ? 'Locate on map' : 'No GPS position reported'} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 admin-light:text-slate-500 transition-colors hover:bg-[#62A0EA]/10 admin-light:hover:bg-[#1A5FB4]/10 hover:text-[#99C1F1] admin-light:hover:text-[#164A8F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] admin-light:focus-visible:ring-[#1A5FB4] disabled:cursor-default disabled:opacity-25"><LocateFixed size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
