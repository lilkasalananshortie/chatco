'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { Camera, CameraOff, X, RotateCcw } from 'lucide-react';

interface QrScannerProps {
  /**
   * Called when a QR is successfully decoded by the camera (raw token
   * string). The parent
   * decides what to do next (validate → scan → display crew).
   */
  onToken: (token: string) => void;
  /** Clicked when the user wants to cancel out of the scanner. */
  onCancel: () => void;
  /**
   * 'page' (default) fills the commuter layout's content area, with bottom
   * padding clearing the mobile tab bar — used by the in-page fallback
   * ("Rescan" / "Try again" / "Scan another unit"). 'modal' renders compact
   * chrome (icon-badge header, no page-height assumptions) for use inside
   * the nav-bar overlay dialog.
   */
  variant?: 'page' | 'modal';
}

/**
 * Sprint 6 — Commuter Feedback-QR scanner (S6-T6, commuter half).
 *
 * Wraps `html5-qrcode` to read the signed unit-QR via the device camera.
 * Camera only — there is no manual token entry, so the QR printed inside the
 * jeepney is the one way in. If the camera can't start, the error offers a
 * retry (e.g. after the commuter allows camera access).
 *
 * The scanner emits the raw token string (the `base64url(payload) + '.' + hex(HMAC)`
 * value) via `onToken`. The parent (the feedback page) then calls
 * `qrFeedbackService.validate(token)` → `qrFeedbackService.scan(token)` to
 * verify + resolve the crew.
 *
 * The camera is started on mount and STOPPED on unmount to free the
 * device's camera (mobile browsers will otherwise keep the camera light on).
 */
