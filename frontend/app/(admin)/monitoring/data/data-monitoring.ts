// app/(admin)/monitoring/data/data-monitoring.ts
//
// Sprint 6 (S6-T10) — admin monitoring data: overspeed history and demand
// zones.
//
// The live fleet (vehicles with active shifts) is fetched separately by
// useFleetPoll() in lib/admin/services/monitoring.service.ts — that hook
// polls /api/admin/monitoring and is unaffected by this file.

import { useState, useEffect, useCallback, useRef } from "react";

/* ─── INTERFACES (API contracts) ─── */

export interface OverspeedLog {
  id: string;
  unit: string;
  driver: string;
  conductor: string;
  speed: number;
  loggedAt: string;
  loggedDate: string;
}

export interface DemandZone {
  id: string;
  coords: [number, number];
  radiusMeters: number;
  commuterCount: number;
  intensity: "LOW" | "MEDIUM" | "HIGH";
}

export interface MonitoringData {
  overspeedHistory: OverspeedLog[];
  overspeedTotal: number;
  overspeedLastPage: number;
  demandZones: DemandZone[];
}

export type SafetyHistorySort = "recent" | "oldest";

/* ─── HELPERS ─── */

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ─── DATA HOOK ─── */

const POLL_INTERVAL_MS = 5000;

export function useMonitoringData(
  overspeedPage = 1,
  overspeedDate = "",
  historySort: SafetyHistorySort = "recent",
  // The dashboard map preview needs only demand zones, not the history feed.
  withOverspeed = true,
) {
  const [overspeedHistory, setOverspeedHistory] = useState<OverspeedLog[]>([]);
  const [overspeedTotal, setOverspeedTotal] = useState(0);
  const [overspeedLastPage, setOverspeedLastPage] = useState(1);
  const [demandZones, setDemandZones] = useState<DemandZone[]>([]);

  const overspeedRequestId = useRef(0);
  const retryAtRef = useRef(0);

  const requestMonitoring = useCallback(async (url: string) => {
    if (Date.now() < retryAtRef.current) return null;
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (res.status === 429) {
      const retrySeconds = Number(res.headers.get("Retry-After")) || 60;
      retryAtRef.current = Date.now() + Math.max(1, retrySeconds) * 1000;
    }
    return res;
  }, []);

  const fetchOverspeed = useCallback(async () => {
    const requestId = ++overspeedRequestId.current;
    try {
      const params = new URLSearchParams({ page: String(overspeedPage), per_page: "10", sort: historySort });
      if (overspeedDate) params.set("date", overspeedDate);
      const res = await requestMonitoring(`/api/admin/monitoring/overspeed?${params}`);
      if (!res) return;
      if (!res.ok) return;
      const data = await res.json();
      if (requestId !== overspeedRequestId.current) return;
      const paginator = data.data ?? {};
      const raw = (paginator.data ?? []) as Array<{
        id: string; unit: string; plate: string; speed: number;
        driver: string | null; conductor: string | null;
        date: string | null; last_update: string | null;
      }>;
      const mapped: OverspeedLog[] = raw.map(v => ({
        id: v.id,
        // Unit identified by plate number (per requirement), falling back to unit no.
        unit: v.plate ?? v.unit ?? '—',
        driver: v.driver ?? '—',
        conductor: v.conductor ?? '—',
        speed: v.speed,
        loggedAt: v.last_update ? formatRelativeTime(v.last_update) : '—',
        loggedDate: v.date ?? (v.last_update ? new Date(v.last_update).toISOString().split('T')[0] : ''),
      }));
      setOverspeedHistory(mapped);
      setOverspeedTotal(Number(paginator.total ?? mapped.length));
      setOverspeedLastPage(Number(paginator.last_page ?? 1));
    } catch {
      // Overspeed is best-effort
    }
  }, [historySort, overspeedDate, overspeedPage, requestMonitoring]);

  const fetchDemandZones = useCallback(async () => {
    try {
      const res = await requestMonitoring("/api/admin/monitoring/demand-zones");
      if (!res) return;
      if (!res.ok) return;
      const body = await res.json();
      const raw = (body.data ?? []) as Array<{
        id: string;
        lat: number | string;
        lng: number | string;
        commuter_count: number;
        intensity: "LOW" | "MEDIUM" | "HIGH";
        radius_meters: number;
      }>;
      setDemandZones(raw.map((zone) => ({
        id: zone.id,
        coords: [Number(zone.lat), Number(zone.lng)],
        commuterCount: zone.commuter_count,
        intensity: zone.intensity,
        radiusMeters: zone.radius_meters,
      })));
    } catch {
      // Demand overlay is best-effort; other monitoring remains live.
    }
  }, [requestMonitoring]);

  // Pagination/date changes fetch only the overspeed feed, without restarting
  // the demand polling loop.
  const fetchOverspeedRef = useRef(fetchOverspeed);
  useEffect(() => {
    fetchOverspeedRef.current = fetchOverspeed;
    if (!withOverspeed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchOverspeed only sets state after its await (async response), never synchronously.
    void fetchOverspeed();
  }, [fetchOverspeed, withOverspeed]);

  // Initial fetch + polling. Coalesce focus/online/visibility events and let
  // slow refreshes finish before issuing the next batch.
  useEffect(() => {
    let inFlight = false;
    let lastRefreshAt = 0;
    // The overspeed feed already fetched on mount via its own effect, so the
    // first pass skips it.
    const refreshAll = (includeOverspeed = true) => {
      if (document.visibilityState !== "visible") return;
      if (inFlight || Date.now() - lastRefreshAt < 1000) return;
      inFlight = true;
      lastRefreshAt = Date.now();
      void Promise.all([
        fetchDemandZones(),
        ...(includeOverspeed && withOverspeed ? [fetchOverspeedRef.current()] : []),
      ]).finally(() => { inFlight = false; });
    };

    refreshAll(false);
    const onRefresh = () => refreshAll();
    const id = setInterval(onRefresh, POLL_INTERVAL_MS);
    window.addEventListener("focus", onRefresh);
    window.addEventListener("online", onRefresh);
    document.addEventListener("visibilitychange", onRefresh);

    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener("online", onRefresh);
      document.removeEventListener("visibilitychange", onRefresh);
    };
  }, [fetchDemandZones, withOverspeed]);

  const data: MonitoringData = {
    overspeedHistory,
    overspeedTotal,
    overspeedLastPage,
    demandZones,
  };

  return { data };
}
