"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "laravel-echo";
import { getEcho } from "@/lib/echo";
import { fetchActiveHails, type ConductorHailRequest } from "@/lib/conductor/services/hails.service";
import { alertNewHail } from "@/lib/shared/geo/proximity-notification";

interface UseConductorHailsResult {
  hails: ConductorHailRequest[];
  status: "loading" | "success" | "error" | "empty";
  error: string | null;
  refresh: () => Promise<void>;
}

export function useConductorHails(
  vehicleId?: string,
  pollMs = 10000
): UseConductorHailsResult {
  const [hails, setHails] = useState<ConductorHailRequest[]>([]);
  const [status, setStatus] = useState<UseConductorHailsResult["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshPending = useRef(false);
  // Hail ids already shown; null until the first successful load, so hails
  // already waiting when the dashboard opens don't trigger the alert.
  const seenHailIds = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      // An event can arrive after the current GET took its database snapshot.
      // Coalesce the burst into one follow-up GET rather than losing the event.
      refreshPending.current = true;
      return refreshInFlight.current;
    }

    const request = (async () => {
      try {
        do {
          refreshPending.current = false;
          const { hails: fetchedHails, error: fetchError } = await fetchActiveHails();
          // Diff by id after each fetch so the alert fires whether the hail
          // arrived by Pusher event or by the polling fallback. Skip failed
          // fetches so a blip doesn't re-alert hails already seen.
          if (!fetchError) {
            const seen = seenHailIds.current;
            if (seen && fetchedHails.some((h) => !seen.has(h.id))) alertNewHail();
            seenHailIds.current = new Set(fetchedHails.map((h) => h.id));
          }
          setHails(fetchedHails);
          setError(fetchError);
          setStatus(
            fetchError ? "error" : fetchedHails.length > 0 ? "success" : "empty"
          );
        } while (refreshPending.current);
      } catch (err) {
        setHails([]);
        setStatus("error");
        setError(err instanceof Error ? err.message : "Unable to load hail requests.");
      } finally {
        refreshInFlight.current = null;
      }
    })();

    refreshInFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    // New unit/shift: its existing hails are a baseline, not new arrivals.
    seenHailIds.current = null;
    void refresh();

    let isSubscribed = false;
    let lastRefreshAt = Date.now();
    let unsubscribeConnectionChange: (() => void) | null = null;
    let echo: ReturnType<typeof getEcho> | null = null;
    const channelName = vehicleId ? `vehicle.${vehicleId}.hails` : null;

    const refreshNow = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      lastRefreshAt = Date.now();
      void refresh();
    };
    const interval = window.setInterval(() => {
      // A connected transport does not guarantee private-channel delivery.
      // Keep a slow reconciliation even when subscribed; poll faster on failure.
      const refreshMs = isSubscribed ? Math.max(pollMs, 60000) : pollMs;
      if (channelName && Date.now() - lastRefreshAt >= refreshMs) refreshNow();
    }, pollMs);

    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", refreshNow);

    if (channelName) {
      try {
        echo = getEcho();
        unsubscribeConnectionChange = echo.connector.onConnectionChange(
          (connectionStatus: ConnectionStatus) => {
            if (connectionStatus !== "connected") isSubscribed = false;
          }
        );
        echo
          .private(channelName)
          .listen(".HailCreated", refreshNow)
          .listen(".HailStatusChanged", refreshNow)
          .subscribed(() => {
            isSubscribed = true;
            // Catch hails created before authentication or during a reconnect.
            refreshNow();
          })
          .error(() => {
            isSubscribed = false;
            refreshNow();
          });
      } catch (subscriptionError) {
        console.warn("Hail realtime unavailable; using polling fallback:", subscriptionError);
      }
    }

    return () => {
      window.clearInterval(interval);
      unsubscribeConnectionChange?.();
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", refreshNow);
      if (echo && channelName) echo.leave(channelName);
    };
  }, [pollMs, refresh, vehicleId]);

  return { hails, status, error, refresh };
}
