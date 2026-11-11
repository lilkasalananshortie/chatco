"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { claimCashReceipt, type ReceiptClaimResult } from "@/lib/commuter/services/payment.service";
import { ApiError, NetworkError } from "@/lib/api/client";
import { formatPeso } from "@/lib/utils/display";
import { notifyRewardsChanged } from "@/lib/commuter/rewards-events";

interface ReceiptScanModalProps {
  onClose: () => void;
}

/**
 * Commuter Receipt Scan Modal — paper cash receipt → reward credit.
 *
 * Cash rides involve no account, so they are recorded with no passenger and
 * never reach anyone's reward cycle. The printed receipt carries a QR holding
 * the transaction's opaque token; scanning it here binds the ride to this
 * commuter, which is what counts it toward the free-ride cycle.
 *
 * Steps:
 *   scanning   — camera is live (manual entry offered if the camera fails)
 *   verifying  — POSTing the token
 *   success    — claimed (or already claimed by this same commuter)
 *   expired    — receipt older than the server-side TTL (410)
 *   failed     — unrecognised, already someone else's, or not a cash ride
 *
 * The camera lifecycle mirrors scan-modal.tsx: html5-qrcode throws if stop()
 * is called on a scanner that never started, so a ref tracks running state and
 * guards every stop.
 */
type Step = "scanning" | "verifying" | "success" | "expired" | "failed";

