// lib/admin/services/analytics.service.ts
//
// Frontend service for the admin analytics dashboard.
// Fetches aggregated business metrics from GET /api/admin/analytics
// with optional date-range filtering.

import { useState, useEffect, useCallback, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────

export interface AnalyticsDateRange {
  from: string;
  to: string;
  days: number;
}

export interface AnalyticsTotals {
  total_fares: number;
  cash_total: number;
  gcash_total: number;
  /** Rides settled for money — excludes free voucher rides. */
  paid_count: number;
  /** Passengers carried, voucher rides included. A group seat counts once. */
  total_passengers: number;
  /** Cash and GCash passengers — the base for avg_fare. */
  paying_passengers: number;
  pending_count: number;
  voucher_count: number;
  /** Fare given away: discounts, discount vouchers and free reward rides. */
  discount_total: number;
  /** Revenue per paying passenger. */
  avg_fare: number;
}

/** Same metrics for the immediately-preceding window, for deltas. */
export interface AnalyticsPreviousTotals {
  total_fares: number;
  cash_total: number;
  gcash_total: number;
  paid_count: number;
  total_passengers: number;
  avg_fare: number;
}

export interface AnalyticsPaymentSplit {
  cash: { count: number; total: number };
  gcash: { count: number; total: number };
  /** Reward rides. Always total 0 — free by definition — but counted. */
  voucher: { count: number; total: number };
}

export interface AnalyticsDailyPoint {
  date: string;
  cash: number;
  gcash: number;
  total: number;
  /** CASH and GCASH rides, matching totals.paid_count. */
  paid_count: number;
  count: number;
}

export interface AnalyticsHourlyPoint {
  hour: number;
  count: number;
  revenue: number;
}

/** Statuses the product actually produces — always present in the breakdown. */
export type TransactionStatusKey =
  | "PAID" | "PENDING" | "PROCESSING" | "FAILED" | "CANCELLED" | "EXPIRED";

/**
 * Keyed by status. The expected keys above are always present; any other
 * status (e.g. a provider-side REFUNDED, which this product never initiates)
 * appears only when a row genuinely has one, so there are no dead zero tiles.
 */
export type AnalyticsStatusBreakdown = Record<TransactionStatusKey, number> &
  Partial<Record<string, number>>;

/** GCash outcomes counted per payment (a group payment counts once). */
export interface AnalyticsGcashHealth {
  attempts: number;
  settled: number;
  failed: number;
  expired: number;
  cancelled: number;
  /** null when there were no gateway attempts at all in the window. */
  success_rate: number | null;
}

export interface AnalyticsRemittances {
  total_remitted: number;
  total_collected: number;
  /** Shortage on remitted shifts only — unremitted cash is `awaiting_*`. */
  total_shortage: number;
  count: number;
  shortage_rate: number;
  /** Ended shifts whose cash hasn't been handed in yet, and that cash. */
  awaiting_count: number;
  awaiting_amount: number;
}

export interface AnalyticsFleet {
  active_vehicles: number;
  total_vehicles: number;
  active_conductors: number;
  total_conductors: number;
}

/** Shifts started in the window, and commuter ratings submitted in it. */
export interface AnalyticsService {
  shifts_run: number;
  /** Mean length of the window's ended shifts; null when none has ended. */
  avg_shift_minutes: number | null;
  review_count: number;
  /** Ride/driver rating (every review has one); null with no reviews. */
  driver_rating: number | null;
  /** Optional per review, so averaged over the reviews that gave one. */
  conductor_rating: number | null;
}

export interface AnalyticsSafety {
  sos_alerts: number;
  /** Alerts from the window not yet resolved. */
  sos_open: number;
  overspeed_episodes: number;
  overspeed_top_speed: number | null;
}

/** One unit's or conductor's shifts, passengers and fare revenue in the window. */
export interface AnalyticsUnitPerformance {
  vehicle_id: string;
  unit_number: string;
  plate_number: string;
  shifts: number;
  passengers: number;
  revenue: number;
}

export interface AnalyticsConductorPerformance {
  conductor_id: string;
  name: string;
  shifts: number;
  passengers: number;
  revenue: number;
}

export interface AnalyticsPickupPoint {
  name: string;
  count: number;
}

export interface AnalyticsHeatmapZone {
  zone: string;
  commuters: number;
  intensity: "Critical" | "High" | "Moderate" | "Low";
  color: string;
  lat: number | null;
  lng: number | null;
}

export interface AnalyticsData {
  date_range: AnalyticsDateRange;
  previous_range: { from: string; to: string };
  totals: AnalyticsTotals;
  previous_totals: AnalyticsPreviousTotals;
  payment_split: AnalyticsPaymentSplit;
  daily_series: AnalyticsDailyPoint[];
  hourly_series: AnalyticsHourlyPoint[];
  status_breakdown: AnalyticsStatusBreakdown;
  gcash_health: AnalyticsGcashHealth;
  remittances: AnalyticsRemittances;
  fleet: AnalyticsFleet;
  pickup_points: AnalyticsPickupPoint[];
  heatmap_zones: AnalyticsHeatmapZone[];
  service: AnalyticsService;
  safety: AnalyticsSafety;
  /** Ranked by revenue, highest first. */
  performance: {
    units: AnalyticsUnitPerformance[];
    conductors: AnalyticsConductorPerformance[];
  };
}

export interface AnalyticsRange {
  date_from?: string;
  date_to?: string;
}

export interface AnalyticsState {
  data: AnalyticsData | null;
  /** True only on the first load / range change with no data to show yet. */
  isLoading: boolean;
  /** True on a manual refetch that has stale data still on screen. */
  isRefreshing: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

// ─── Fetch helper ─────────────────────────────────────────────────────

/**
 * Fetch aggregated analytics from /api/admin/analytics.
 * Optionally pass date_from / date_to (YYYY-MM-DD) to filter the window.
 * If omitted, the backend defaults to the last 30 days.
 *
 * @throws Error on non-2xx or network failure.
 */
export async function getAnalytics(range?: AnalyticsRange, signal?: AbortSignal): Promise<AnalyticsData> {
  const params = new URLSearchParams();
  if (range?.date_from) params.append("date_from", range.date_from);
  if (range?.date_to) params.append("date_to", range.date_to);
  const qs = params.toString();
  const url = `/api/admin/analytics${qs ? `?${qs}` : ""}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? `Failed to fetch analytics (HTTP ${res.status})`);
  }

  const json = await res.json();
  return json.data as AnalyticsData;
}

// ─── Data hook ────────────────────────────────────────────────────────

/**
 * useAnalytics — fetches analytics data on mount and when `range` changes.
 *
 * @param range Optional { date_from, date_to } filter. When undefined, the
 *              backend returns the last 30 days.
 */
export function useAnalytics(range?: AnalyticsRange): AnalyticsState {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rangeKey = `${range?.date_from ?? ""}|${range?.date_to ?? ""}`;

  // Tracks the in-flight request so a superseded one can be aborted. Without
  // this, switching presets quickly (7d → 90d) could let the slower earlier
  // response resolve last and overwrite the newer data.
  const inFlight = useRef<AbortController | null>(null);
  // Whether we already have data on screen. A manual refetch with data
  // present should not blank the page back to a skeleton.
  const hasData = useRef(false);

  const runFetch = useCallback(
    async (background: boolean) => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;

      if (background) setIsRefreshing(true);
      else setIsLoading(true);
      setError(null);

      try {
        const result = await getAnalytics(
          { date_from: range?.date_from, date_to: range?.date_to },
          controller.signal
        );
        if (controller.signal.aborted) return;
        setData(result);
        hasData.current = true;
      } catch (err) {
        // An abort is a superseded request, not a failure — the newer one
        // owns the state now, so leave error/loading alone for it to set.
        if (controller.signal.aborted || (err as Error)?.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load analytics");
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rangeKey]
  );

  // Range changes reload from scratch (skeleton); the data on screen is for
  // a different window and would be misleading to keep.
  useEffect(() => {
    hasData.current = false;
    runFetch(false);
    return () => inFlight.current?.abort();
  }, [runFetch]);

  const refetch = useCallback(
    () => runFetch(hasData.current),
    [runFetch]
  );

  return { data, isLoading, isRefreshing, error, refetch };
}

// ─── Delta helper ─────────────────────────────────────────────────────

export interface Delta {
  /** Percentage change vs the previous window; null when incomparable. */
  pct: number | null;
  direction: "up" | "down" | "flat";
}

/**
 * Percentage change from `previous` to `current`.
 *
 * Returns pct: null when the previous window was zero — "up ∞%" is not a
 * useful thing to show an admin, so the UI renders "no prior data" instead.
 */
export function computeDelta(current: number, previous: number): Delta {
  if (previous === 0) {
    return { pct: null, direction: current > 0 ? "up" : "flat" };
  }
  const pct = ((current - previous) / previous) * 100;
  return {
    pct,
    direction: Math.abs(pct) < 0.05 ? "flat" : pct > 0 ? "up" : "down",
  };
}

// ─── Formatting helpers ───────────────────────────────────────────────

/**
 * Format a number as Philippine Peso currency.
 *   1234.5 -> "₱1,234.50"
 *   0      -> "₱0.00"
 */
export function formatPeso(amount: number): string {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format a number with thousands separators (no currency symbol).
 *   1234567 -> "1,234,567"
 */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-PH").format(value);
}

/**
 * Format a YYYY-MM-DD date string to a readable short form.
 *   "2026-06-25" -> "Jun 25"
 *
 * Parsed from the parts rather than `new Date(str)`: the string form is
 * treated as UTC midnight, which renders as the *previous* day for any
 * timezone behind UTC and is off-by-one at the boundary for Manila.
 */
export function formatShortDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
  });
}

/**
 * Human-readable date range, e.g. "Jul 22 – Aug 20, 2026".
 * The year is shown once after `to`, or after both ends when the range
 * spans a year boundary.
 */
export function formatDateRangeLabel(from: string, to: string): string {
  if (from === to) return `${formatShortDate(from)}, ${from.slice(0, 4)}`;
  const fromYear = from.slice(0, 4);
  const toYear = to.slice(0, 4);
  const fromLabel = formatShortDate(from);
  const toLabel = formatShortDate(to);
  return fromYear === toYear
    ? `${fromLabel} – ${toLabel}, ${toYear}`
    : `${fromLabel}, ${fromYear} – ${toLabel}, ${toYear}`;
}

/**
 * Local YYYY-MM-DD. Never use toISOString() for this — it converts to UTC,
 * so in Manila (UTC+8) any moment before 08:00 local yields *yesterday*,
 * which silently dropped the current day out of every range preset.
 */
export function toLocalISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Format an hour-of-day (0-23) as a short 12-hour label: 0 -> "12a", 13 -> "1p".
 */
export function formatHour(hour: number): string {
  const suffix = hour < 12 ? "a" : "p";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${suffix}`;
}

/**
 * Compact peso for axis ticks: 1234 -> "₱1.2k", 1234567 -> "₱1.2M".
 */
export function formatPesoCompact(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) return `₱${(amount / 1_000_000).toFixed(1)}M`;
  if (Math.abs(amount) >= 1_000) return `₱${(amount / 1_000).toFixed(1)}k`;
  return `₱${Math.round(amount)}`;
}
