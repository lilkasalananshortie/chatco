"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { Calculator } from "lucide-react";
import FareContent from "@/components/commuter/fare/fare-content";
import type { NearbyVehicle, GpsStatus } from "@/lib/shared/geo/nearby-detector";
import { useAuth } from "@/contexts/auth-context";
import { CommuterGreeting } from "@/components/commuter/commuter-greeting";
import { HailRangeHint } from "@/components/commuter/hail-range-hint";
import { NearbyUnitsCard } from "@/components/commuter/nearby-units-card";
import { createHail, cancelHail, isOutsideRadiusError } from "@/lib/commuter/services/hail.service";
import { useHoldToConfirm } from "@/hooks/use-hold-to-confirm";
import { ApiError, NetworkError } from "@/lib/api/client";

import PaymentHistoryModal from "@/components/commuter/modals/payment-history-modal";
import ShareRideModal from "@/components/commuter/modals/share-ride-modal";

const CommuterMap = dynamic(
  () => import("@/components/commuter/commuter-map/commuter-map"),
  { ssr: false, loading: () => <div className="absolute inset-0 bg-[#050F1A] light:bg-[#F7F5F2]" /> }
);

const ScanModal = dynamic(
  () => import("@/components/commuter/modals/scan-modal"),
  { ssr: false }
);

// How long a hail stays active before auto-turning-off. Matches the backend
// hails TTL (hails:expire) so the commuter's indicator and the conductor's pin
// clear at the same time.
const HAIL_DURATION_MS = 3 * 60 * 1000;
// Cadence of the vibrate + beep reminder while a hail is active.
const REMINDER_INTERVAL_MS = 4000;
// How long the hail button must be held before a hail is sent.
const HAIL_HOLD_MS = 600;

/**
 * HailService refuses with abort(422, reason) — a bare `{ message }` such as
 * "Vehicle is currently on break". Form validation 422s carry `errors` and a
 * generic "Validation failed", which isn't worth showing, so those return null.
 */
function hailRefusalReason(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const { message, errors } = body as { message?: unknown; errors?: unknown };
  return typeof message === "string" && message && !errors ? message : null;
}

