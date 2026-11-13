// contexts/rewards-context.tsx
//
// Shared commuter rewards state: the progress ring + voucher list on the
// rewards page AND the "voucher ready to redeem" half of the Rewards tab badge.
//
// Hoisted for the same reason as the announcements context — the layout badge
// and the rewards page need the same numbers, and two independent fetches
// would drift (redeeming a voucher on the page would leave the badge stale).
// See contexts/announcements-context.tsx.
//
//   GET /api/commuter/rewards → { totalRides, ridesNeeded, currentCycleRides,
//                                 vouchers[] }
//
// The backend owns the cycle logic: every `ridesNeeded` (10) completed cashless
// rides mints another voucher, so the cycle repeats indefinitely and a commuter
// can hold several AVAILABLE vouchers at once. The badge counts them rather
// than showing a boolean, so "2 rides worth of free rides waiting" is visible
// without opening the page.

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAuth } from "@/contexts/auth-context";
import type { RewardData } from "@/app/(commuter)/rewards/types";
import { REWARDS_CHANGED_EVENT } from "@/lib/commuter/rewards-events";
import { getRenewalState, type RenewalState } from "@/lib/shared/services/student-renewal.service";

/**
 * Longer than the announcement poll: ride totals only move when a fare is
 * recorded, so this is just there to surface a voucher minted mid-session
 * (e.g. the commuter pays by GCash while sitting on the dashboard).
 */
const POLL_INTERVAL_MS = 5 * 60_000;

interface RewardsContextValue {
  data: RewardData | null;
  isLoading: boolean;
  error: string | null;
  /** Vouchers the commuter can redeem right now — drives the tab badge. */
  availableVoucherCount: number;
  refetch: () => Promise<void>;
  /**
   * Student renewal state for current and former students; null for everyone
   * else or until loaded. `notice_active` is the rewards page's renewal notice,
   * and it keeps one count on the tab badge until the renewal is approved.
   */
  renewal: RenewalState | null;
  refreshRenewal: () => void;
}

const RewardsContext = createContext<RewardsContextValue | null>(null);

export function RewardsProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading: authLoading, commuterProfile } = useAuth();

  const [data, setData] = useState<RewardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renewal, setRenewal] = useState<RenewalState | null>(null);
  // Same audience as the rewards page's renewal notice: nobody else can be due.
  const renewalAudience = commuterProfile?.commuterType === "STUDENT" || commuterProfile?.appliedType === "STUDENT";

  const refreshRenewal = useCallback(() => {
    if (!renewalAudience) return;
    // A failed read keeps the last state, so the badge never flickers off.
    void getRenewalState().then(setRenewal).catch(() => {});
  }, [renewalAudience]);

  useEffect(() => {
    if (authLoading || !isAuthenticated || !renewalAudience) {
      setRenewal(null);
      return;
    }
    refreshRenewal();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshRenewal();
    };
    const id = setInterval(refreshWhenVisible, POLL_INTERVAL_MS);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [authLoading, isAuthenticated, renewalAudience, refreshRenewal]);

  const refetch = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/commuter/rewards", {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `Failed to load rewards (HTTP ${res.status})`);
      }

      const json = await res.json();
      const d = json.data;
      const vouchers: RewardData["vouchers"] = (d.vouchers ?? []).map((v: Record<string, unknown>) => {
        const expiresAt = String(v.expiresAt ?? "");
        const providerStatus = (v.status ?? "AVAILABLE") as RewardData["vouchers"][number]["status"];
        const expiryTime = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
        const status = providerStatus === "AVAILABLE"
          && Number.isFinite(expiryTime)
          && expiryTime <= Date.now()
          ? "EXPIRED"
          : providerStatus;

        return {
          id: String(v.id ?? ""),
          code: String(v.code ?? ""),
          type: (v.type ?? "REWARD") as RewardData["vouchers"][number]["type"],
          amount: v.amount == null ? null : Number(v.amount),
          status,
          expiresAt,
          rideOrigin: String(v.rideOrigin ?? "Reward"),
        };
      });

      setData({
        totalRides: d.totalRides ?? 0,
        ridesNeeded: d.ridesNeeded ?? 10,
        currentCycleRides: d.currentCycleRides ?? 0,
        availableVoucherCount: vouchers.filter((v) => v.status === "AVAILABLE").length,
        archivedVoucherCount: d.archivedVoucherCount ?? 0,
        vouchers,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rewards.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Only fetch once auth has resolved and the user is signed in — an anonymous
  // request would 401 on every poll.
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setData(null);
      setIsLoading(false);
      return;
    }

    void refetch();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    const refreshAfterRewardEvent = () => void refetch();
    const id = setInterval(refreshWhenVisible, POLL_INTERVAL_MS);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener(REWARDS_CHANGED_EVENT, refreshAfterRewardEvent);

    return () => {
      clearInterval(id);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener(REWARDS_CHANGED_EVENT, refreshAfterRewardEvent);
    };
  }, [authLoading, isAuthenticated, refetch]);

  // Refresh at the next voucher expiry instead of leaving the action/badge
  // usable until the regular one-minute poll. Long timers are safely capped
  // and rescheduled when needed.
  useEffect(() => {
    if (!data) return;

    const now = Date.now();
    const nextExpiry = data.vouchers
      .filter((voucher) => voucher.status === "AVAILABLE" && voucher.expiresAt)
      .map((voucher) => new Date(voucher.expiresAt).getTime())
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > now)
      .sort((a, b) => a - b)[0];

    if (!nextExpiry) return;

    const id = window.setTimeout(
      () => void refetch(),
      Math.min(nextExpiry - now + 100, 2_147_483_647)
    );

    return () => window.clearTimeout(id);
  }, [data, refetch]);

  const availableVoucherCount = data?.availableVoucherCount ?? 0;

  const value = useMemo(
    () => ({ data, isLoading, error, availableVoucherCount, refetch, renewal, refreshRenewal }),
    [data, isLoading, error, availableVoucherCount, refetch, renewal, refreshRenewal]
  );

  return <RewardsContext.Provider value={value}>{children}</RewardsContext.Provider>;
}

/**
 * Read the shared rewards state. Must be called under <RewardsProvider>,
 * which the commuter layout mounts.
 */
export function useRewardsData(): RewardsContextValue {
  const ctx = useContext(RewardsContext);
  if (!ctx) {
    throw new Error("useRewardsData must be used within a RewardsProvider");
  }
  return ctx;
}
