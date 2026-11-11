"use client";

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { fetchPaymentStatus, type PaymentStatus } from "@/lib/commuter/services/payment.service";
import { notifyRewardsChanged } from "@/lib/commuter/rewards-events";
import { getEcho } from "@/lib/echo";

/**
 * /gcash/return — PayMongo redirect target
 *
 * After the commuter authorizes (or cancels) on PayMongo's hosted GCash
 * page, PayMongo redirects here with `?transaction_id=...` (the query param
 * configured in config/payments.php return_url).
 *
 * PRIMARY PATH — REALTIME: subscribes to the public Pusher channel
 * `payments.{transactionId}` (same channel/event the conductor's
 * fare-calculator-modal listens on) and applies whatever status the
 * `PaymentStatusUpdated` broadcast carries the instant it's dispatched — by
 * the webhook handler, by provider reconciliation, or by /simulate in dev.
 * That's normally within a second or two of the commuter authorizing.
 *
 * FALLBACK PATH — POLLING: also polls GET /api/payments/{id}/status every 3s
 * regardless, so a missing/failed Pusher connection (unconfigured broadcaster,
 * network issue) still resolves — just on the poll cadence instead of
 * instantly. Whichever path observes a terminal status first wins; the other
 * is torn down via the shared `applyStatus` cleanup below.
 *
 * LATE-SETTLEMENT HANDLING:
 * EXPIRED is NOT treated as immediately terminal. After the row flips to
 * EXPIRED, the page keeps polling for a grace window (default 60s) because
 * the commuter may have completed PayMongo checkout seconds before the
 * local TTL lapsed — PayMongo's webhook then arrives late and the state
 * machine's EXPIRED→PAID transition fires.
 *
 * In DEV mode (FakeGateway), the conductor's [DEV] Simulate Payment button
 * drives the status to PAID through the same webhook path.
 */
function GcashReturnContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const transactionId = searchParams.get("transaction_id");

  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Timestamp (ms) when EXPIRED was first observed, or null if not yet seen. */
  const expiredAtRef = useRef<number | null>(null);
  const rewardRefreshSentRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    expiredAtRef.current = null;
  }, []);

  useEffect(() => {
    if (!transactionId) return;

    // Hard-terminal statuses end polling immediately. EXPIRED is handled
    // through the grace-window logic to allow for late PayMongo webhooks.
    const HARD_TERMINAL: PaymentStatus[] = ["paid", "failed", "cancelled", "refunded"];
    // Grace window after EXPIRED is first observed (matches server-side default).
    const LATE_SETTLEMENT_GRACE_MS = 60 * 1000;

    let mounted = true;

    // Shared by both the realtime event handler and the poll fallback so a
    // status observed either way is applied identically (and stops the
    // poll interval once terminal, regardless of which path got there first).
    const applyStatus = (status: PaymentStatus) => {
      if (!mounted) return;
      setStatus(status);

      // PAID is always terminal — success regardless of prior EXPIRED state.
      if (status === "paid") {
        if (!rewardRefreshSentRef.current) {
          rewardRefreshSentRef.current = true;
          notifyRewardsChanged();
        }
        stopPolling();
        return;
      }

      // Hard-terminal failure statuses end immediately.
      if (HARD_TERMINAL.includes(status)) {
        stopPolling();
        return;
      }

      // EXPIRED — record when we first saw it, and keep polling/listening
      // through the grace window. If we've already been in EXPIRED for
      // longer than the grace, give up.
      if (status === "expired") {
        if (expiredAtRef.current === null) {
          expiredAtRef.current = Date.now();
        }
        const elapsed = Date.now() - expiredAtRef.current;
        if (elapsed >= LATE_SETTLEMENT_GRACE_MS) {
          stopPolling();
        }
        // else: keep polling — the late webhook may still fire.
      }
    };

    const poll = async () => {
      try {
        const result = await fetchPaymentStatus(transactionId);
        if (!mounted) return;
        setPollCount((c) => c + 1);
        applyStatus(result.status);
      } catch {
        // Network error — keep polling, the next tick may recover.
      }
    };

    // Realtime primary path: the backend broadcasts PaymentStatusUpdated the
    // instant the webhook (or provider reconciliation) resolves the payment,
    // so this normally beats the next poll tick by seconds. Best-effort —
    // an unconfigured broadcaster or a dropped socket just leaves polling as
    // the sole path, same as before this existed.
    let echo: ReturnType<typeof getEcho> | null = null;
    const channelName = `payments.${transactionId}`;
    try {
      echo = getEcho();
      echo.channel(channelName).listen(
        ".PaymentStatusUpdated",
        (event: { transaction_id: string; status: string }) => {
          applyStatus((event.status?.toLowerCase() as PaymentStatus) ?? "pending");
        }
      );
    } catch (err) {
      console.warn("Echo subscription failed, relying on polling:", err);
    }

    // Poll immediately, then every 3s — the fallback for when the realtime
    // path above is unavailable or misses an event.
    void poll();
    pollIntervalRef.current = setInterval(poll, 3000);

    // Hard fallback timeout: 10 minutes (matches the QR claim TTL). If
    // neither path has resolved by then, stop and the UI shows the
    // "still processing" state with a "check your history later" hint.
    // This is the offline upper bound — under normal conditions, the
    // realtime event (or, failing that, polling) resolves within seconds of
    // the commuter authorizing on PayMongo.
    const hardTimeout = setTimeout(() => {
      if (mounted) stopPolling();
    }, 10 * 60 * 1000);

    return () => {
      mounted = false;
      stopPolling();
      clearTimeout(hardTimeout);
      if (echo) {
        echo.channel(channelName).stopListening(".PaymentStatusUpdated");
        echo.leave(channelName);
      }
    };
  }, [transactionId, stopPolling]);

  const goToDashboard = () => router.push("/dashboard");

  // ─── No transaction ID in URL ───
  if (!transactionId) {
    return (
      <ResultPanel
        tone="error"
        title="Missing transaction"
        body="This link has no transaction reference. Go back to the dashboard and scan the conductor's QR code again."
        onDone={goToDashboard}
      />
    );
  }

  // ─── Waiting on GCash (pending / processing) ───
  // pollCount only decides when to add the "taking longer" note; it's a
  // status check every 3s, not a payment retry, so it's never shown as a count.
  if (!status || status === "pending" || status === "processing") {
    return (
      <ResultPanel
        tone="waiting"
        title="Confirming your GCash payment"
        body="We're checking with GCash. This usually takes a few seconds."
        note={pollCount > 5
          ? "This is taking longer than usual. You can leave this page; the result will show in your payment history."
          : undefined}
        reference={transactionId}
        doneLabel="Back to Dashboard"
        doneVariant="secondary"
        onDone={goToDashboard}
      />
    );
  }

  // ─── Older payments only: expired but still waiting for late settlement ───
  // New payments are cancelled at the claim TTL instead; rows that were
  // expired before that change can still settle during the grace window.
  if (status === "expired") {
    return (
      <ResultPanel
        tone="waiting"
        title="Waiting for GCash to confirm"
        body="The payment session timed out. If you already approved it in GCash, it may still be confirmed in a moment."
        note={pollCount > 5 ? "If nothing changes, check your payment history later." : undefined}
        reference={transactionId}
        doneLabel="Back to Dashboard"
        doneVariant="secondary"
        onDone={goToDashboard}
      />
    );
  }

  // ─── Success ───
  if (status === "paid") {
    return (
      <ResultPanel
        tone="success"
        title="Payment successful"
        body="GCash confirmed your payment. Have a safe trip."
        reference={transactionId}
        onDone={goToDashboard}
      />
    );
  }

  // ─── Not completed ───
  // A cancelled or failed payment was checked with GCash first, so the
  // commuter was not charged, and the backend returns any applied voucher.
  const notCompleted: Record<string, { title: string; body: string; note?: string }> = {
    failed: {
      title: "Payment didn't go through",
      body: "GCash didn't complete this payment, so you weren't charged.",
      note: "If you applied a voucher, it's back in your rewards. Ask the conductor for a new QR code or pay in cash.",
    },
    cancelled: {
      title: "Payment cancelled",
      body: "This payment was cancelled before GCash confirmed it, so you weren't charged.",
      note: "If you applied a voucher, it's back in your rewards. Ask the conductor for a new QR code or pay in cash.",
    },
    refunded: {
      title: "Payment refunded",
      body: "This payment was refunded to your GCash account.",
    },
  };
  const outcome = notCompleted[status] ?? {
    title: "Something went wrong",
    body: "We couldn't confirm this payment. Check your payment history for its final status.",
  };

  return (
    <ResultPanel
      tone="error"
      title={outcome.title}
      body={outcome.body}
      note={outcome.note}
      reference={transactionId}
      onDone={goToDashboard}
    />
  );
}

