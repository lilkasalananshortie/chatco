"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle, Check, CheckCircle2, Loader2, MapPin, X } from "lucide-react";
import { APP_DIALOG as D } from "@/components/shared/app-dialog-styles";
import { useAuth } from "@/contexts/auth-context";
import {
  attachShareLink,
  beginShareTracking,
  getActiveShareLink,
  stopShareTracking,
  subscribeShareGpsStatus,
  type ShareGpsStatus,
} from "@/lib/commuter/share-ride-tracker";

interface ShareRideModalProps {
  commuterName: string;
  commuterId?: string;
  lat?: number;
  lng?: number;
  onClose: () => void;
}

export default function ShareRideModal({ commuterName, lat: propLat, lng: propLng, onClose }: ShareRideModalProps) {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  // `error` is a Stop sharing failure on the live view; `createError` keeps the
  // intro on screen so Generate link doubles as retry.
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  // Reopened mid-share: show the live link straight away (same URL family already has).
  const [shareUrl, setShareUrl] = useState<string>(() => {
    const active = getActiveShareLink();
    return active ? `${window.location.origin}/share/${active.token}` : "";
  });
  const [expiresAt, setExpiresAt] = useState<string>(() => getActiveShareLink()?.expiresAt ?? "");
  // Only blocks the view when this tab has nothing to show yet; a local link
  // renders at once and is reconciled in the background.
  const [isChecking, setIsChecking] = useState(() => !getActiveShareLink());
  const mountedRef = useRef(true);
  // Set by Generate / Stop so a slower account check can't overwrite their result.
  const userActedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Account check: a link started in another tab or device opens on the
  // live view, and one stopped elsewhere drops this tab back to the intro. ──
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/commuter/share-ride", { headers: { Accept: "application/json" }, cache: "no-store" });
        // Unknown state: keep what's shown. Generate link reuses a live link anyway (rotate:false).
        if (!res.ok) return;
        const live: { token: string; expires_at: string } | null = (await res.json())?.data ?? null;
        if (cancelled || userActedRef.current) return;

        const local = getActiveShareLink();
        if (live) {
          if (local?.token !== live.token) {
            // Push from this device too, as Generate link would have.
            beginShareTracking();
            attachShareLink(live.token, live.expires_at, user?.id ?? "");
          }
          setShareUrl(`${window.location.origin}/share/${live.token}`);
          setExpiresAt(live.expires_at);
          setIsExpired(false);
        } else if (local) {
          stopShareTracking();
          setShareUrl("");
          setExpiresAt("");
        }
      } catch {
        // Offline: same as a failed check.
      } finally {
        if (!cancelled) setIsChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [timeLeft, setTimeLeft] = useState(0);
  const [isCopied, setIsCopied] = useState(false);
  const [isExpired, setIsExpired] = useState(false);
  const [gpsStatus, setGpsStatus] = useState<ShareGpsStatus>("idle");
  const [isStopping, setIsStopping] = useState(false);
  const [isStopped, setIsStopped] = useState(false);

  // GPS status comes from the tracker, which keeps pushing the position
  // after this modal closes (lib/commuter/share-ride-tracker.ts).
  useEffect(() => subscribeShareGpsStatus(setGpsStatus), []);

  // ── Create (or reuse) the share link when the commuter taps Generate link ──
  // Closing the modal afterwards only stops this view. Position pushes carry on
  // until Stop sharing or expiry, so the viewer's map keeps moving.
  const handleGenerate = useCallback(async () => {
    if (isLoading) return;
    userActedRef.current = true;
    const ownerId = user?.id;
    setIsLoading(true);
    setCreateError(null);

    // Start GPS in parallel with link creation; the tracker holds the first
    // fix and sends it as soon as the link exists.
    beginShareTracking();

    try {
      // rotate:false reuses the commuter's active link (e.g. after a reload
      // in another tab), so the URL already sent to family keeps working.
      const res = await fetch("/api/commuter/share-ride", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          lat: propLat ?? undefined,
          lng: propLng ?? undefined,
          rotate: false,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? "Failed to create share link.");
      }

      const json = await res.json();
      const data = json.data;
      if (!mountedRef.current) {
        // Closed before the URL was ever shown, so nobody has this link to
        // watch — unless it was already live from an earlier open.
        if (!getActiveShareLink()) stopShareTracking();
        return;
      }
      attachShareLink(data.token, data.expires_at, ownerId ?? "");
      // Always construct the share URL using the frontend's origin (port 3000).
      setShareUrl(`${window.location.origin}/share/${data.token}`);
      setExpiresAt(data.expires_at);
      setIsExpired(false);
    } catch (err) {
      // No link to push to — don't leave GPS running for nothing.
      if (!getActiveShareLink()) stopShareTracking();
      if (mountedRef.current) setCreateError(err instanceof Error ? err.message : "Failed to create share link.");
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [isLoading, user?.id, propLat, propLng]);

  // ── Countdown timer ──
  useEffect(() => {
    if (!expiresAt) return;

    const updateTimer = () => {
      const remaining = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
      if (remaining <= 0) {
        setTimeLeft(0);
        setIsExpired(true);
        return false;
      }
      setTimeLeft(remaining);
      return true;
    };

    if (!updateTimer()) return;

    const timer = setInterval(() => {
      if (!updateTimer()) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [expiresAt]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // Fallback
    }
  }, [shareUrl]);

  const handleStopSharing = useCallback(async () => {
    if (isStopping) return;
    userActedRef.current = true;
    setIsStopping(true);
    try {
      const response = await fetch("/api/commuter/share-ride", { method: "DELETE" });
      if (!response.ok) throw new Error("Unable to stop sharing.");
      // Stop pushing only once the link is really off; a push already in
      // flight is refused by the backend (409) rather than reviving it.
      stopShareTracking();
      setIsStopped(true);
      setTimeout(onClose, 1200);
    } catch {
      setError("Unable to stop location sharing. Please try again.");
    } finally {
      setIsStopping(false);
    }
  }, [isStopping, onClose]);

  const stopsAt = expiresAt
    ? new Date(expiresAt).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" })
    : null;

  return (
    <div className={D.overlay} onClick={!isLoading ? (e) => { if (e.target === e.currentTarget) onClose(); } : undefined}>
      <div role="dialog" aria-modal="true" aria-labelledby="share-ride-title" className={`${D.panel} max-w-md animate-fade-in`}>
        <button type="button" onClick={onClose} aria-label="Close share live location" title="Close" className={D.close}>
          <X className="h-5 w-5" />
        </button>

        <div className="space-y-5 p-5 sm:p-6">
          <h2 id="share-ride-title" className={`${D.title} pr-10`}>Share live location</h2>

          {isChecking ? (
            <div className="flex flex-col items-center justify-center gap-3 py-10">
              <Loader2 className={`h-8 w-8 animate-spin ${D.blueIcon}`} aria-hidden="true" />
              <p className={`text-sm ${D.muted}`}>Checking for an active link…</p>
            </div>
          ) : isStopped ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <CheckCircle2 className={`h-10 w-10 ${D.blueIcon}`} aria-hidden="true" />
              <h3 className={D.title}>Location sharing stopped</h3>
              <p className={`text-sm ${D.muted}`}>The tracking link is no longer active.</p>
            </div>
          ) : error ? (
            <div className="space-y-4">
              <p role="alert" className={`flex items-start gap-2 text-sm leading-relaxed ${D.redText}`}>
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {error}
              </p>
              <button type="button" onClick={onClose} className={`${D.button} ${D.secondary} w-full`}>Close</button>
            </div>
          ) : !shareUrl ? (
            <div className="space-y-4">
              <p className={`text-sm leading-relaxed ${D.muted}`}>
                Generate a link that shows your live location on the map. Anyone with it can follow your ride for 30 minutes.{" "}
                <span className="font-semibold text-white/90 light:text-gray-800">Only send it to people you trust.</span>
              </p>

              {createError && (
                <p role="alert" className={`flex items-start gap-2 text-sm leading-relaxed ${D.redText}`}>
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {createError}
                </p>
              )}

              <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
                <button type="button" onClick={onClose} className={`${D.button} ${D.secondary}`}>Cancel</button>
                <button type="button" onClick={handleGenerate} disabled={isLoading} aria-busy={isLoading} className={`${D.button} ${D.primary}`}>
                  {isLoading
                    ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Generating…</>
                    : createError ? "Try again" : "Generate link"}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Countdown: the one number a commuter checks at a glance. */}
              <section aria-live="polite" aria-atomic="true">
                <p className={D.label}>{isExpired ? "Link expired" : "Link active for"}</p>
                <p className={`mt-1 text-4xl font-bold tracking-tight tabular-nums ${isExpired ? D.redText : "text-white light:text-gray-900"}`}>
                  {isExpired ? "00:00" : formatTime(timeLeft)}
                </p>
                <p className={`mt-1 text-sm ${D.muted}`}>
                  {isExpired
                    ? "This link no longer shows your location."
                    : stopsAt
                      ? `${timeLeft <= 300 ? "Ending soon. " : ""}Stops sharing automatically at ${stopsAt}`
                      : "Stops sharing automatically after 30 minutes"}
                </p>
              </section>

              {!isExpired && (
                <p className={`flex items-start gap-2 text-sm leading-relaxed ${gpsStatus === "error" ? D.redText : gpsStatus === "success" ? "text-white/85 light:text-gray-800" : D.muted}`}>
                  {gpsStatus === "requesting"
                    ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                    : <MapPin className={`mt-0.5 h-4 w-4 shrink-0 ${gpsStatus === "success" ? D.blueIcon : ""}`} aria-hidden="true" />}
                  <span>
                    {gpsStatus === "success" && "GPS connected, sharing your live position"}
                    {gpsStatus === "error" && "GPS unavailable. The link works, but it can't show your position yet. Move to an open area for a better signal."}
                    {gpsStatus === "requesting" && "Connecting to GPS…"}
                    {gpsStatus === "idle" && "Waiting for GPS…"}
                  </span>
                </p>
              )}

              <div className="flex items-stretch gap-2">
                <div className={`flex min-w-0 flex-1 items-center rounded-lg px-3 ${D.field}`}>
                  <p className={`truncate font-mono text-xs ${isExpired ? "text-white/40 light:text-gray-400" : "text-white/80 light:text-gray-700"}`}>{shareUrl}</p>
                </div>
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={isExpired}
                  aria-label={isCopied ? "Link copied" : "Copy link"}
                  className={`${D.button} ${D.primary} shrink-0`}
                >
                  {isCopied ? <><Check className="h-4 w-4" aria-hidden="true" />Copied</> : "Copy"}
                </button>
              </div>

              <p className={`text-xs leading-relaxed ${D.muted}`}>
                Anyone with this link can track your live location on the map for 30 minutes.{" "}
                <span className="font-semibold text-white/90 light:text-gray-800">Do not share it with people you don&apos;t trust.</span>{" "}
                Keep this app open for live updates.
              </p>

              {isExpired && createError && (
                <p role="alert" className={`flex items-start gap-2 text-sm leading-relaxed ${D.redText}`}>
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {createError}
                </p>
              )}

              <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
                {isExpired ? (
                  <>
                    <button type="button" onClick={onClose} className={`${D.button} ${D.secondary}`}>Close</button>
                    <button type="button" onClick={handleGenerate} disabled={isLoading} aria-busy={isLoading} className={`${D.button} ${D.primary}`}>
                      {isLoading
                        ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Generating…</>
                        : "Generate new link"}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={handleStopSharing} disabled={isStopping} className={`${D.button} ${D.dangerSecondary}`}>
                      {isStopping ? "Stopping…" : "Stop sharing"}
                    </button>
                    <button type="button" onClick={onClose} className={`${D.button} ${D.primary}`}>Keep sharing</button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
