"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { Camera, CameraOff, RotateCcw, X } from "lucide-react";
import {
  claimGcash,
  redeemVoucherForGcash,
  redeemVouchersForGroupGcash,
  simulatePayment,
  type ClaimResult,
} from "@/lib/commuter/services/payment.service";
import { GroupVoucherPicker } from "@/components/commuter/modals/group-voucher-picker";
import { FeedbackModalFrame } from "@/components/commuter/feedback/feedback-modal";
import { ApiError } from "@/lib/api/client";
import { formatCurrency } from "@/lib/shared/fare/fare-calculator";

interface ScanModalProps {
  onClose: () => void;
  commuterId: string;
  commuterName: string;
}

type Step = "scanning" | "verifying" | "confirm" | "voucher_offer" | "redeeming_voucher" | "redirecting" | "success" | "failed";

/**
 * Commuter Scan Modal — Real GCash Payment Flow
 *
 * Flow:
 *  1. scanning   — Camera scans the conductor's QR (which contains the qr_token)
 *  2. verifying  — Calls POST /api/commuter/payments/claim { qr_token }
 *                  Backend binds the commuter's passenger_id to the transaction
 *                  + returns the PayMongo checkout_url + amount + route
 *  3. confirm    — Shows the fare details + "Pay with GCash" button
 *  4. redirecting — Redirects to the PayMongo hosted authorize page
 *  5. success    — (only reached if checkout_url is null = FakeGateway dev mode)
 *  6. failed     — Bad token / expired / already claimed / network error
 *
 * After the commuter authorizes on PayMongo's hosted page, PayMongo redirects
 * to {APP_URL}/gcash/return?transaction_id=... — handled by the
 * app/(commuter)/gcash/return/page.tsx route, which polls the status and
 * shows the final result.
 *
 * In DEV mode (FakeGateway, no PayMongo keys), checkout_url is null. The
 * commuter scan action simulates PAID through the same backend transition
 * used by webhook/simulation flows.
 */