type ResultTone = "waiting" | "success" | "error";

/**
 * One composition for every state of the return page: the outcome reads
 * first (mark + title), the explanation under it, the reference as a quiet
 * ledger row, and a single action. Surfaces are solid navy steps, never
 * tinted or see-through; red is reserved for the error mark.
 */
function ResultPanel({
  tone,
  title,
  body,
  note,
  reference,
  doneLabel = "Back to Dashboard",
  doneVariant = "primary",
  onDone,
}: {
  tone: ResultTone;
  title: string;
  body: string;
  note?: string;
  reference?: string;
  doneLabel?: string;
  doneVariant?: "primary" | "secondary";
  onDone: () => void;
}) {
  return (
    <main className="min-h-[100dvh] bg-[#050F1A] light:bg-[#F8FAFC] flex items-center justify-center px-4 py-8">
      <section
        aria-live="polite"
        className="w-full max-w-sm rounded-2xl border border-[#1C3350] bg-[#071A2E] p-6 light:border-gray-200 light:bg-white"
      >
        <ResultMark tone={tone} />

        <p className="mt-5 text-[10px] font-semibold uppercase tracking-[0.1em] text-white/40 light:text-gray-400">
          GCash payment
        </p>
        <h1 className="mt-1.5 text-xl font-bold leading-snug text-white light:text-gray-900">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-white/60 light:text-gray-600">{body}</p>
        {note && <p className="mt-3 text-sm leading-relaxed text-white/45 light:text-gray-500">{note}</p>}

        {reference && (
          <div className="mt-6 flex items-center justify-between gap-3 border-t border-[#1C3350] pt-4 light:border-gray-200">
            <span className="text-xs text-white/40 light:text-gray-400">Reference</span>
            <span className="truncate font-mono text-xs text-white/70 light:text-gray-700">{reference}</span>
          </div>
        )}

        <button
          onClick={onDone}
          className={`mt-6 w-full rounded-xl py-3 text-sm font-semibold transition-colors active:scale-[0.98] ${
            doneVariant === "primary"
              ? "bg-[#1A5FB4] text-white hover:bg-[#164A8F]"
              : "border border-[#1C3350] bg-[#0B1E33] text-white/80 hover:bg-[#10273F] light:border-gray-200 light:bg-gray-100 light:text-gray-700 light:hover:bg-gray-200"
          }`}
        >
          {doneLabel}
        </button>
      </section>
    </main>
  );
}

function ResultMark({ tone }: { tone: ResultTone }) {
  if (tone === "waiting") {
    return (
      <div
        role="status"
        aria-label="Checking payment"
        className="h-11 w-11 rounded-full border-[3px] border-[#1C3350] border-t-[#62A0EA] light:border-gray-200 light:border-t-[#1A5FB4] animate-spin"
      />
    );
  }

  const isError = tone === "error";
  return (
    <div
      className={`flex h-11 w-11 items-center justify-center rounded-xl border ${
        isError ? "border-[#5C1F27] bg-[#2B1116] light:border-red-200 light:bg-red-50" : "border-[#1C3350] bg-[#0B1E33] light:border-gray-200 light:bg-gray-50"
      }`}
    >
      <svg
        className={`h-5 w-5 ${isError ? "text-red-400 light:text-red-600" : "text-[#62A0EA] light:text-[#1A5FB4]"}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
        aria-hidden="true"
      >
        {isError
          ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          : <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />}
      </svg>
    </div>
  );
}

/**
 * useSearchParams() opts a route into client-side rendering, which Next
 * requires to sit behind a Suspense boundary — without one the production
 * build fails to prerender this page. The fallback mirrors the page's own
 * loading state so the redirect back from GCash never flashes a blank screen.
 */
export default function GcashReturnPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-[100dvh] bg-[#050F1A] light:bg-[#F8FAFC] flex items-center justify-center px-4 py-8">
          <section className="w-full max-w-sm rounded-2xl border border-[#1C3350] bg-[#071A2E] p-6 light:border-gray-200 light:bg-white">
            <ResultMark tone="waiting" />
            <p className="mt-5 text-sm text-white/60 light:text-gray-600">Confirming your payment…</p>
          </section>
        </main>
      }
    >
      <GcashReturnContent />
    </Suspense>
  );
}