export default function CommuterHome() {
  const { user, commuterProfile } = useAuth();

  const [showScan, setShowScan] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showShareRide, setShowShareRide] = useState(false);
  // Fare sheet (below lg): mounted only while open or sliding, so the fare
  // matrix fetch + live channel don't run on every dashboard visit.
  const [fareSheetMounted, setFareSheetMounted] = useState(false);
  const [fareSheetOpen, setFareSheetOpen] = useState(false);
  const openFareSheet = () => {
    setFareSheetMounted(true);
    // Two frames so the off-screen start position paints before it slides up.
    requestAnimationFrame(() => requestAnimationFrame(() => setFareSheetOpen(true)));
  };

  const [isHailing, setIsHailing] = useState(false);
  const [showSheet, setShowSheet] = useState(true);

  // ─── HAIL REQUEST STATE ─────────────────────────────────────────────
  // The active hail's id (so we can cancel it), an in-flight flag, and the
  // last error to surface in the UI.
  const [activeHailId, setActiveHailId] = useState<string | null>(null);
  const [hailPending, setHailPending] = useState(false);
  const [hailError, setHailError] = useState<string | null>(null);

  // ─── CONDUCTOR RADIUS + GPS TRACKING ────────────────────────────────
  const [nearbyVehicles, setNearbyVehicles] = useState<NearbyVehicle[]>([]);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("loading");
  const [commuterLocation, setCommuterLocation] = useState<[number, number] | null>(null);

  // canHail requires BOTH: GPS available AND commuter within conductor radius
  const canHail = gpsStatus === "available" && nearbyVehicles.length > 0;
  const nearestVehicle = canHail ? nearbyVehicles[0] : null;

  const handleNearbyVehiclesChange = useCallback(
    (vehicles: NearbyVehicle[], status: GpsStatus, location: [number, number] | null) => {
      setNearbyVehicles(vehicles);
      setGpsStatus(status);
      setCommuterLocation(location);
    },
    []
  );

  // ─── Vibrate + sound reminder helpers ───────────────────────────────
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Soft beep via Web Audio. The AudioContext is created/resumed from the
  // hail button's pointer release (a user gesture, see primeAudio), which
  // satisfies browser autoplay policies.
  const primeAudio = useCallback((): AudioContext | null => {
    try {
      if (!audioCtxRef.current) {
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return null;
        audioCtxRef.current = new Ctx();
      }
      if (audioCtxRef.current.state === "suspended") void audioCtxRef.current.resume();
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  const playBeep = useCallback(() => {
    try {
      const ctx = primeAudio();
      if (!ctx) return;
      [880, 1175, 880].forEach((frequency, index) => {
        const start = ctx.currentTime + index * 0.18;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.28, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.15);
      });
    } catch {
      /* audio unavailable — ignore */
    }
  }, [primeAudio]);

  const vibrate = useCallback(() => {
    // navigator.vibrate is Android/Chrome only; iOS Safari ignores it (sound
    // is the fallback there).
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([200, 100, 200]);
    }
  }, []);

  // Turn the hail off: best-effort cancel on the backend (it may already have
  // auto-expired, so errors are swallowed) then clear local state.
  const stopHail = useCallback(async () => {
    const id = activeHailId;
    setIsHailing(false);
    setActiveHailId(null);
    if (id) {
      try {
        await cancelHail(id);
      } catch {
        /* already expired / offline — backend TTL reconciles the record */
      }
    }
  }, [activeHailId]);

  const startHail = useCallback(async () => {
    if (!canHail || !nearestVehicle || !commuterLocation) return;
    setHailPending(true);
    setHailError(null);
    try {
      const hail = await createHail(
        nearestVehicle.id,
        commuterLocation[0],
        commuterLocation[1]
      );
      setActiveHailId(hail.id);
      setIsHailing(true);
      // Immediate confirmation buzz + beep (also unlocks the AudioContext).
      vibrate();
      playBeep();
    } catch (err) {
      if (err instanceof ApiError && isOutsideRadiusError(err.body)) {
        setHailError(
          `You're too far — about ${Math.round(err.body.distance_m)}m away. Move within 1km to hail.`
        );
      } else if (err instanceof ApiError && err.status === 409) {
        setHailError("You already have a pending hail.");
      } else if (err instanceof ApiError && err.status === 422 && hailRefusalReason(err.body)) {
        // e.g. the unit went on break between the map refresh and this hail.
        setHailError(hailRefusalReason(err.body));
      } else if (err instanceof ApiError || err instanceof NetworkError) {
        setHailError("Unable to send the hail. Please try again.");
      } else {
        setHailError("Something went wrong sending the hail.");
      }
    } finally {
      setHailPending(false);
    }
  }, [canHail, nearestVehicle, commuterLocation, vibrate, playBeep]);

  const handleHailToggle = useCallback(() => {
    if (hailPending) return;
    if (isHailing) {
      void stopHail();
    } else {
      void startHail();
    }
  }, [hailPending, isHailing, stopHail, startHail]);

  // Sending a hail takes a press-and-hold (HAIL_HOLD_MS) so a pocket tap or a
  // brush against the screen can't send one; releasing early cancels it.
  // Cancelling an active hail stays a single tap. The fill overlays on the
  // hail buttons use duration-600 to match.
  const hailHold = useHoldToConfirm(() => { void startHail(); }, canHail && !isHailing && !hailPending, HAIL_HOLD_MS);
  const hailButtonProps = isHailing
    ? { onClick: handleHailToggle }
    : {
        ...hailHold.handlers,
        onPointerUp: () => {
          // A touch hold completes while the finger is still down, which is not
          // a user gesture for autoplay; lifting it is, so unlock the reminder
          // beep's AudioContext here.
          primeAudio();
          hailHold.handlers.onPointerUp();
        },
      };
  const hailIdleLabel = hailHold.releasedEarly ? "Keep holding" : "Hold to Hail";

  // While a hail is active: repeat the vibrate + beep reminder so the commuter
  // doesn't forget it's on, and auto-turn-off after the TTL.
  useEffect(() => {
    if (!isHailing) return;

    const reminderId = window.setInterval(() => {
      vibrate();
      playBeep();
    }, REMINDER_INTERVAL_MS);

    const autoOffId = window.setTimeout(() => {
      void stopHail();
    }, HAIL_DURATION_MS);

    return () => {
      window.clearInterval(reminderId);
      window.clearTimeout(autoOffId);
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(0); // stop any ongoing vibration
      }
    };
  }, [isHailing, vibrate, playBeep, stopHail]);

  // Auto-stop the hail if the commuter leaves EVERY conductor's radius.
  // `nearbyVehicles` is the within-radius set, so an empty list (while GPS is
  // available) means no unit can reach us anymore — cancel the hail so we don't
  // keep buzzing a conductor who's driven off. We only act on a confirmed
  // "available but empty" reading; a transient GPS drop won't trigger it (the
  // 3-minute TTL still covers that case).
  useEffect(() => {
    if (isHailing && gpsStatus === "available" && nearbyVehicles.length === 0) {
      setHailError("Hail stopped — you moved out of range of all nearby units.");
      void stopHail();
    }
  }, [isHailing, gpsStatus, nearbyVehicles.length, stopHail]);

  // Explain why hailing is unavailable; an ongoing hail can still be cancelled.
  const hailHintReason = isHailing ? null
    : gpsStatus === "denied" ? "denied"
    : gpsStatus === "unavailable" ? "unavailable"
    : gpsStatus === "available" && !canHail ? "out-of-range"
    : null;

  // ─── Derive display values from auth context ────────────────────────
  const displayName = commuterProfile?.firstName ?? user?.email?.split("@")[0] ?? "Commuter";
  const commuterType = commuterProfile?.commuterType ?? "REGULAR";
  const commuterId = commuterProfile?.id ?? user?.id ?? "unknown";

  const shareRideAction = {
    label: "Share Ride",
    iconPath:
      "M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z",
    action: () => setShowShareRide(true),
  };

  // Desktop layouts move Payment History out of the GCash card into the quick actions.
  const desktopActions = [
    shareRideAction,
    {
      label: "Payment History",
      iconPath: "M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
      action: () => setShowHistory(true),
    },
  ];

  // ─── Desktop status blocks ───
  // Shared by the 1024–1279px side panel and the xl:+ top bar below: the same
  // markup, placed differently, so the two layouts can't drift apart in what
  // they show.
  const desktopStatus = (
    <>
          {gpsStatus === "loading" && (
            <div className="bg-white/5 border border-white/10 light:bg-gray-50 light:border-gray-200 rounded-xl p-4 flex items-center gap-3">
              <div className="w-5 h-5 rounded-full border-2 border-[#62A0EA] border-t-transparent animate-spin flex-shrink-0" />
              <div>
                <span className="text-sm text-white/60 light:text-gray-600">Locating you...</span>
                <p className="text-[10px] text-white/30 light:text-gray-400 mt-0.5">Waiting for GPS signal</p>
              </div>
            </div>
          )}

          {gpsStatus === "available" && <NearbyUnitsCard vehicles={nearbyVehicles} />}

    </>
  );

  const desktopHailError = hailError ? (
<div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 mb-3">
              <p className="text-xs font-semibold text-red-400 light:text-red-600">{hailError}</p>
            </div>
  ) : null;


  return (
    <div className="relative h-full w-full bg-[#050F1A] light:bg-[#F7F5F2]">
      {/* --- ACTUAL MAP --- */}
      <div className="absolute inset-0 z-0 lg:right-[336px] xl:right-0">
        <CommuterMap onNearbyVehiclesChange={handleNearbyVehiclesChange} />
      </div>

      {/* ========================================== */}
      {/* --- MOBILE UI (Hidden on Desktop) --- */}
      {/* ========================================== */}
      <div className="lg:hidden absolute top-0 inset-x-0 z-20 p-4 pointer-events-none">
        {/* Solid card, not a see-through one — it sits over a busy map. */}
        <div className="pointer-events-auto flex w-full rounded-2xl border border-white/10 bg-[#071A2E] py-2 pl-2 pr-4 shadow-lg shadow-black/30 light:border-gray-200 light:bg-white light:shadow-black/10">
          <CommuterGreeting
            variant="mobile"
            name={displayName}
            commuterType={commuterType}
            photoUrl={commuterProfile?.profileImageUrl}
          />
        </div>
      </div>

      {/* Collapsed offset is in px, not %: a % is relative to the sheet's own
          height, which grows with the nearby-units/GPS cards, so the taller the sheet the
          more of it peeked out. 64px keeps the drag handle visible and a further
          64px (+ safe area) parks it clear of the bottom nav. */}
      <div
        style={{
          transform: showSheet
            ? undefined
            : "translateY(calc(100% - 128px - env(safe-area-inset-bottom, 0px)))",
        }}
        className="lg:hidden absolute bottom-0 inset-x-0 z-20 bg-[#071A2E] rounded-t-3xl border-t border-white/10 light:bg-white light:border-gray-200 transition-transform duration-300 ease-in-out"
      >
        <div className="absolute -top-23 right-4 z-30">
          <button
            {...hailButtonProps}
            aria-label={isHailing ? "Cancel hail" : "Press and hold to hail"}
            disabled={hailPending || (!isHailing && !canHail)}
            className={`relative overflow-hidden select-none touch-none [-webkit-touch-callout:none] w-16 h-16 rounded-full flex items-center justify-center shadow-2xl transition-all duration-300 border-4 disabled:cursor-not-allowed ${
              isHailing
                ? "bg-red-500 border-red-300 shadow-black/40"
                : canHail
                  ? "bg-[#FF6D3A] border-[#FF9A76] hover:bg-[#e55a2b] shadow-black/40"
                  : "bg-gray-600 border-gray-500 shadow-gray-600/30 opacity-50 cursor-not-allowed"
            } ${hailPending ? "opacity-70" : ""}`}
          >
            {/* Hold progress: grows to fill the button over HAIL_HOLD_MS. */}
            <span
              aria-hidden
              className={`pointer-events-none absolute inset-0 rounded-full bg-white/30 transition-transform ease-linear ${hailHold.isHolding ? "scale-100 duration-600" : "scale-0 duration-150"}`}
            />
            {hailPending ? (
              <span className="relative w-7 h-7 rounded-full border-[3px] border-white/40 border-t-white animate-spin" />
            ) : isHailing ? (
              <svg className="relative w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg className="relative w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
              </svg>
            )}
          </button>
          <span className="block text-center text-[10px] font-extrabold text-white mt-2 drop-shadow-lg uppercase tracking-wider">
            {hailPending ? (isHailing ? "Cancelling…" : "Sending…") : isHailing ? "Cancel" : canHail ? hailIdleLabel : gpsStatus === "loading" ? "Locating..." : gpsStatus === "denied" || gpsStatus === "unavailable" ? "No GPS" : "Too Far"}
          </span>
          {hailHintReason && <HailRangeHint reason={hailHintReason} placement="above" className="-top-1 -right-1" />}
        </div>
        <div
          className="h-16 flex flex-col items-center justify-center cursor-pointer flex-shrink-0"
          onClick={() => setShowSheet(!showSheet)}
        >
          <div className={`w-10 h-1 rounded-full transition-colors duration-300 ${showSheet ? "bg-white/30 light:bg-gray-300" : "bg-white/60 light:bg-gray-400"}`} />
          {!showSheet && (
            <div className="flex items-center gap-1.5 mt-2 text-white/50 light:text-gray-500">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
              </svg>
              <span className="text-[10px] font-semibold uppercase tracking-wider">Tools</span>
            </div>
          )}
        </div>
        <div className="px-5 pb-24 overflow-y-auto max-h-[60vh]">
          {/* --- NEARBY UNITS / STATUS SECTION (Mobile) --- */}
          {gpsStatus === "loading" && (
            <div className="bg-white/5 border border-white/10 light:bg-gray-50 light:border-gray-200 rounded-xl p-3 mb-3 flex items-center gap-2.5">
              <div className="w-4 h-4 rounded-full border-2 border-[#62A0EA] border-t-transparent animate-spin flex-shrink-0" />
              <span className="text-xs text-white/50 light:text-gray-500">Locating you...</span>
            </div>
          )}

          {gpsStatus === "available" && <NearbyUnitsCard vehicles={nearbyVehicles} className="mb-3" />}

          {hailError && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 mb-3">
              <p className="text-xs font-semibold text-red-400 light:text-red-600">{hailError}</p>
            </div>
          )}

          {/* GCash Pay Card — commuter SCANS conductor's QR */}
          <div
            onClick={() => setShowScan(true)}
            className="relative rounded-2xl border border-white/10 bg-[#1A5FB4] overflow-hidden cursor-pointer hover:bg-[#164A8F] active:scale-[0.98] transition-all shadow-lg shadow-black/30"
          >
            {/* Subtle decorative circle */}
            <div className="absolute top-0 right-0 w-40 h-40 bg-white/[0.04] rounded-full -translate-y-1/2 translate-x-1/3" />
            <div className="relative p-5 flex items-center gap-4">
              {/* QR Scan visual */}
              <div className="w-14 h-14 rounded-2xl bg-white/10 backdrop-blur-sm flex items-center justify-center flex-shrink-0 border border-white/10">
                <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 6.75h.75v.75h-.75v-.75ZM6.75 16.5h.75v.75h-.75v-.75ZM16.5 6.75h.75v.75h-.75v-.75ZM13.5 13.5h.75v.75h-.75v-.75ZM13.5 19.5h.75v.75h-.75v-.75ZM19.5 13.5h.75v.75h-.75v-.75ZM19.5 19.5h.75v.75h-.75v-.75ZM16.5 16.5h.75v.75h-.75v-.75Z" />
                </svg>
              </div>
              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <p className="text-white text-lg font-bold leading-tight">Pay with GCash</p>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowHistory(true); }}
                    className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors border border-white/10"
                    title="Payment History"
                  >
                    <svg className="w-4 h-4 text-white/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                    </svg>
                  </button>
                </div>
                <p className="text-white/50 text-[11px] mt-1 leading-snug">
                  Tap to scan conductor&apos;s QR code
                </p>
                <div className="flex items-center gap-1.5 mt-2.5">
                  <span className="inline-flex items-center gap-1 bg-white/15 backdrop-blur-sm text-white text-[10px] font-semibold py-1 px-2.5 rounded-full">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75H6A2.25 2.25 0 0 0 3.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6v1.5m0 9V18A2.25 2.25 0 0 1 18 20.25h-1.5m-9 0H6A2.25 2.25 0 0 1 3.75 18v-1.5" />
                    </svg>
                    Scan to Pay
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Share Ride + Fare Matrix (Fare's tab is dropped from the mobile nav) */}
          <div className="grid grid-cols-2 gap-3 mt-4">
            <button onClick={shareRideAction.action} className="flex items-center justify-center gap-2 py-2.5 rounded-xl transition-colors bg-white/5 hover:bg-white/10 border border-white/10 light:bg-white light:hover:bg-gray-50 light:border-gray-100 light:shadow-[0_2px_10px_rgba(15,23,42,0.08)]">
              <svg className="w-4 h-4 text-blue-300 light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={shareRideAction.iconPath} />
              </svg>
              <span className="text-xs font-semibold text-white/70 light:text-gray-700">{shareRideAction.label}</span>
            </button>
            <button onClick={openFareSheet} className="flex items-center justify-center gap-2 py-2.5 rounded-xl transition-colors bg-white/5 hover:bg-white/10 border border-white/10 light:bg-white light:hover:bg-gray-50 light:border-gray-100 light:shadow-[0_2px_10px_rgba(15,23,42,0.08)]">
              <Calculator className="w-4 h-4 text-blue-300 light:text-[#1A5FB4]" strokeWidth={1.5} />
              <span className="text-xs font-semibold text-white/70 light:text-gray-700">Fare Matrix</span>
            </button>
          </div>
        </div>
      </div>

      {/* ========================================== */}
      {/* --- DESKTOP UI (Hidden on Mobile) --- */}
      {/* ========================================== */}
      <div className="hidden lg:flex xl:hidden absolute right-4 top-4 bottom-4 w-80 z-20 bg-[#071A2E]/95 backdrop-blur-xl rounded-2xl border border-white/10 light:bg-white/95 light:border-gray-200 shadow-2xl flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-white/10 light:border-gray-200">
          <CommuterGreeting
            variant="panel"
            name={displayName}
            commuterType={commuterType}
            photoUrl={commuterProfile?.profileImageUrl}
          />
        </div>
        <div className="flex-1 p-6 overflow-y-auto space-y-6">
          {/* GCash Pay Card — Desktop */}
          <div
            onClick={() => setShowScan(true)}
            className="relative rounded-2xl border border-white/10 bg-[#1A5FB4] overflow-hidden cursor-pointer hover:bg-[#164A8F] active:scale-[0.98] transition-all shadow-lg shadow-black/30"
          >
            {/* Subtle decorative circle */}
            <div className="absolute top-0 right-0 w-40 h-40 bg-white/[0.04] rounded-full -translate-y-1/2 translate-x-1/3" />
            <div className="relative p-5 flex items-center gap-5">
              {/* QR Scan visual */}
              <div className="w-16 h-16 rounded-2xl bg-white/10 backdrop-blur-sm flex items-center justify-center flex-shrink-0 border border-white/10">
                <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 6.75h.75v.75h-.75v-.75ZM6.75 16.5h.75v.75h-.75v-.75ZM16.5 6.75h.75v.75h-.75v-.75ZM13.5 13.5h.75v.75h-.75v-.75ZM13.5 19.5h.75v.75h-.75v-.75ZM19.5 13.5h.75v.75h-.75v-.75ZM19.5 19.5h.75v.75h-.75v-.75ZM16.5 16.5h.75v.75h-.75v-.75Z" />
                </svg>
              </div>
              {/* Content */}
              <div className="flex-1 min-w-0">
                <p className="text-white text-lg font-bold leading-tight">Pay with GCash</p>
                <p className="text-white/50 text-xs mt-1 leading-snug">
                  Tap to scan conductor&apos;s QR code
                </p>
                <div className="flex items-center gap-1.5 mt-3">
                  <span className="inline-flex items-center gap-1.5 bg-white/15 backdrop-blur-sm text-white text-xs font-semibold py-1.5 px-3 rounded-full">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75H6A2.25 2.25 0 0 0 3.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6v1.5m0 9V18A2.25 2.25 0 0 1 18 20.25h-1.5m-9 0H6A2.25 2.25 0 0 1 3.75 18v-1.5" />
                    </svg>
                    Scan to Pay
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* --- NEARBY UNITS / STATUS SECTION (Desktop) --- */}
          {desktopStatus}
          {/* Quick Actions */}
          <div>
            <h3 className="text-xs font-semibold text-white/30 light:text-gray-400 uppercase tracking-wider mb-2">Quick Actions</h3>
            <div className="grid grid-cols-2 gap-3">
              {desktopActions.map((action) => (
                <button key={action.label} onClick={action.action} className="flex items-center justify-center gap-2 py-2.5 rounded-xl transition-colors bg-white/5 hover:bg-white/10 border border-white/10 light:bg-gray-50 light:hover:bg-gray-100 light:border-gray-200">
                  <svg className="w-4 h-4 text-blue-300 light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={action.iconPath} />
                  </svg>
                  <span className="text-xs font-semibold text-white/70 light:text-gray-700 whitespace-nowrap">
                    {action.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="p-6 border-t border-white/10 light:border-gray-200">
          {desktopHailError}
          <div className="relative">
          <button
            {...hailButtonProps}
            disabled={hailPending || (!isHailing && !canHail)}
            className={`relative overflow-hidden select-none touch-none [-webkit-touch-callout:none] w-full flex items-center justify-center gap-3 py-4 rounded-xl text-base font-bold transition-all duration-300 disabled:cursor-not-allowed ${
              isHailing
                ? "bg-red-500 hover:bg-red-600 shadow-lg shadow-black/30"
                : canHail
                  ? "bg-[#FF6D3A] hover:bg-[#e55a2b] shadow-lg shadow-black/30 text-white"
                  : "bg-gray-600 text-gray-300 light:bg-gray-200 light:text-gray-500 cursor-not-allowed shadow-none"
            } ${hailPending ? "opacity-70" : ""}`}
          >
            {/* Hold progress: sweeps left to right over HAIL_HOLD_MS. */}
            <span
              aria-hidden
              className={`pointer-events-none absolute inset-0 origin-left bg-white/25 transition-transform ease-linear ${hailHold.isHolding ? "scale-x-100 duration-600" : "scale-x-0 duration-150"}`}
            />
            <span className="relative flex items-center justify-center gap-3">
              {hailPending ? (
                <>
                  <span className="w-6 h-6 rounded-full border-[3px] border-white/40 border-t-white animate-spin" />{" "}
                  {isHailing ? "Cancelling…" : "Sending…"}
                </>
              ) : isHailing ? (
                <>
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>{" "}
                  Cancel Hail
                </>
              ) : (
                <>
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
                  </svg>{" "}
                  {gpsStatus === "loading" ? "Locating..." : gpsStatus === "denied" || gpsStatus === "unavailable" ? "No GPS Access" : canHail ? hailIdleLabel : "Outside Service Radius"}
                </>
              )}
            </span>
          </button>
          {hailHintReason && <HailRangeHint reason={hailHintReason} placement="above" className="right-3 top-1/2 -translate-y-1/2" />}
          </div>
        </div>
      </div>

      {/* ========================================== */}
      {/* --- LARGE-SCREEN UI (xl:+ only) --- */}
      {/* ========================================== */}
      {/* Wide-screen counterpart to the side panel above, laid out like the
          conductor's DesktopDashboardBar: one compact strip docked top-center
          over a full-bleed map (the panel reserved 400px of its width). Same
          identity, GCash entry, quick actions and hail control as the panel,
          sized to the dock's scale — small type, one row height, thin
          dividers — instead of the panel's large cards. The GPS/ETA status
          cards and hail error hang in their own card under the strip and
          disappear when there is nothing to show. The panel still serves
          1024–1279px. */}
      <div className="hidden xl:flex absolute top-4 left-1/2 -translate-x-1/2 z-20 flex-col items-center gap-3 max-w-[calc(100%-2rem)] pointer-events-none">
        <div className="pointer-events-auto flex items-center divide-x divide-white/10 bg-[#071A2E]/95 backdrop-blur-xl rounded-2xl border border-white/10 light:divide-gray-200 light:bg-white/95 light:border-gray-200 shadow-2xl shadow-black/10">
          {/* Identity */}
          <div className="min-w-0 max-w-[22rem] px-4 py-3">
            <CommuterGreeting
              variant="bar"
              name={displayName}
              commuterType={commuterType}
              photoUrl={commuterProfile?.profileImageUrl}
            />
          </div>

          {/* GCash pay + history */}
          <div className="flex items-center gap-2 px-4 py-3">
            <button
              type="button"
              onClick={() => setShowScan(true)}
              className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#1A5FB4] pl-2.5 pr-4 py-2 text-left cursor-pointer hover:bg-[#164A8F] active:scale-[0.98] transition-all shadow-lg shadow-black/30"
            >
              <span className="w-9 h-9 rounded-lg bg-white/10 border border-white/10 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 6.75h.75v.75h-.75v-.75ZM6.75 16.5h.75v.75h-.75v-.75ZM16.5 6.75h.75v.75h-.75v-.75ZM13.5 13.5h.75v.75h-.75v-.75ZM13.5 19.5h.75v.75h-.75v-.75ZM19.5 13.5h.75v.75h-.75v-.75ZM19.5 19.5h.75v.75h-.75v-.75ZM16.5 16.5h.75v.75h-.75v-.75Z" />
                </svg>
              </span>
              <span className="min-w-0">
                <span className="block text-white text-sm font-bold leading-tight whitespace-nowrap">Pay with GCash</span>
                <span className="block text-white/60 text-[10px] leading-tight mt-0.5 whitespace-nowrap">Tap to scan conductor&apos;s QR code</span>
              </span>
            </button>
          </div>

          {/* Quick actions */}
          <div className="flex flex-col justify-center gap-1.5 px-4 py-3">
            <p className="text-[10px] font-semibold text-white/40 light:text-gray-500 uppercase tracking-wider whitespace-nowrap">Quick Actions</p>
            {/* 1fr (not grid-cols-2's minmax(0,1fr)) so both columns grow to the wider label instead of squeezing it. */}
            <div className="grid grid-cols-[1fr_1fr] gap-1.5">
              {desktopActions.map((action) => (
                <button
                  key={action.label}
                  onClick={action.action}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer border bg-white/5 hover:bg-white/10 border-white/10 light:bg-gray-50 light:hover:bg-gray-100 light:border-gray-200 text-white/70 light:text-gray-700"
                >
                  <svg className="w-3.5 h-3.5 text-blue-300 light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={action.iconPath} />
                  </svg>
                  {action.label}
                </button>
              ))}
            </div>
          </div>

          {/* Hail */}
          <div className="relative flex items-center px-4 py-3">
            <button
              {...hailButtonProps}
              disabled={hailPending || (!isHailing && !canHail)}
              className={`relative overflow-hidden select-none touch-none [-webkit-touch-callout:none] flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold whitespace-nowrap transition-all duration-300 cursor-pointer disabled:cursor-not-allowed ${
                isHailing
                  ? "bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-black/30"
                  : canHail
                    ? "bg-[#FF6D3A] hover:bg-[#e55a2b] shadow-lg shadow-black/30 text-white"
                    : "bg-gray-600 text-gray-300 light:bg-gray-200 light:text-gray-500 shadow-none"
              } ${hailPending ? "opacity-70" : ""}`}
            >
              {/* Hold progress: sweeps left to right over HAIL_HOLD_MS. */}
              <span
                aria-hidden
                className={`pointer-events-none absolute inset-0 origin-left bg-white/25 transition-transform ease-linear ${hailHold.isHolding ? "scale-x-100 duration-600" : "scale-x-0 duration-150"}`}
              />
              <span className="relative flex items-center justify-center gap-2">
                {hailPending ? (
                  <>
                    <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                    {isHailing ? "Cancelling…" : "Sending…"}
                  </>
                ) : isHailing ? (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                    Cancel Hail
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
                    </svg>
                    {gpsStatus === "loading" ? "Locating..." : gpsStatus === "denied" || gpsStatus === "unavailable" ? "No GPS Access" : canHail ? hailIdleLabel : "Outside Service Radius"}
                  </>
                )}
              </span>
            </button>
            {hailHintReason && <HailRangeHint reason={hailHintReason} placement="below" className="top-1.5 right-2" />}
          </div>
        </div>

        <div className="pointer-events-auto empty:hidden w-[26rem] max-w-full space-y-3 p-3 bg-[#071A2E] rounded-2xl border border-[#1C3350] light:bg-white light:border-gray-200 shadow-2xl shadow-black/10 [&>*:last-child]:mb-0">
          {desktopStatus}
          {desktopHailError}
        </div>
      </div>

      {/* --- FARE SHEET (below lg) --- */}
      {/* z-40 keeps it under the layout's z-50 bottom nav, so it rises from
          behind the nav to the top of the screen and slides back down behind it. */}
      {fareSheetMounted && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Fare Matrix"
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget && !fareSheetOpen) setFareSheetMounted(false);
          }}
          className={`lg:hidden absolute inset-0 z-40 transition-transform duration-300 ease-out ${fareSheetOpen ? "translate-y-0" : "translate-y-full"}`}
        >
          <FareContent onClose={() => setFareSheetOpen(false)} />
        </div>
      )}

      {/* --- MODALS --- */}
      {showScan && (
        <ScanModal
          commuterId={commuterId}
          commuterName={displayName}
          onClose={() => setShowScan(false)}
        />
      )}
      {showHistory && (
        <PaymentHistoryModal onClose={() => setShowHistory(false)} />
      )}
      {showShareRide && (
        <ShareRideModal
          commuterName={displayName}
          onClose={() => setShowShareRide(false)}
        />
      )}
    </div>
  );
}