export default function ScanModal({ onClose }: ScanModalProps) {
  const [step, setStep] = useState<Step>("scanning");
  const [claimResult, setClaimResult] = useState<ClaimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<{ title: string; message: string } | null>(null);
  // Bumped by "Try again" on a camera error to re-run the start effect.
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const scannerRunningRef = useRef(false);
  const scannerContainerId = "qr-reader-container";

  // ─── Safely stop the scanner ───
  // html5-qrcode throws "Cannot stop, scanner is not running or paused" if
  // stop() is called on a scanner that already stopped or never started.
  // We track the running state in a ref + guard every stop() call.
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

  // ─── Camera scanner setup ───
  // Uses html5-qrcode (already installed) to scan the conductor's QR.
  // The QR contains JUST the qr_token (a 32-char opaque string). We pass
  // it to claimGcash() which POSTs to /commuter/payments/claim.
  useEffect(() => {
    if (step !== "scanning") return;

    let mounted = true;
    setCameraReady(false);
    setCameraError(null);

    const startScanner = async () => {
      try {
        const html5QrCode = new Html5Qrcode(scannerContainerId);
        scannerRef.current = html5QrCode;

        await html5QrCode.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 220, height: 220 }, aspectRatio: 1 },
          (decodedText) => {
            if (!mounted) return;
            // Stop the scanner immediately — we have a result. The
            // useEffect cleanup will also run when the step changes, but
            // stopScanner() guards against double-stop.
            void stopScanner();
            handleScanSuccess(decodedText);
          },
          () => {
            // Per-frame failure — ignore, the scanner keeps trying.
          }
        );
        // Only mark as running AFTER start() succeeds — otherwise the
        // cleanup function would try to stop a scanner that never started.
        if (mounted) {
          scannerRunningRef.current = true;
          setCameraReady(true);
        } else {
          // Component unmounted during start() — stop immediately.
          void stopScanner();
        }
      } catch (err) {
        scannerRef.current = null;
        if (!mounted) return;
        // html5-qrcode rejects with either an Error or a plain string.
        const message = String(err);
        setCameraError(
          /permission|denied|notallowed/i.test(message)
            ? { title: "Camera access blocked", message: "Allow camera access in your browser settings, then try again." }
            : /notfound|not found|no camera/i.test(message)
              ? { title: "No camera detected", message: "Open CHATCO on a phone with a camera to scan the conductor's QR." }
              : { title: "Camera couldn't start", message: "Close other apps using your camera, then try again." }
        );
      }
    };

    void startScanner();

    return () => {
      mounted = false;
      void stopScanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, cameraAttempt, stopScanner]);

  // ─── Release the camera when the modal closes entirely ───
  // This is separate from the step-change cleanup so it fires when the
  // whole modal unmounts (user clicks Close), not just when the step
  // changes within the modal.
  useEffect(() => {
    return () => {
      void stopScanner();
    };
  }, [stopScanner]);

  // ─── Proceed to actually pay for a claim result (real fare or the
  // remaining companions-only total after a group voucher redemption) ───
  // A checkout_url redirects to PayMongo; a ₱0 amount (solo voucher
  // redemption) is already settled — nothing left to pay; otherwise (dev
  // mode, no real gateway) the scan simulates PAID like it always has.
  const proceedToPayment = useCallback(async (result: ClaimResult) => {
    if (result.checkoutUrl) {
      setStep("redirecting");
      window.location.href = result.checkoutUrl;
      return;
    }

    if (result.amount <= 0) {
      setStep("success");
      return;
    }

    setStep("redirecting");
    try {
      await simulatePayment(result.transactionId, "PAID");
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to complete the simulated payment.");
      setStep("failed");
    }
  }, []);

  // ─── Handle successful QR scan ───
  // The decoded text IS the qr_token. Call claimGcash() to bind this
  // commuter to the transaction + get the PayMongo checkout_url.
  const handleScanSuccess = useCallback(async (qrToken: string) => {
    setStep("verifying");
    setError(null);

    try {
      const result = await claimGcash(qrToken.trim());
      setClaimResult(result);

      // A voucher can cover this commuter's own seat — offer the choice
      // before committing to a GCash charge, instead of assuming they want
      // to pay. Declining falls through to the normal payment path below.
      if (result.voucherAvailable) {
        setStep("voucher_offer");
        return;
      }

      await proceedToPayment(result);
    } catch (err) {
      // Extract the backend's specific error message. The ApiError.body
      // contains the Laravel envelope { success, data, message, errors }.
      let msg = "Failed to claim this payment. The QR may be invalid or expired.";

      if (err instanceof ApiError) {
        const body = err.body as { message?: string; errors?: Record<string, string[]> } | null;
        if (body?.errors) {
          // 422 validation error — surface the first field error.
          const firstField = Object.keys(body.errors)[0];
          const firstError = firstField ? body.errors[firstField]?.[0] : null;
          msg = firstError ?? body.message ?? msg;
        } else if (body?.message) {
          // 404 / 410 / 409 / other — use the backend's message verbatim.
          msg = body.message;
        }

        // Status-specific friendly messages.
        if (err.status === 404) msg = "This payment QR is invalid or was not found. Please ask the conductor to generate a new one.";
        else if (err.status === 410) msg = "This payment QR has expired or already been paid. Please ask the conductor to generate a new one.";
        else if (err.status === 409) msg = "This payment has already been claimed by another commuter. Please ask the conductor to generate a new one.";
        else if (err.status === 401) msg = "You must be logged in as a commuter to claim a payment.";
        else if (err.status === 422 && !body?.errors) msg = body?.message ?? "Your commuter account is missing required information to claim this payment.";
      } else if (err instanceof Error) {
        msg = err.message;
      }

      setError(msg);
      setStep("failed");
    }
  }, [proceedToPayment]);

  // ─── Voucher offer: use it, or decline and pay normally ───
  // A group payment passes the vouchers the payer picked (one per seat); a
  // solo ride uses its single offered voucher.
  const handleUseVoucher = useCallback(async (voucherIds?: string[]) => {
    if (!claimResult) return;
    setStep("redeeming_voucher");
    setError(null);

    try {
      const redeemed = voucherIds
        ? await redeemVouchersForGroupGcash(claimResult.transactionId, voucherIds)
        : await redeemVoucherForGcash(claimResult.transactionId, claimResult.availableVoucher?.id);
      setClaimResult(redeemed);
      await proceedToPayment(redeemed);
    } catch (err) {
      let msg = "Unable to redeem your voucher for this ride.";
      if (err instanceof ApiError) {
        const body = err.body as { message?: string } | null;
        msg = body?.message ?? msg;
      } else if (err instanceof Error) {
        msg = err.message;
      }
      setError(msg);
      setStep("failed");
    }
  }, [claimResult, proceedToPayment]);

  const handleDeclineVoucher = useCallback(() => {
    if (!claimResult) return;
    void proceedToPayment(claimResult);
  }, [claimResult, proceedToPayment]);

  // ─── Redirect to PayMongo hosted authorize page ───
  // In real mode, checkout_url is the PayMongo hosted page. The commuter
  // authorizes there, PayMongo redirects to /gcash/return, and the webhook
  // flips the transaction to PAID.
  // In dev mode (FakeGateway), checkout_url is null. Scanning simulates a
  // PAID provider event so the database and conductor poller update too.
  const handleConfirmPayment = useCallback(() => {
    if (!claimResult) return;

    if (claimResult.checkoutUrl) {
      // Real PayMongo flow — redirect to the hosted authorize page.
      setStep("redirecting");
      window.location.href = claimResult.checkoutUrl;
    } else {
      setStep("redirecting");
      simulatePayment(claimResult.transactionId, "PAID")
        .then(() => setStep("success"))
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Unable to complete the simulated payment.");
          setStep("failed");
        });
    }
  }, [claimResult]);

  // ─── STEP: Scanning ──────────────────────────────────────────

  // Same frame, header and viewfinder as the Scan Feedback QR modal
  // (FeedbackModalFrame + QrScanner's 'modal' variant).
  if (step === "scanning") {
    return (
      <FeedbackModalFrame label="Scan Payment QR">
        <div className="flex max-h-[88vh] w-full flex-col overflow-hidden bg-[#050F1A] light:bg-white">
          <div className="flex items-center justify-between gap-4 border-b border-white/10 light:border-gray-200 p-5">
            <div className="flex items-center gap-3 min-w-0">
              <Camera size={24} className="text-[#62A0EA] light:text-[#1A5FB4] flex-shrink-0" />
              <div className="min-w-0">
                <h2 className="text-white light:text-gray-900 font-bold text-lg leading-tight">Scan Payment QR</h2>
                <p className="text-white/40 light:text-gray-500 text-xs mt-0.5 truncate">
                  Point your camera at the conductor&apos;s QR
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-white/40 light:text-gray-500 hover:text-white light:hover:text-gray-900 transition-colors flex-shrink-0"
              aria-label="Close scanner"
            >
              <X size={20} />
            </button>
          </div>

          <div className="overflow-y-auto p-5">
            <div className="space-y-3">
              <div className={`relative w-full aspect-square ${cameraError ? "min-h-72" : ""} bg-[#071A2E] light:bg-gray-100 rounded-2xl overflow-hidden border border-white/10 light:border-gray-200`}>
                {/* Camera viewfinder — html5-qrcode mounts here */}
                <div id={scannerContainerId} className="w-full h-full" />
                {/* html5-qrcode sets the <video> element's width inline (in px)
                    but leaves height at the browser's default "auto", which
                    scales off the camera's native (non-square) stream aspect
                    ratio — leaving it short of the square container's height.
                    Force it to cover the container instead of trusting the
                    library's own sizing. */}
                <style jsx global>{`
                  #qr-reader-container video {
                    width: 100% !important;
                    height: 100% !important;
                    object-fit: cover !important;
                  }
                `}</style>

                {/* Scan frame overlay */}
                {!cameraError && (
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                    <div className="relative w-48 h-48">
                      <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-[#62A0EA] light:border-[#1A5FB4] rounded-tl-lg" />
                      <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-[#62A0EA] light:border-[#1A5FB4] rounded-tr-lg" />
                      <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-[#62A0EA] light:border-[#1A5FB4] rounded-bl-lg" />
                      <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-[#62A0EA] light:border-[#1A5FB4] rounded-br-lg" />
                    </div>
                  </div>
                )}

                {/* Loading overlay while the camera is starting */}
                {!cameraReady && !cameraError && (
                  <div className="absolute inset-0 flex items-center justify-center bg-[#050F1A]/80 light:bg-white/80">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-8 h-8 border-2 border-[#62A0EA] light:border-[#1A5FB4] border-t-transparent light:border-t-transparent rounded-full animate-spin" />
                      <p className="text-white/60 light:text-gray-600 text-xs">Starting camera…</p>
                    </div>
                  </div>
                )}

                {cameraError && (
                  <div className="absolute inset-0 overflow-y-auto bg-[#071A2E] light:bg-gray-50 px-5 py-6">
                    <div className="mx-auto flex min-h-full max-w-64 flex-col items-center justify-center text-center">
                      <CameraOff size={32} strokeWidth={1.5} aria-hidden="true" className="mb-4 shrink-0 text-[#99C1F1] light:text-[#1A5FB4]" />
                      <div role="alert">
                        <h3 className="text-lg font-semibold leading-snug tracking-tight text-white light:text-gray-900">{cameraError.title}</h3>
                        <p className="mt-2 text-sm leading-relaxed text-white/55 light:text-gray-600">{cameraError.message}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setCameraAttempt((n) => n + 1)}
                        className="mt-5 inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-[#1A5FB4] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#164A8F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#62A0EA] light:focus-visible:outline-[#1A5FB4]"
                      >
                        <RotateCcw size={16} aria-hidden="true" />
                        Try again
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <p className="text-center text-white/30 light:text-gray-500 text-[11px]">
                Align the QR code shown by the conductor within the frame
              </p>
            </div>
          </div>
        </div>
      </FeedbackModalFrame>
    );
  }

  // ─── STEP: Verifying ─────────────────────────────────────────

  if (step === "verifying") {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <div className="animate-fade-in w-full max-w-xs bg-[#071A2E] light:bg-white rounded-2xl border border-[#1C3350] light:border-gray-200 shadow-2xl p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full border-4 border-[#1C3350] light:border-gray-200 border-t-[#62A0EA] light:border-t-[#1A5FB4] animate-spin" />
          <h2 className="text-lg font-bold text-white light:text-gray-900 mb-2">
            Verifying Transaction
          </h2>
          <p className="text-sm text-white/40 light:text-gray-500">
            Claiming this payment + binding it to your account…
          </p>
        </div>
      </div>
    );
  }

  // ─── STEP: Voucher offer ─────────────────────────────────────
  // Shown once, right after claim, only when the commuter has an eligible
  // voucher. Declining falls straight through to the normal GCash flow.

  // A group payer can spend one voucher per passenger, so they pick from
  // all of theirs instead of the single-voucher offer below.
  if (step === "voucher_offer" && claimResult && claimResult.seats.length > 1 && claimResult.availableVouchers.length > 0) {
    return (
      <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4">
        <div className="animate-fade-in w-full sm:max-w-sm bg-[#071A2E] light:bg-white sm:rounded-2xl rounded-t-2xl border border-[#1C3350] light:border-gray-200 shadow-2xl max-h-[95vh] overflow-y-auto">
          <GroupVoucherPicker
            claim={claimResult}
            onUse={(voucherIds) => void handleUseVoucher(voucherIds)}
            onPayInstead={handleDeclineVoucher}
          />
        </div>
      </div>
    );
  }

  if (step === "voucher_offer" && claimResult) {
    return (
      <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4">
        <div className="animate-fade-in w-full sm:max-w-sm bg-[#071A2E] light:bg-white sm:rounded-2xl rounded-t-2xl border border-[#1C3350] light:border-gray-200 shadow-2xl max-h-[95vh] sm:max-h-none overflow-y-auto">
          <div className="p-5 sm:p-6">
            <svg aria-hidden="true" className="w-9 h-9 mb-4 text-[#62A0EA] light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.745 3.745 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z" />
              </svg>
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-white/40 light:text-gray-500 mb-1.5">Voucher available</p>
            <h2 className="text-lg font-bold text-white light:text-gray-900 mb-1">
              {claimResult.availableVoucher?.type === "DISCOUNT" ? "Use your discount voucher?" : "Use your free-ride voucher?"}
            </h2>
            <p className="text-sm leading-relaxed text-white/60 light:text-gray-600 mb-5">
              {claimResult.availableVoucher?.type === "DISCOUNT"
                ? `Your voucher takes up to ${formatCurrency(claimResult.availableVoucher.amount ?? 0)} off your own fare. Pay any remaining fare${claimResult.isGroup ? " and your companions’ fares" : ""} via GCash.`
                : claimResult.isGroup
                  ? "Your voucher covers your own fare. Your companions still pay their share via GCash."
                  : "Your voucher covers this entire ride for free."}
            </p>

            <div className="bg-[#0B1E33] light:bg-gray-50 border border-[#1C3350] light:border-gray-200 rounded-xl p-4 space-y-2 mb-5">
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">{claimResult.isGroup ? "Group total (GCash)" : "Amount due"}</span>
                <span className="text-white light:text-gray-900 font-bold">{formatCurrency(claimResult.amount)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Route</span>
                <span className="text-white light:text-gray-900 text-right max-w-[60%] truncate">
                  {claimResult.pickupName ?? "—"} → {claimResult.dropoffName ?? "—"}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <button
                onClick={() => void handleUseVoucher()}
                className="w-full py-3 rounded-xl bg-[#1A5FB4] hover:bg-[#164A8F] active:scale-[0.98] text-white text-sm font-bold transition-colors"
              >
                Use My Voucher
              </button>
              <button
                onClick={handleDeclineVoucher}
                className="w-full py-3 rounded-xl border border-[#1C3350] light:border-gray-200 bg-[#0B1E33] light:bg-gray-50 text-white/80 light:text-gray-700 text-sm font-semibold hover:bg-[#10273F] light:hover:bg-gray-100 active:scale-[0.98] transition-colors"
              >
                Pay with GCash Instead
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── STEP: Redeeming voucher ─────────────────────────────────

  if (step === "redeeming_voucher") {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <div className="animate-fade-in w-full max-w-xs bg-[#071A2E] light:bg-white rounded-2xl border border-[#1C3350] light:border-gray-200 shadow-2xl p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full border-4 border-[#1C3350] light:border-gray-200 border-t-[#62A0EA] light:border-t-[#1A5FB4] animate-spin" />
          <h2 className="text-lg font-bold text-white light:text-gray-900 mb-2">
            Redeeming Voucher
          </h2>
          <p className="text-sm text-white/40 light:text-gray-500">
            Applying your voucher to this ride…
          </p>
        </div>
      </div>
    );
  }

  // ─── STEP: Confirm Payment ───────────────────────────────────

  if (step === "confirm" && claimResult) {
    return (
      <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4">
        <div className="animate-fade-in w-full sm:max-w-sm bg-[#071A2E] light:bg-white sm:rounded-2xl rounded-t-2xl border border-[#1C3350] light:border-gray-200 shadow-2xl max-h-[95vh] sm:max-h-none overflow-y-auto">
          <div className="p-5 sm:p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <svg aria-hidden="true" className="w-7 h-7 shrink-0 text-[#62A0EA] light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
                  </svg>
                <h2 className="text-lg font-bold text-white light:text-gray-900">Confirm Payment</h2>
              </div>
              <button
                onClick={onClose}
                className="text-white/40 light:text-gray-500 hover:text-white light:hover:text-gray-900 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Transaction Details */}
            <div className="bg-[#0B1E33] light:bg-gray-50 border border-[#1C3350] light:border-gray-200 rounded-xl p-4 space-y-3 mb-5">
              {/* Amount - prominent */}
              <div className="text-center pb-3 border-b border-[#1C3350] light:border-gray-200">
                <p className="text-[10px] text-white/30 light:text-gray-500 uppercase tracking-wider font-semibold mb-1">Amount Due</p>
                <p className="text-3xl font-extrabold text-white light:text-gray-900">{formatCurrency(claimResult.amount)}</p>
              </div>

              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Regular fare</span>
                <span className={claimResult.discountAmount > 0 ? "text-white/60 light:text-gray-600 line-through" : "text-white light:text-gray-900"}>
                  {formatCurrency(claimResult.regularAmount)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className={claimResult.discountAmount > 0 ? "text-white/80 light:text-gray-700" : "text-white/40 light:text-gray-500"}>
                  {claimResult.discountAmount > 0
                    ? `${claimResult.passengerRole?.replaceAll('_', ' ') ?? "Verified"} discount`
                    : "Discount"}
                </span>
                <span className={claimResult.discountAmount > 0 ? "font-semibold text-white light:text-gray-900" : "text-white light:text-gray-900"}>
                  -{formatCurrency(claimResult.discountAmount)}
                </span>
              </div>

              {/* Route */}
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Route</span>
                <span className="text-white light:text-gray-900 text-right max-w-[60%] truncate">
                  {claimResult.pickupName ?? "—"} → {claimResult.dropoffName ?? "—"}
                </span>
              </div>

              {/* Payment Method */}
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Method</span>
                <span className="text-white light:text-gray-900 font-medium">GCash</span>
              </div>

              {/* Transaction ID */}
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Ref ID</span>
                <span className="text-white/50 light:text-gray-500 text-xs font-mono">{claimResult.transactionId}</span>
              </div>
            </div>

            {/* GCash Notice */}
            <div className="bg-[#0B1E33] light:bg-gray-50 border border-[#1C3350] light:border-gray-200 rounded-xl p-3 mb-5">
              <div className="flex items-center gap-2 mb-1">
                <svg className="w-4 h-4 text-[#62A0EA] light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
                </svg>
                <span className="text-xs font-semibold text-white light:text-gray-900">GCash secure payment</span>
              </div>
              <p className="text-[11px] leading-relaxed text-white/50 light:text-gray-500">
                {claimResult.checkoutUrl
                  ? "You'll be redirected to GCash's secure page to authorize this payment."
                  : "Dev mode - scanning completes the simulated payment."}
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-3 rounded-xl border border-[#1C3350] light:border-gray-200 bg-[#0B1E33] light:bg-gray-50 text-white/80 light:text-gray-700 text-sm font-semibold hover:bg-[#10273F] light:hover:bg-gray-100 active:scale-[0.98] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmPayment}
                className="flex-1 py-3 rounded-xl bg-[#1A5FB4] hover:bg-[#164A8F] active:scale-[0.98] text-white text-sm font-bold transition-colors"
              >
                {claimResult.checkoutUrl ? "Pay with GCash" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── STEP: Redirecting (real PayMongo flow) ─────────────────

  if (step === "redirecting") {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <div className="animate-fade-in w-full max-w-xs bg-[#071A2E] light:bg-white rounded-2xl border border-[#1C3350] light:border-gray-200 shadow-2xl p-8 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full border-4 border-[#1C3350] light:border-gray-200 border-t-[#62A0EA] light:border-t-[#1A5FB4] animate-spin" />
          <h2 className="text-lg font-bold text-white light:text-gray-900 mb-2">
            Redirecting to GCash
          </h2>
          <p className="text-sm text-white/40 light:text-gray-500">
            You&apos;re being redirected to GCash&apos;s secure page to authorize this payment…
          </p>
        </div>
      </div>
    );
  }

  // ─── STEP: Success (dev mode only — real flow redirects to PayMongo) ───

  if (step === "success" && claimResult) {
    return (
      <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4">
        <div className="animate-fade-in w-full sm:max-w-sm bg-[#071A2E] light:bg-white sm:rounded-2xl rounded-t-2xl border border-[#1C3350] light:border-gray-200 shadow-2xl max-h-[95vh] sm:max-h-none overflow-y-auto">
          <div className="p-5 sm:p-6">
            <svg aria-hidden="true" className="w-9 h-9 mb-4 text-[#62A0EA] light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            <h2 className="text-lg font-bold text-white light:text-gray-900 mb-1">
              {claimResult.amount <= 0 ? "Ride covered by voucher" : "Payment claimed"}
            </h2>
            <p className="text-sm leading-relaxed text-white/60 light:text-gray-600 mb-5">
              {claimResult.amount <= 0
                ? "Your voucher covered this ride in full — nothing left to pay."
                : "Your payment is being processed. Check your payment history for the final status."}
            </p>

            <div className="bg-[#0B1E33] light:bg-gray-50 border border-[#1C3350] light:border-gray-200 rounded-xl p-4 space-y-2 mb-5">
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Amount</span>
                <span className="text-white light:text-gray-900 font-bold">{formatCurrency(claimResult.amount)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Route</span>
                <span className="text-white/70 light:text-gray-600">
                  {claimResult.pickupName ?? "—"} → {claimResult.dropoffName ?? "—"}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Ref ID</span>
                <span className="text-white/50 light:text-gray-500 text-xs font-mono">{claimResult.transactionId}</span>
              </div>
            </div>

            <button
              onClick={onClose}
              className="w-full py-3 rounded-xl bg-[#1A5FB4] hover:bg-[#164A8F] active:scale-[0.98] text-white text-sm font-bold transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── STEP: Failed ────────────────────────────────────────────

  if (step === "failed") {
    return (
      <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4">
        <div className="animate-fade-in w-full sm:max-w-sm bg-[#071A2E] light:bg-white sm:rounded-2xl rounded-t-2xl border border-[#1C3350] light:border-gray-200 shadow-2xl max-h-[95vh] sm:max-h-none overflow-y-auto">
          <div className="p-5 sm:p-6">
            <svg aria-hidden="true" className="w-9 h-9 mb-4 text-[#F07171] light:text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            <h2 className="text-lg font-bold text-white light:text-gray-900 mb-1">
              Payment not completed
            </h2>
            <p className="text-sm leading-relaxed text-white/60 light:text-gray-600 mb-6">
              {error ?? "Could not process the payment. The QR code may be invalid, expired, or already claimed by another commuter."}
            </p>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-3 rounded-xl border border-[#1C3350] light:border-gray-200 bg-[#0B1E33] light:bg-gray-50 text-white/80 light:text-gray-700 text-sm font-semibold hover:bg-[#10273F] light:hover:bg-gray-100 active:scale-[0.98] transition-colors"
              >
                Close
              </button>
              <button
                onClick={() => { setStep("scanning"); setClaimResult(null); setError(null); }}
                className="flex-1 py-3 rounded-xl bg-[#1A5FB4] hover:bg-[#164A8F] active:scale-[0.98] text-white text-sm font-bold transition-colors"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
