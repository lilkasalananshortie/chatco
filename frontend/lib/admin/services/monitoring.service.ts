// lib/admin/services/monitoring.service.ts
//
// Frontend service for the admin live monitoring dashboard.
// Fetches the live fleet (vehicles with active shifts) from
// GET /api/admin/monitoring and exposes a 5-second polling hook.

import { useState, useEffect, useCallback, useRef } from "react";
import { toTripDirection } from "@/lib/shared/map/trip-direction";
import type { LiveVehicleMarker } from "@/components/admin/admin-commuter-map";

// ─── Types ────────────────────────────────────────────────────────────

export type VehicleCapacity = "AVAILABLE" | "STANDING" | "FULL";

export interface FleetVehicle {
  id: string;
  unit_number: string;
  plate_number: string;
  lat: number | null;
  lng: number | null;
  speed: number | null;
  heading: number | null;
  capacity_status: VehicleCapacity;
  route_name: string | null;
  driver_name: string | null;
  conductor_name: string | null;
  last_update: string | null;
  minutes_since_update: number | null;
  is_on_break: boolean;
  break_started_at: string | null;
  /** Elapsed break time from the active shift; null outside a break. */
  break_duration_minutes: number | null;
  /** False when the unit is on shift but has never posted a GPS ping. */
  has_gps: boolean;
  is_stale: boolean;
  /** FORWARD = Calumpit → Meycauayan, REVERSE = the return trip. */
  trip_direction?: string;
}

export interface MonitoringState {
  fleet: FleetVehicle[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  lastFetchedAt: Date | null;
  refetch: () => Promise<void>;
}

// ─── Fetch helper ─────────────────────────────────────────────────────

/**
 * Fetch the live fleet from /api/admin/monitoring.
 * Returns an array of FleetVehicle (vehicles with active shifts).
 * Throws on non-2xx or network failure.
 */
export async function getFleet(signal?: AbortSignal): Promise<FleetVehicle[]> {
  const res = await fetch("/api/admin/monitoring", {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    if (res.status === 429) {
      const retrySeconds = Number(res.headers.get("Retry-After")) || 60;
      throw new FleetRateLimitError(body?.message ?? "Monitoring updates are temporarily rate limited.", retrySeconds);
    }
    throw new Error(body?.message ?? `Failed to fetch fleet (HTTP ${res.status})`);
  }

  const json = await res.json();
  return (json.data ?? []) as FleetVehicle[];
}

class FleetRateLimitError extends Error {
  constructor(message: string, readonly retrySeconds: number) {
    super(message);
  }
}

/**
 * Fleet rows → AdminCommuterMap markers. Units without a GPS fix are dropped
 * (nothing to plot). Shared by the Monitoring page and the dashboard preview
 * so both maps show the same units with the same popup data.
 */
export function toLiveVehicleMarkers(fleet: FleetVehicle[]): LiveVehicleMarker[] {
  return fleet.map(v => ({
    id: v.id,
    unit_number: v.unit_number,
    plate_number: v.plate_number,
    lat: v.lat ?? 0,
    lng: v.lng ?? 0,
    speed: v.speed,
    capacity: v.capacity_status,
    route_name: v.route_name,
    driver_name: v.driver_name,
    conductor_name: v.conductor_name,
    is_on_break: v.is_on_break,
    break_duration_minutes: v.break_duration_minutes,
    is_stale: v.is_stale,
    minutes_since_update: v.minutes_since_update,
    trip_direction: toTripDirection(v.trip_direction),
  })).filter(v => v.lat !== 0 && v.lng !== 0);
}

// ─── Polling hook ─────────────────────────────────────────────────────

/**
 * useFleetPoll — fetches the live fleet on mount and re-fetches every
 * `intervalMs` milliseconds (default 5000 = 5 seconds).
 *
 * - `isLoading` is true only on the very first fetch (full skeleton).
 * - `isRefreshing` is true on background polls (subtle indicator, no flicker).
 * - On error, the last successful fleet data is retained (not cleared).
 * - The interval is paused when the document is hidden (tab switched away).
 */
export function useFleetPoll(intervalMs: number = 5000): MonitoringState {
  const [fleet, setFleet] = useState<FleetVehicle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const retryAtRef = useRef(0);

  const fetchFleet = useCallback(async () => {
    // A slow poll or focus event must not start another backend request.
    if (abortRef.current || Date.now() < retryAtRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsRefreshing(true);

    try {
      const data = await getFleet(controller.signal);
      setFleet(data);
      setError(null);
      setLastFetchedAt(new Date());
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof FleetRateLimitError) {
        retryAtRef.current = Date.now() + Math.max(1, err.retrySeconds) * 1000;
      }
      setError(err instanceof Error ? err.message : "Failed to load fleet");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchFleet();

    const intervalId = setInterval(() => {
      if (document.hidden) return;
      fetchFleet();
    }, intervalMs);

    const onVisibilityChange = () => {
      if (!document.hidden) {
        fetchFleet();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [fetchFleet, intervalMs]);

  return {
    fleet,
    isLoading,
    isRefreshing,
    error,
    lastFetchedAt,
    refetch: fetchFleet,
  };
}