export default function ReceiptScanModal({ onClose }: ReceiptScanModalProps) {
  const [step, setStep] = useState<Step>("scanning");
  const [result, setResult] = useState<ReceiptClaimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualToken, setManualToken] = useState("");
  // Camera first, always. Manual entry is opt-in, or automatic only when the
  // camera genuinely could not start.
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [cameraFailed, setCameraFailed] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const scannerRunningRef = useRef(false);
  const scannerContainerId = "receipt-qr-reader";

  // ─── Safely stop the scanner ───
  const stopScanner = useCallback(async () => {
    if (!scannerRef.current) return;
    if (!scannerRunningRef.current) return;

    try {
      await scannerRef.current.stop();
    } catch {
      // Already stopped or never started — ignore.
    } finally {
      scannerRunningRef.current = false;
      try {
        scannerRef.current?.clear();
      } catch {
        // clear() can also throw if the element is gone — ignore.
      }
      scannerRef.current = null;
    }
  }, []);

  // ─── Submit a scanned/typed token ───
  const submitToken = useCallback(async (qrToken: string) => {
    setStep("verifying");
    setError(null);

    try {
      const claim = await claimCashReceipt(qrToken.trim());
      setResult(claim);
      setStep("success");
      // Only refetch when a ride was actually credited. Re-scanning your own
      // receipt is a no-op server-side, so it must not imply new progress.
      if (!claim.alreadyClaimed) notifyRewardsChanged();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 410) {
          setStep("expired");
          return;
        }
        const body = err.body as { message?: string } | null;
        setError(
          body?.message ??
            (err.status === 409
              ? "This receipt has already been claimed."
              : err.status === 404
                ? "We don't recognise this QR code."
                : "This receipt can't be claimed.")
        );
      } else if (err instanceof NetworkError) {
        setError("You appear to be offline. Reconnect and try again.");
      } else {
        setError("Something went wrong claiming this receipt.");
      }
      setStep("failed");
    }
  }, []);

  // Held in a ref so the scanner effect below does not depend on submitToken's
  // identity. It closes over onClaimed, which callers pass inline, so it changes
  // on every parent render — as an effect dep it would tear down and restart the
  // camera each render until start() failed and dumped us into manual entry.
  const submitTokenRef = useRef(submitToken);
  useEffect(() => {
    submitTokenRef.current = submitToken;
  }, [submitToken]);

  // ─── Camera lifecycle (scanning step only) ───
  useEffect(() => {
    if (step !== "scanning" || showManualEntry) return;
    let mounted = true;

    const startScanner = async () => {
      try {
        const html5QrCode = new Html5Qrcode(scannerContainerId);
        scannerRef.current = html5QrCode;

        await html5QrCode.start(
          { facingMode: "environment" },
          // Scan box spans the whole camera view, so the frame corners sit at its edges.
          { fps: 10, qrbox: (viewfinderWidth, viewfinderHeight) => ({ width: viewfinderWidth, height: viewfinderHeight }) },
          (decodedText) => {
            if (!mounted) return;
            void stopScanner();
            void submitTokenRef.current(decodedText);
          },
          () => {
            // Per-frame decode failure — the scanner keeps trying.
          }
        );

        // start() resolved, so the camera IS live now — record that before
        // checking mount state. Setting it only in the mounted branch would
        // leave stopScanner() bailing on its own guard below, leaking a
        // running camera when the modal closed mid-start.
        scannerRunningRef.current = true;

        // Effect was cleaned up while start() was in flight (fast close, or
        // StrictMode's double-invoke in dev) — release it immediately.
        if (!mounted) void stopScanner();
      } catch {
        // Genuine camera failure (no device, permission denied) — only then do
        // we fall back to typing the code. The camera is always tried first.
        if (mounted) {
          setCameraFailed(true);
          setShowManualEntry(true);
        }
        scannerRef.current = null;
      }
    };

    void startScanner();

    return () => {
      mounted = false;
      void stopScanner();
    };
    // submitToken is deliberately absent — it is read through a ref so that a
    // new onClaimed on the parent's next render cannot restart the camera.
  }, [step, showManualEntry, stopScanner]);

  // Release the camera when the whole modal unmounts.
  useEffect(() => {
    return () => {
      void stopScanner();
    };
  }, [stopScanner]);

  // Back to a live camera, not to whatever input mode failed last time.
  const retry = () => {
    setResult(null);
    setError(null);
    setManualToken("");
    setCameraFailed(false);
    setShowManualEntry(false);
    setStep("scanning");
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-[#071A2E] w-full max-w-sm rounded-2xl border border-white/10 light:bg-white light:border-gray-200 shadow-2xl flex flex-col overflow-hidden">

        {/* --- HEADER --- */}
        <div className="p-5 border-b border-white/10 light:border-gray-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-white font-bold text-lg leading-tight light:text-gray-900">Scan Receipt</h2>
            <p className="text-white/40 text-xs mt-1 light:text-gray-500">
              Scan the QR on your paper receipt to count that cash ride.
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 light:bg-white light:hover:bg-gray-100 light:border-gray-200 flex items-center justify-center flex-shrink-0 transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4 text-white/60 light:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* --- BODY --- */}
        <div className="p-5">

          {step === "scanning" && !showManualEntry && (
            <>
              <div
                id={scannerContainerId}
                className="w-full aspect-square rounded-xl overflow-hidden bg-black border border-white/10 light:border-gray-200"
              />
              <button
                onClick={() => {
                  void stopScanner();
                  setShowManualEntry(true);
                }}
                className="w-full mt-4 text-xs font-semibold text-[#62A0EA] hover:text-white light:text-[#1A5FB4] light:hover:text-[#164A8F] transition-colors"
              >
                Enter the code manually instead
              </button>
            </>
          )}

          {step === "scanning" && showManualEntry && (
            <>
              {cameraFailed && (
                <div className="mb-4 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">
                  <p className="text-[11px] text-amber-300/90 light:text-amber-800 leading-relaxed">
                    We couldn&apos;t open the camera. Check the camera permission
                    for this site, or type the code printed on your receipt.
                  </p>
                </div>
              )}
              <label htmlFor="receipt-token" className="block text-xs font-semibold text-white/60 mb-2 light:text-gray-600">
                Receipt code
              </label>
              <input
                id="receipt-token"
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                placeholder="Printed under the QR code"
                className="w-full bg-[#050F1A] border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/25 light:bg-white light:border-gray-200 light:text-gray-900 light:placeholder:text-gray-400 focus:outline-none focus:border-[#1A5FB4]"
              />
              <button
                onClick={() => void submitToken(manualToken)}
                disabled={manualToken.trim().length === 0}
                className="w-full mt-4 bg-[#1A5FB4] hover:bg-[#1E6BC6] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold py-3 rounded-xl transition-colors"
              >
                Claim ride
              </button>
              <button
                onClick={() => { setCameraFailed(false); setShowManualEntry(false); }}
                className="w-full mt-3 text-xs font-semibold text-white/40 hover:text-white/70 light:text-gray-500 light:hover:text-gray-700 transition-colors"
              >
                {cameraFailed ? "Try the camera again" : "Use the camera instead"}
              </button>
            </>
          )}

          {step === "verifying" && (
            <div className="py-12 flex flex-col items-center">
              <div className="w-10 h-10 rounded-full border-2 border-white/20 border-t-[#62A0EA] light:border-gray-200 light:border-t-[#1A5FB4] animate-spin" />
              <p className="text-sm text-white/50 mt-4 light:text-gray-500">Checking your receipt…</p>
            </div>
          )}

          {step === "success" && result && (
            <div className="py-6 flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                <svg className="w-8 h-8 text-emerald-400 light:text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
              </div>
              <h3 className="text-white font-bold text-lg mt-4 light:text-gray-900">
                {result.alreadyClaimed ? "Already Claimed" : "Ride Counted!"}
              </h3>
              <p className="text-white/50 text-xs mt-1.5 leading-relaxed light:text-gray-500">
                {result.alreadyClaimed
                  ? "You have already claimed this receipt."
                  : "This cash ride now counts toward your next free ride."}
              </p>

              <div className="w-full mt-5 bg-[#050F1A] border border-white/10 rounded-xl p-4 light:bg-gray-50 light:border-gray-200 space-y-2 text-left">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-white/40 light:text-gray-500">Fare</span>
                  <span className="text-sm font-bold text-white light:text-gray-900">{formatPeso(result.amount)}</span>
                </div>
                {(result.pickupName || result.dropoffName) && (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-white/40 light:text-gray-500 flex-shrink-0">Route</span>
                    <span className="text-[11px] text-white/70 light:text-gray-700 truncate">
                      {result.pickupName ?? "—"} → {result.dropoffName ?? "—"}
                    </span>
                  </div>
                )}
                {result.unitNumber && (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-white/40 light:text-gray-500">Unit</span>
                    <span className="text-[11px] text-white/70 light:text-gray-700">{result.unitNumber}</span>
                  </div>
                )}
              </div>

              <button
                onClick={onClose}
                className="w-full mt-5 bg-[#1A5FB4] hover:bg-[#1E6BC6] text-white text-sm font-bold py-3 rounded-xl transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {step === "expired" && (
            <div className="py-6 flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
                <svg className="w-8 h-8 text-amber-400 light:text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
              </div>
              <h3 className="text-white font-bold text-lg mt-4 light:text-gray-900">Receipt Expired</h3>
              <p className="text-white/50 text-xs mt-1.5 leading-relaxed light:text-gray-500">
                Receipt QR codes stay claimable for a limited time after the
                ride, and this one is past it. It can no longer be counted.
              </p>
              <button
                onClick={onClose}
                className="w-full mt-5 bg-white/5 hover:bg-white/10 text-white/70 text-sm font-semibold py-3 rounded-xl border border-white/10 light:bg-white light:hover:bg-gray-100 light:text-gray-700 light:border-gray-200 transition-colors"
              >
                Close
              </button>
            </div>
          )}

          {step === "failed" && (
            <div className="py-6 flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center">
                <svg className="w-8 h-8 text-red-400 light:text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </div>
              <h3 className="text-white font-bold text-lg mt-4 light:text-gray-900">Couldn&apos;t Claim</h3>
              <p className="text-white/50 text-xs mt-1.5 leading-relaxed light:text-gray-500">{error}</p>
              <div className="w-full flex gap-3 mt-5">
                <button
                  onClick={onClose}
                  className="flex-1 bg-white/5 hover:bg-white/10 text-white/70 text-sm font-semibold py-3 rounded-xl border border-white/10 light:bg-white light:hover:bg-gray-100 light:text-gray-700 light:border-gray-200 transition-colors"
                >
                  Close
                </button>
                <button
                  onClick={retry}
                  className="flex-1 bg-[#1A5FB4] hover:bg-[#1E6BC6] text-white text-sm font-bold py-3 rounded-xl transition-colors"
                >
                  Try Again
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