export function QrScanner({ onToken, onCancel, variant = 'page' }: QrScannerProps) {
  const containerId = 'feedback-qr-reader';
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [cameraError, setCameraError] = useState<{ title: string; message: string } | null>(null);
  const [isStarting, setIsStarting] = useState(true);
  // Bumped by "Try again" on a camera error to re-run the start effect.
  const [cameraAttempt, setCameraAttempt] = useState(0);

  // ─── Camera lifecycle ──────────────────────────────────────────
  const stopScanner = useCallback(async () => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    try {
      // stop() throws if the scanner was never started — guard with isScanning.
      if (scanner.isScanning) {
        await scanner.stop();
      }
      scanner.clear();
    } catch {
      // ignore — already stopped or never started
    } finally {
      scannerRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsStarting(true);
    setCameraError(null);

    // Small delay so the container div is mounted before html5-qrcode
    // looks for it. The library scans the DOM by ID.
    const startTimeout = setTimeout(async () => {
      if (cancelled) return;
      try {
        const scanner = new Html5Qrcode(containerId, { verbose: false });
        scannerRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            // Scan box spans the whole camera view, matching the full-size frame overlay.
            qrbox: (viewfinderWidth, viewfinderHeight) => ({ width: viewfinderWidth, height: viewfinderHeight }),
            aspectRatio: 1,
          },
          (decodedText) => {
            // Success — stop the camera + emit the token. The library
            // keeps decoding otherwise, firing onToken repeatedly.
            if (!decodedText) return;
            void stopScanner();
            onToken(decodedText);
          },
          // Per-frame error callback — non-fatal, mostly "no QR found".
          // Swallow to avoid console spam.
          () => undefined
        );

        if (!cancelled) setIsStarting(false);
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : 'Unable to start camera.';
        // Common cases: permission denied, no camera, insecure context (http://)
        setCameraError(
          /permission|denied/i.test(message)
            ? {
                title: 'Camera access blocked',
                message: 'Allow camera access in your browser settings, then try again.',
              }
            : /notfound|not found|no camera/i.test(message)
              ? {
                  title: 'No camera detected',
                  message: 'Use a phone with a camera to scan the QR inside the jeepney.',
                }
              : {
                  title: 'Camera unavailable',
                  message: 'Close other apps using your camera, then try again.',
                }
        );
        setIsStarting(false);
      }
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(startTimeout);
      void stopScanner();
    };
  }, [cameraAttempt, onToken, stopScanner]);

  // ─── Render ────────────────────────────────────────────────────
  // Viewfinder — identical in both variants, only the surrounding chrome
  // (header treatment, outer sizing) differs.
  const body = (
    <div className="space-y-3">
      <div className={`relative w-full aspect-square ${cameraError ? 'min-h-72' : ''} bg-[#071A2E] rounded-2xl overflow-hidden border border-white/10 light:bg-gray-100 light:border-gray-200`}>
        {/* html5-qrcode mounts the video element here */}
        <div id={containerId} className="w-full h-full" />

        {/* Scan frame overlay — visual hint only, the library uses its
            own qrbox for actual detection. */}
        {!cameraError && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="relative w-full h-full">
              <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-[#62A0EA] rounded-tl-2xl" />
              <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-[#62A0EA] rounded-tr-2xl" />
              <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-[#62A0EA] rounded-bl-2xl" />
              <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-[#62A0EA] rounded-br-2xl" />
            </div>
          </div>
        )}

        {/* Loading overlay while the camera is starting */}
        {isStarting && !cameraError && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#050F1A]/80 light:bg-white/80">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-[#62A0EA] border-t-transparent light:border-[#1A5FB4] light:border-t-transparent rounded-full animate-spin" />
              <p className="text-white/60 text-xs light:text-gray-500">Starting camera…</p>
            </div>
          </div>
        )}

        {cameraError && (
          <div className="absolute inset-0 overflow-y-auto bg-[#071A2E] px-5 py-6 light:bg-gray-50">
            <div className="mx-auto flex min-h-full max-w-64 flex-col items-center justify-center text-center">
              <div aria-hidden="true" className="mb-4 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[#62A0EA]/20 bg-[#62A0EA]/10 text-[#99C1F1] light:border-[#1A5FB4]/15 light:bg-[#1A5FB4]/5 light:text-[#1A5FB4]">
                <CameraOff size={24} strokeWidth={1.5} />
              </div>
              <div role="alert">
                <h3 className="text-lg font-semibold leading-snug tracking-tight text-white light:text-gray-900">{cameraError.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-white/55 light:text-gray-500">{cameraError.message}</p>
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

      <p className="text-center text-white/30 text-[11px] light:text-gray-500">
        The QR is printed inside the jeepney unit, near the conductor.
      </p>
    </div>
  );

  if (variant === 'modal') {
    return (
      <div className="flex max-h-[88vh] w-full flex-col overflow-hidden bg-[#050F1A] light:bg-white">
        {/* Header — bare icon + title + border-b. The result modals that
            replace this one (FeedbackModalContent) use the same header. */}
        <div className="flex items-center justify-between gap-4 border-b border-white/10 p-5 light:border-gray-200">
          <div className="flex items-center gap-3 min-w-0">
            <Camera size={24} className="text-[#62A0EA] light:text-[#1A5FB4] flex-shrink-0" />
            <div className="min-w-0">
              <h2 className="text-white font-bold text-lg light:text-gray-900 leading-tight">Scan Feedback QR</h2>
              <p className="text-white/40 text-xs mt-0.5 light:text-gray-500 truncate">
                Point your camera at the QR inside the jeepney
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="text-white/40 hover:text-white transition-colors light:text-gray-400 light:hover:text-gray-900 flex-shrink-0"
            aria-label="Cancel scan"
          >
            <X size={20} />
          </button>
        </div>

        <div className="overflow-y-auto p-5">{body}</div>
      </div>
    );
  }

  return (
    // Scrolls rather than centre-clips: on short viewports the square
    // viewfinder plus header and toggle exceed the height. pb-24 clears the
    // commuter layout's absolutely-positioned mobile tab bar.
    <div className="h-full w-full bg-[#050F1A] light:bg-[#F8FAFC] flex flex-col items-center overflow-y-auto p-6 pb-24 lg:pb-6">
      <div className="w-full max-w-sm my-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-white font-bold text-lg light:text-gray-900">Scan Feedback QR</h2>
            <p className="text-white/40 text-xs mt-0.5 light:text-gray-500">
              Point your camera at the QR inside the jeepney
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-white/40 hover:text-white transition-colors light:text-gray-400 light:hover:text-gray-900 p-2 -mr-2"
            aria-label="Cancel scan"
          >
            <X size={20} />
          </button>
        </div>

        {body}
      </div>
    </div>
  );
}
