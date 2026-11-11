"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  loadFareMatrix,
  getPointAreas,
  getFareBetween as apiGetFareBetween,
  getBarangaysTraversed as apiGetBarangaysTraversed,
  getFareConfig,
  type PointArea,
} from "@/lib/shared/fare/fare-matrix.service";
import {
  formatCurrency,
  getCommuterTypeLabel,
  type CommuterType,
} from "@/lib/shared/fare/fare-calculator";
import {
  createTransaction,
  createGroupCashTransaction,
  type GroupPassengerInput,
  type Transaction,
} from "@/lib/conductor/services/transactions.service";
import TransactionReceipt from "@/components/conductor/receipt/transaction-receipt";
import {
  DEFAULT_RECEIPT_SETTINGS,
  fetchReceiptSettings,
  type ReceiptSettings,
} from "@/lib/conductor/services/receipt-settings.service";
import {
  initiateGcash,
  fetchPendingGcash,
  fetchStatus,
  cancelPayment,
  type GcashInitiation,
  type PaymentStatus as GcashPaymentStatus,
} from "@/lib/conductor/services/payment.service";
import type { PaymentMethodType } from "@/types";
import { useConductorConnectivity } from "@/app/(conductor)/hooks/use-conductor-connectivity";
import { usePopoverModal, useBackdropDismiss } from "@/components/conductor/modals/use-popover-modal";
import { PopoverTail } from "@/components/conductor/modals/popover-tail";
import { useCommuterTheme } from "@/contexts/commuter-theme-context";

interface FareCalcModalProps {
  isOpen: boolean;
  onClose: () => void;
  shiftId?: string;
  routeId?: string;
  conductorName?: string;
  unitNumber?: string;
  driverName?: string;
  /** Why fares can't be collected right now (on break, another device); null when they can. */
  blockedReason?: string | null;
  onShowHistory?: () => void;
}

/**
 * Step flow:
 * - Cash:  method → select (with commuter type + fare overview) → confirm → processing → success/failed
 * - GCash: method → select (locations only, NO fare) → qr_code → scan_result (fare breakdown after scan) → confirm → processing → success/failed
 */
type Step = "method" | "select" | "passengers" | "confirm" | "processing" | "qr_code" | "scan_result" | "success" | "failed";
type SelectedPaymentMethod = "GCash" | "Cash" | "Voucher";
type GroupPassengerType = "REGULAR" | "SENIOR_CITIZEN" | "STUDENT" | "PWD";

const GROUP_PASSENGER_TYPES: { type: GroupPassengerType; label: string }[] = [
  { type: "REGULAR", label: "Regular" },
  { type: "SENIOR_CITIZEN", label: "Senior" },
  { type: "STUDENT", label: "Student" },
  { type: "PWD", label: "PWD" },
];

function subDropoffPoints(point: PointArea): string[] {
  return Array.from(new Set(
    [...(point.subStops ?? []), ...(point.landmarks ?? [])]
      .map((name) => name.trim())
      .filter(Boolean)
  ));
}

function selectedPointName(point: PointArea, subPoint: string | null): string {
  return subPoint ? `${point.name} · ${subPoint}` : point.name;
}

export default function FareCalcModal({ isOpen, onClose, shiftId, routeId, conductorName, unitNumber, driverName, blockedReason = null, onShowHistory }: FareCalcModalProps) {
  const isOnline = useConductorConnectivity();
  const [step, setStep] = useState<Step>("method");
  // Open/close timing + xl:+ popover anchoring (measures ConductorDock's
  // real Payment button) — shared with EndOfDayModal, see usePopoverModal.
  const { isRendered, backdropAnim, panelAnim, panelAnchorStyle, anchorOffset } = usePopoverModal(isOpen, "conductor-payment-anchor");
  // The popover tail takes an inline fill, which `light:` classes can't reach.
  const isLight = useCommuterTheme() === "light";
  const panelTailColor = isLight ? "#FFFFFF" : "#071A2E";
  const [selectedMethod, setSelectedMethod] = useState<SelectedPaymentMethod | null>(null);
  const [pointAreas, setPointAreas] = useState<PointArea[]>(() => getPointAreas());
  const [pickupPoint, setPickupPoint] = useState<PointArea | null>(null);
  const [dropoffPoint, setDropoffPoint] = useState<PointArea | null>(null);
  const [commuterType, setCommuterType] = useState<CommuterType>("REGULAR");
  const [isGroupMode, setIsGroupMode] = useState(false);
  const [groupCounts, setGroupCounts] = useState<Record<GroupPassengerType, number>>({
    REGULAR: 0,
    SENIOR_CITIZEN: 0,
    STUDENT: 0,
    PWD: 0,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [selectingField, setSelectingField] = useState<
    "pickup" | "dropoff" | null
  >("pickup");
  const [expandedBarangay, setExpandedBarangay] = useState<number | null>(null);
  // Below lg the Select Location panel (pickup/drop-off, passenger mode)
  // starts collapsed so the barangay list gets the screen, same as the
  // commuter Fare Matrix; the list's hint line still shows which field is next.
  const [routePanelOpen, setRoutePanelOpen] = useState(false);
  const [pickupLandmark, setPickupLandmark] = useState<string | null>(null);
  const [dropoffLandmark, setDropoffLandmark] = useState<string | null>(null);

  // ── GCash real-API state ──
  // When the conductor initiates a GCash payment, we call the backend's
  // /conductor/payments/gcash/initiate endpoint which creates a PENDING
  // transaction + a qr_token + a PayMongo checkout URL. The qr_token is
  // rendered as a QR for the commuter to scan. We then poll the payment
  // status until it reaches a terminal state (PAID/FAILED/CANCELLED/EXPIRED)
  // or the QR's expires_at (claim TTL) passes.
  //
  // LATE-SETTLEMENT HANDLING:
  // EXPIRED is NOT immediately treated as terminal. After the row flips to
  // EXPIRED (lazy TTL expiry server-side), we keep polling for a grace
  // window (default 60s) because the commuter may have completed PayMongo
  // checkout seconds before the local expiry — PayMongo's webhook then
  // arrives late and the state machine's EXPIRED→PAID transition fires.
  // Only HARD-TERMINAL statuses (failed/cancelled/refunded) end polling
  // immediately. PAID always ends polling immediately. EXPIRED ends polling
  // only after the grace window elapses without a resolution.
  const [gcashInitiation, setGcashInitiation] = useState<GcashInitiation | null>(null);
  const [gcashStatus, setGcashStatus] = useState<GcashPaymentStatus | null>(null);
  /** PROCESSING past the backend's delay threshold — display-only; the
   *  payment stays open because GCash can still settle it. */
  const [gcashConfirmationDelayed, setGcashConfirmationDelayed] = useState(false);
  const [gcashError, setGcashError] = useState<string | null>(null);
  const [isInitiatingGcash, setIsInitiatingGcash] = useState(false);
  const [isCancellingGcash, setIsCancellingGcash] = useState(false);
  /** Seconds until the displayed QR expires (drives the countdown badge). */
  const [qrSecondsLeft, setQrSecondsLeft] = useState<number | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Timestamp (ms) when EXPIRED was first observed, or null if not yet seen. */
  const expiredAtRef = useRef<number | null>(null);
  /** One pending-resume check per modal open. */
  const checkedPendingRef = useRef(false);
  /** Latest GCash status, readable from the poll's fallback timeout. */
  const latestGcashStatusRef = useRef<GcashPaymentStatus | null>(null);
  useEffect(() => {
    latestGcashStatusRef.current = gcashStatus;
  }, [gcashStatus]);

  // ── Voucher state ──
  // When the conductor selects Voucher, they enter the voucher code shown
  // by the commuter. The backend validates it + creates a PAID/VOUCHER
  // voucher transaction, collecting any remaining fare in cash.
  const [voucherCode, setVoucherCode] = useState("");
  const [cashReceiptToken, setCashReceiptToken] = useState<string | null>(null);
  const [receiptTransaction, setReceiptTransaction] = useState<{
    transactionId: string;
    timestamp: number;
  } | null>(null);
  const [receiptTransactions, setReceiptTransactions] = useState<Transaction[]>([]);
  const [receiptSettings, setReceiptSettings] = useState<ReceiptSettings>(
    DEFAULT_RECEIPT_SETTINGS
  );
  const [receiptSettingsLoaded, setReceiptSettingsLoaded] = useState(false);
  const [showReceiptDetails, setShowReceiptDetails] = useState(false);
  const autoPrintTriggeredRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    setReceiptSettingsLoaded(false);

    void fetchReceiptSettings()
      .then(setReceiptSettings)
      .catch(() => setReceiptSettings(DEFAULT_RECEIPT_SETTINGS))
      .finally(() => setReceiptSettingsLoaded(true));
  }, [isOpen]);
  // Automatically open the browser print dialog once per completed transaction
  // when enabled by the admin. sessionStorage prevents React rerenders, GCash
  // polling, or modal remounts in the same tab from prompting twice.
  useEffect(() => {
    const transactionId = receiptTransaction?.transactionId;
    if (
      step !== "success" ||
      !receiptSettingsLoaded ||
      !receiptSettings.autoPrint ||
      !transactionId
    ) {
      return;
    }

    const storageKey = `chatco:auto-printed:${transactionId}`;
    if (autoPrintTriggeredRef.current.has(transactionId)) return;

    try {
      if (window.sessionStorage.getItem(storageKey) === "1") {
        autoPrintTriggeredRef.current.add(transactionId);
        return;
      }
      window.sessionStorage.setItem(storageKey, "1");
    } catch {
      // Storage can be unavailable in privacy modes; the in-memory guard still
      // prevents duplicate prompts for the lifetime of this mounted modal.
    }

    autoPrintTriggeredRef.current.add(transactionId);
    const timer = window.setTimeout(() => window.print(), 150);
    return () => window.clearTimeout(timer);
  }, [
    step,
    receiptSettingsLoaded,
    receiptSettings.autoPrint,
    receiptTransaction?.transactionId,
  ]);

  // GCash scan result state — kept for backwards compat with the existing
  // scan_result step UI. The commuter type is now detected by the backend
  // when the commuter claims the QR (passenger_name is bound server-side),
  // so the conductor UI no longer needs to simulate a scan.
  const [scannedCommuterType, setScannedCommuterType] = useState<CommuterType>("REGULAR");
  const [scannedCommuterName, setScannedCommuterName] = useState("Commuter");

  // ─── Fare Calculation (from the backend fare_points table via API) ───
  const fareInfo = useMemo(() => {
    if (!pickupPoint || !dropoffPoint) return null;

    const isDiscounted = commuterType !== "REGULAR";
    const barangaysTraveled = apiGetBarangaysTraversed(
      pickupPoint.pointNumber,
      dropoffPoint.pointNumber
    );
    const regularFare = apiGetFareBetween(
      pickupPoint.pointNumber,
      dropoffPoint.pointNumber,
      false
    );
    const discountedFare = apiGetFareBetween(
      pickupPoint.pointNumber,
      dropoffPoint.pointNumber,
      true
    );
    const finalFare = isDiscounted ? discountedFare : regularFare;
    const discountAmount = regularFare - discountedFare;
    const config = getFareConfig();
    const succeedingCount = Math.max(
      0,
      barangaysTraveled - config.baseBarangayCount
    );

    return {
      barangaysTraveled,
      regularFare,
      discountedFare,
      finalFare,
      hasDiscount: isDiscounted,
      discountAmount,
      succeedingCount,
      baseBarangayCount: config.baseBarangayCount,
    };
  }, [pickupPoint, dropoffPoint, commuterType]);

  // ─── Fare calculation for GCash after scan (uses scanned commuter type) ───
  const gcashFareInfo = useMemo(() => {
    if (!pickupPoint || !dropoffPoint) return null;

    const isDiscounted = scannedCommuterType !== "REGULAR";
    const barangaysTraveled = apiGetBarangaysTraversed(
      pickupPoint.pointNumber,
      dropoffPoint.pointNumber
    );
    const regularFare = apiGetFareBetween(
      pickupPoint.pointNumber,
      dropoffPoint.pointNumber,
      false
    );
    const discountedFare = apiGetFareBetween(
      pickupPoint.pointNumber,
      dropoffPoint.pointNumber,
      true
    );
    const finalFare = isDiscounted ? discountedFare : regularFare;
    const discountAmount = regularFare - discountedFare;
    const config = getFareConfig();
    const succeedingCount = Math.max(
      0,
      barangaysTraveled - config.baseBarangayCount
    );

    return {
      barangaysTraveled,
      regularFare,
      discountedFare,
      finalFare,
      hasDiscount: isDiscounted,
      discountAmount,
      succeedingCount,
      baseBarangayCount: config.baseBarangayCount,
    };
  }, [pickupPoint, dropoffPoint, scannedCommuterType]);

  const enteredGroupPassengers = useMemo<GroupPassengerInput[]>(() => {
    if (!fareInfo) return [];
    return (Object.entries(groupCounts) as [GroupPassengerType, number][])
      .filter(([, quantity]) => quantity > 0)
      .map(([type, quantity]) => ({ passenger_type: type, quantity }));
  }, [fareInfo, groupCounts]);

  // Cash group input represents all passengers. GCash group input represents
  // companions only; the verified commuter who scans the QR is added on claim.
  const groupPassengers = useMemo<GroupPassengerInput[]>(() => {
    return enteredGroupPassengers.map((passenger) => ({ ...passenger }));
  }, [enteredGroupPassengers]);

  const groupEnteredCount = enteredGroupPassengers.reduce((sum, row) => sum + row.quantity, 0);
  const groupPassengerCount = groupPassengers.reduce((sum, row) => sum + row.quantity, 0);
  const finalGroupPassengerCount = selectedMethod === "GCash" ? groupPassengerCount + 1 : groupPassengerCount;
  const shouldShowGroupFareSummary = selectedMethod !== "GCash" || groupEnteredCount > 0;
  const groupTotalFare = groupPassengers.reduce(
    (sum, row) => sum + (row.passenger_type === "REGULAR" ? fareInfo?.regularFare ?? 0 : fareInfo?.discountedFare ?? 0) * row.quantity,
    0
  );
  // e.g. "2 Regular · 1 Student" — shown on the Passenger Group readout and
  // on Confirm Payment for a cash group.
  const groupMix = GROUP_PASSENGER_TYPES
    .filter(({ type }) => groupCounts[type] > 0)
    .map(({ type, label }) => `${groupCounts[type]} ${label}`)
    .join(" · ");

  const filteredPoints = searchQuery
    ? pointAreas.filter(
        (p) =>
          p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
          subDropoffPoints(p).some((l) =>
            l.toLowerCase().includes(searchQuery.toLowerCase())
          )
      )
    : pointAreas;

  // ─── Save CASH/VOUCHER transaction to backend ───
  // Used for Cash + Voucher payments. GCash payments are created server-side
  // by initiateGcash() and finalized by the webhook.
  const recordTransaction = async (method: SelectedPaymentMethod, overrideFare?: { finalFare: number; regularFare: number; discountAmount: number; barangaysTraveled: number; succeedingCount: number }, overrideCommuterType?: CommuterType) => {
    if (!pickupPoint || !dropoffPoint || !shiftId) return;

    const fareData = overrideFare || fareInfo;
    if (!fareData) return;

    // GCash is handled by initiateGcash + the webhook flow — bail here.
    if (method === "GCash") return;

    const paymentMethodType: PaymentMethodType = method === "Voucher" ? "Voucher" : "Cash";
    const effectiveCommuterType = overrideCommuterType || commuterType;

    return createTransaction(shiftId, {
      paymentMethod: paymentMethodType,
      finalAmount: method === "Voucher" ? 0 : fareData.finalFare,
      passengerName: "Commuter",
      passengerId: "",
      passengerRole: effectiveCommuterType,
      from: selectedPointName(pickupPoint, pickupLandmark),
      to: selectedPointName(dropoffPoint, dropoffLandmark),
      pickupStopId: pickupPoint.id,
      dropoffStopId: dropoffPoint.id,
      distance: fareData.barangaysTraveled,
      baseFare: fareData.regularFare,
      succeedingKm: fareData.succeedingCount,
      discountAmount: fareData.discountAmount,
      conductorName: conductorName || "—",
      unitNumber: unitNumber || "—",
      driverName: driverName || "—",
      voucherCode: method === "Voucher" ? voucherCode.trim() : undefined,
    });
  };

  // ─── Stop polling helper ───
  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    expiredAtRef.current = null;
  }, []);

  // ─── Poll GCash payment status until terminal ───
  // Polls GET /api/payments/{id}/status every 3s. Stops when the status
  // reaches a hard-terminal state (paid/failed/cancelled/refunded) or when
  // the QR's expires_at passes AND the late-settlement grace window elapses
  // without resolution. The status endpoint lazily flips stale PENDING rows
  // to EXPIRED; EXPIRED itself is NOT treated as terminal because the
  // commuter may have completed PayMongo checkout seconds before the local
  // expiry, and the late webhook can still flip EXPIRED→PAID. We keep
  // polling for a 60s grace window after EXPIRED first appears.
  //
  // The backend also broadcasts a PaymentStatusUpdated event on the
  // payments.{transactionId} channel — a Pusher listener could replace this
  // polling, but polling is the reliable fallback without Pusher configured.
  const pollGcashStatus = useCallback((transactionId: string, expiresAt?: string) => {
    stopPolling();

    // HARD-TERMINAL statuses end polling immediately. EXPIRED is deliberately
    // excluded — it goes through the grace-window logic below.
    const HARD_TERMINAL: GcashPaymentStatus[] = ["paid", "failed", "cancelled", "refunded"];

    // Grace window after EXPIRED is first observed (server-side default: 60s).
    // The commuter may have authorized on PayMongo just before the local TTL
    // lapsed — the webhook arrives late and flips EXPIRED→PAID. We keep
    // polling through this window to surface that resolution.
    const LATE_SETTLEMENT_GRACE_MS = 60 * 1000;

    pollIntervalRef.current = setInterval(async () => {
      try {
        const payment = await fetchStatus(transactionId);
        const status = payment.status;
        setGcashStatus(status);
        setGcashConfirmationDelayed(payment.confirmationDelayed);

        // PAID is always terminal — success regardless of prior EXPIRED state.
        if (status === "paid") {
          stopPolling();
          setReceiptTransaction({
            transactionId,
            timestamp: Date.now(),
          });
          setReceiptTransactions(payment.receipts);
          setShowReceiptDetails(false);
          setStep("success");
          return;
        }

        // Hard-terminal failure statuses end immediately. A poll only sees
        // CANCELLED when the payment timed out (the backend closes it at
        // PayMongo first) or was cancelled from another device — either way
        // GCash never confirmed it, so nothing was charged.
        if (HARD_TERMINAL.includes(status)) {
          stopPolling();
          setGcashError(
            status === "cancelled"
              ? "Payment cancelled. GCash didn't confirm a payment for this QR code, so the commuter wasn't charged. Generate a new QR code or collect cash."
              : status === "failed"
                ? "The commuter's GCash payment didn't go through, so they weren't charged. Generate a new QR code or collect cash."
                : `Payment ${status}.`
          );
          setStep("failed");
          return;
        }

        // EXPIRED — record when we first saw it, and keep polling through
        // the grace window. If we've already been in EXPIRED for longer
        // than the grace, give up.
        if (status === "expired") {
          if (expiredAtRef.current === null) {
            expiredAtRef.current = Date.now();
          }
          const elapsed = Date.now() - expiredAtRef.current;
          if (elapsed >= LATE_SETTLEMENT_GRACE_MS) {
            stopPolling();
            setGcashError(
              "This QR code has expired. If the commuter already paid on PayMongo, the late webhook may still settle the transaction — check your transaction history in a minute."
            );
            setStep("failed");
          }
          // else: keep polling — the late webhook may still fire.
        }
      } catch {
        // Network error — keep polling, the next tick may recover.
        // The hard fallback timeout below will eventually bail out.
      }
    }, 3000);

    // Hard fallback timeout derived from the QR's expires_at (+ grace window
    // + 30s buffer so the server-side lazy expiry via polling normally wins,
    // AND the late-settlement grace runs to completion, AND a delayed
    // PayMongo webhook has time to land). If expires_at is unavailable,
    // fall back to the 10-minute TTL.
    // PROCESSING is exempt: the commuter already authorized and GCash is
    // still settling, so the QR's claim TTL no longer applies — keep polling
    // until GCash reports an outcome rather than declaring it expired.
    const msUntilExpiry = expiresAt
      ? new Date(expiresAt).getTime() - Date.now()
      : 10 * 60 * 1000;
    pollTimeoutRef.current = setTimeout(() => {
      if (latestGcashStatusRef.current === "processing") return;
      stopPolling();
      setGcashError(
        "This QR code has expired. If the commuter already paid on PayMongo, the late webhook may still settle the transaction — check your transaction history in a minute."
      );
      setGcashStatus("expired");
      setStep("failed");
    }, Math.max(10_000, msUntilExpiry + LATE_SETTLEMENT_GRACE_MS + 30_000));
  }, [stopPolling]);

  // ─── Initiate GCash payment (real API) ───
  // Called when the conductor confirms the GCash fare. Calls the backend's
  // /conductor/payments/gcash/initiate endpoint, which creates a PENDING
  // transaction + qr_token + PayMongo checkout URL. We then move to the
  // qr_code step to display the qr_token for the commuter to scan.
  const handleInitiateGcash = async () => {
    if (!isOnline) {
      setGcashError("GCash is unavailable while offline. Use cash and it will sync when you reconnect.");
      return;
    }
    if (!pickupPoint || !dropoffPoint) return;

    setIsInitiatingGcash(true);
    setGcashError(null);
    setGcashStatus(null);
    setGcashConfirmationDelayed(false);
    setGcashInitiation(null);

    try {
      // Compute the regular fare (no discount yet — the commuter's type is
      // detected server-side when they claim the QR). The backend stores
      // this as the initial final_amount; if the commuter is discounted,
      // the webhook path could adjust it (currently it doesn't — the fare
      // is fixed at initiation time).
      const regularFare = apiGetFareBetween(pickupPoint.pointNumber, dropoffPoint.pointNumber, false);
      const barangaysTraveled = apiGetBarangaysTraversed(pickupPoint.pointNumber, dropoffPoint.pointNumber);

      const initiation = await initiateGcash({
        finalAmount: isGroupMode ? groupTotalFare : regularFare,
        from: selectedPointName(pickupPoint, pickupLandmark),
        to: selectedPointName(dropoffPoint, dropoffLandmark),
        baseFare: regularFare,
        distance: barangaysTraveled,
        discountAmount: isGroupMode ? regularFare - apiGetFareBetween(pickupPoint.pointNumber, dropoffPoint.pointNumber, true) : 0,
        groupPassengers: isGroupMode ? groupPassengers : undefined,
        pickupStopId: pickupPoint.id,
        dropoffStopId: dropoffPoint.id,
      });

      setGcashInitiation(initiation);
      // The backend hands back the shift's existing PROCESSING payment (if
      // any) instead of minting a duplicate; show it as such right away.
      if (initiation.status === "processing") {
        setGcashStatus("processing");
        setGcashConfirmationDelayed(initiation.confirmationDelayed ?? false);
      }
      setStep("qr_code");

      // Start polling for the payment status. The commuter will scan the QR,
      // claim the transaction, redirect to PayMongo, authorize, and the
      // webhook will flip the status to PAID — which we detect via polling.
      // Note: if a fresh PENDING payment already exists for this shift, the
      // backend returns THAT one (same QR) instead of minting a duplicate.
      pollGcashStatus(initiation.transactionId, initiation.expiresAt);
    } catch (err) {
      setGcashError(err instanceof Error ? err.message : "Failed to start GCash payment. Please try again.");
      setStep("failed");
    } finally {
      setIsInitiatingGcash(false);
    }
  };

  // ─── Cancel the GCash payment ───
  // Called when the conductor clicks "Cancel Payment" on the QR step.
  // Transitions the PENDING transaction to CANCELLED through the backend
  // state machine, stops polling, and returns to the method selection step.
  const handleCancelGcash = async () => {
    if (!gcashInitiation) return;
    setIsCancellingGcash(true);
    setGcashError(null);
    try {
      await cancelPayment(gcashInitiation.transactionId);
      stopPolling();
      setGcashInitiation(null);
      setGcashStatus(null);
      setGcashConfirmationDelayed(false);
      setStep("method");
      setSelectedMethod(null);
    } catch (error) {
      // Keep the QR visible when cancellation was not confirmed; hiding it
      // would falsely imply the pending transaction was invalidated.
      setGcashError(error instanceof Error ? error.message : "Unable to cancel payment.");
    } finally {
      setIsCancellingGcash(false);
    }
  };

  // ─── Return to the current GCash payment ───
  // After "Back" from the QR step the payment is still live (polling was
  // only paused), so the location step offers this instead of generating a
  // new QR. Polling resumes and the next tick refreshes the status.
  const handleViewCurrentPayment = () => {
    if (!gcashInitiation) return;
    setGcashError(null);
    setStep("qr_code");
    pollGcashStatus(gcashInitiation.transactionId, gcashInitiation.expiresAt);
  };

  const handlePayWithCash = async () => {
    if (!fareInfo || !pickupPoint || !dropoffPoint) return;

    setStep("processing");

    // Cash payment: brief processing (just recording), then success
    await new Promise((r) => setTimeout(r, 800));

    try {
      if (isGroupMode) {
        const result = await createGroupCashTransaction(shiftId!, {
          from: selectedPointName(pickupPoint, pickupLandmark),
          to: selectedPointName(dropoffPoint, dropoffLandmark),
          regularFare: fareInfo.regularFare,
          discountedFare: fareInfo.discountedFare,
          pickupStopId: pickupPoint.id,
          dropoffStopId: dropoffPoint.id,
          passengers: groupPassengers,
        });
        setReceiptTransactions(result.transactions);
        const firstReceipt = result.transactions[0];
        setCashReceiptToken(firstReceipt?.receiptQrToken ?? null);
        setReceiptTransaction(firstReceipt
          ? { transactionId: firstReceipt.transactionId, timestamp: firstReceipt.timestamp }
          : null);
      } else {
        const transaction = await recordTransaction("Cash");
        setCashReceiptToken(transaction?.receiptQrToken ?? null);
        setReceiptTransactions(transaction ? [transaction] : []);
        setReceiptTransaction(
          transaction
            ? { transactionId: transaction.transactionId, timestamp: transaction.timestamp }
            : null
        );
      }
      setShowReceiptDetails(false);
      setStep("success");
    } catch (err) {
      setGcashError(err instanceof Error ? err.message : "Unable to record cash payment.");
      setStep("failed");
    }
  };

  // ─── Voucher payment ───
  // The conductor enters the voucher code shown by the commuter. The backend
  // validates it + creates a PAID/VOUCHER transaction with final_amount=0.
  const handlePayWithVoucher = async () => {
    if (!isOnline) {
      setGcashError("Voucher validation requires an internet connection. Use cash while offline.");
      return;
    }
    if (!fareInfo || !pickupPoint || !dropoffPoint) return;
    if (!voucherCode.trim()) {
      setGcashError("Please enter the voucher code.");
      setStep("failed");
      return;
    }

    setStep("processing");

    try {
      const transaction = await recordTransaction("Voucher");
      setReceiptTransaction(
        transaction
          ? { transactionId: transaction.transactionId, timestamp: transaction.timestamp }
          : null
      );
      setShowReceiptDetails(false);
      setStep("success");
    } catch (err) {
      setGcashError(err instanceof Error ? err.message : "Voucher validation failed.");
      setStep("failed");
    }
  };

  const handleConfirmPayment = () => {
    if (selectedMethod === "GCash") {
      // GCash: initiate the real backend flow (creates PENDING txn + qr_token).
      handleInitiateGcash();
    } else if (selectedMethod === "Voucher") {
      handlePayWithVoucher();
    } else {
      handlePayWithCash();
    }
  };

  // ─── Handle locations selected in GCash mode ────────────────────
  // After selecting pickup & dropoff for GCash, go to the confirm step.
  // The conductor confirms the fare, then handleInitiateGcash() calls the
  // backend to create the PENDING transaction + qr_token, and we move to
  // the qr_code step to display the QR for the commuter to scan.
  const handleGCashLocationsSelected = () => {
    setStep("confirm");
  };

  // ─── Color state logic ──────────────────────────────────────────
  // Default: GREEN for pickup, RED for dropoff
  // Special: VIOLET/PURPLE when pickup == dropoff (same barangay)
  const isSameBarangay = !!(pickupPoint && dropoffPoint && pickupPoint.pointNumber === dropoffPoint.pointNumber);

  // Color utility classes for pickup/dropoff indicators
  const pickupDotClass = isSameBarangay ? "bg-violet-500" : "bg-emerald-500";
  const dropoffDotClass = isSameBarangay ? "bg-violet-500" : "bg-orange-500";
  // Outline only: a selected card keeps the modal surface, no tinted fill.
  const pickupBorderClass = isSameBarangay ? "border-violet-500" : "border-emerald-500";
  const dropoffBorderClass = isSameBarangay ? "border-violet-500" : "border-orange-500";
  const pickupBadgeClass = isSameBarangay ? "text-violet-400 light:text-violet-700" : "text-emerald-400 light:text-emerald-700";
  const dropoffBadgeClass = isSameBarangay ? "text-violet-400 light:text-violet-700" : "text-orange-400 light:text-orange-700";
  const pickupTagClass = isSameBarangay ? "bg-violet-500 text-white" : "bg-emerald-500 text-white";
  const dropoffTagClass = isSameBarangay ? "bg-violet-500 text-white" : "bg-orange-500 text-white";
  const pickupLabelClass = isSameBarangay ? "text-violet-400 light:text-violet-700" : "text-emerald-400 light:text-emerald-700";
  const dropoffLabelClass = isSameBarangay ? "text-violet-400 light:text-violet-700" : "text-orange-400 light:text-orange-700";

  // ─── Clear location handlers (only reset location, NOT payment) ──
  const clearPickup = () => {
    setPickupPoint(null);
    setPickupLandmark(null);
    setSelectingField("pickup");
    // Collapse expanded barangay if it belonged to the cleared pickup
    if (expandedBarangay === pickupPoint?.pointNumber) {
      setExpandedBarangay(null);
    }
  };

  const clearDropoff = () => {
    setDropoffPoint(null);
    setDropoffLandmark(null);
    setSelectingField("dropoff");
    // Collapse expanded barangay if it belonged to the cleared dropoff
    if (expandedBarangay === dropoffPoint?.pointNumber) {
      setExpandedBarangay(null);
    }
  };

  // ─── RESET STATE & CLOSE ──────────────────────────────────────
  const handleClose = () => {
    // Stop any in-flight GCash status polling before closing.
    stopPolling();

    setStep("method");
    setSelectedMethod(null);
    setPickupPoint(null);
    setDropoffPoint(null);
    setPickupLandmark(null);
    setDropoffLandmark(null);
    setCommuterType("REGULAR");
    setIsGroupMode(false);
    setGroupCounts({ REGULAR: 0, SENIOR_CITIZEN: 0, STUDENT: 0, PWD: 0 });
    setSearchQuery("");
    setSelectingField("pickup");
    setExpandedBarangay(null);
    setRoutePanelOpen(false);
    setGcashInitiation(null);
    setGcashStatus(null);
    setGcashConfirmationDelayed(false);
    setGcashError(null);
    setIsInitiatingGcash(false);
    setIsCancellingGcash(false);
    setScannedCommuterType("REGULAR");
    setScannedCommuterName("Commuter");
    setVoucherCode("");
    setCashReceiptToken(null);
    setReceiptTransaction(null);
    setReceiptTransactions([]);
    setShowReceiptDetails(false);
    onClose();
  };

  // Clicking outside the panel dismisses it, except mid-flight: "processing"
  // (a payment request is in flight — closing would drop its receipt) and
  // "qr_code" (waiting on the commuter's GCash payment — that step has its
  // own explicit Cancel, and a stray click shouldn't abandon it).
  const backdropDismiss = useBackdropDismiss(
    step === "processing" || step === "qr_code" ? undefined : handleClose,
  );

  // ─── Stop polling when the modal unmounts (e.g. user navigates away) ───
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  // ─── Resume an interrupted GCash payment when the modal opens ───
  // If the conductor left the payment screen (navigation, refresh) while a
  // GCash transaction was still PENDING or PROCESSING, re-display the SAME
  // payment + status instead of letting them mint a duplicate. The backend
  // lazily expires stale PENDING rows; PROCESSING ones stay until GCash
  // reports an outcome.
  useEffect(() => {
    if (!isOpen) {
      checkedPendingRef.current = false;
      return;
    }
    if (checkedPendingRef.current) return;
    checkedPendingRef.current = true;

    void (async () => {
      try {
        const pending = await fetchPendingGcash();
        if (!pending) return;

        setSelectedMethod("GCash");
        setGcashInitiation(pending);
        setIsGroupMode(Boolean(pending.groupId));
        setReceiptTransactions(pending.receipts ?? []);
        setGcashStatus(pending.status === "processing" ? "processing" : null);
        setGcashConfirmationDelayed(pending.confirmationDelayed ?? false);
        setGcashError(null);
        setStep("qr_code");
        pollGcashStatus(pending.transactionId, pending.expiresAt);
      } catch {
        // Couldn't check (offline, etc.) — proceed with the normal flow;
        // initiate() still reuses the pending transaction server-side.
      }
    })();
  }, [isOpen, pollGcashStatus]);

  // ─── Countdown until the displayed QR expires ───
  useEffect(() => {
    if (step !== "qr_code" || !gcashInitiation) {
      setQrSecondsLeft(null);
      return;
    }
    const expiryMs = new Date(gcashInitiation.expiresAt).getTime();
    const tick = () => {
      setQrSecondsLeft(Math.max(0, Math.floor((expiryMs - Date.now()) / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [step, gcashInitiation]);

  // ─── Auto-expand landmark when switching selectingField ────────
  // When the user clicks the pickup/dropoff card to re-select,
  // automatically expand the corresponding barangay's landmarks
  // so they can directly pick a landmark without the extra click.
  useEffect(() => {
    if (step !== "select") return;
    if (selectingField === "pickup" && pickupPoint && subDropoffPoints(pickupPoint).length > 0) {
      setExpandedBarangay(pickupPoint.pointNumber);
    } else if (selectingField === "dropoff" && dropoffPoint && subDropoffPoints(dropoffPoint).length > 0) {
      setExpandedBarangay(dropoffPoint.pointNumber);
    }
  }, [selectingField, step, pickupPoint, dropoffPoint]);

  // ─── Refresh the active route's fare matrix whenever the modal opens ───
  // The fare points + config come from GET /api/fare-matrix (the backend's
  // fare_points table — the single source of truth). Force-refreshing here
  // makes admin additions/edits visible without a full conductor-page reload.
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    void loadFareMatrix({ force: true, routeId }).then(() => {
      if (cancelled) return;

      const latestPoints = getPointAreas();
      setPointAreas(latestPoints);
      setPickupPoint((current) =>
        current ? latestPoints.find((point) => point.id === current.id) ?? null : null
      );
      setDropoffPoint((current) =>
        current ? latestPoints.find((point) => point.id === current.id) ?? null : null
      );
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, routeId]);

  // ─── HIDDEN UNTIL CLICKED ──────────────────────────────────────
  if (!isRendered) return null;

  // ─── STEP: Payment Method Selection ────────────────────────────
  //
  // xl:bottom-24 (every step below, not just this one): the backdrop's own
  // box now stops 96px above the viewport bottom instead of covering the
  // full height — that 96px strip is exactly where ConductorDock lives.
  // It used to be xl:pb-24 (padding, same visual gap), but padding is
  // still part of the element's hit area — a transparent-but-still-there
  // backdrop was silently swallowing every click on the dock underneath,
  // so navigating or opening a different popover required closing this
  // one first. Shrinking the box itself means that strip has no backdrop
  // element over it at all, so the dock is directly clickable while a
  // popover is open. See ConductorDock's conductor:close-popovers
  // dispatch for the other half: whichever popover was open closes
  // automatically the moment a different dock item is clicked.
  if (step === "method") {
    return (
      <div className={`fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4 xl:items-end xl:justify-center xl:bg-transparent xl:backdrop-blur-none xl:bottom-24 ${backdropAnim}`} {...backdropDismiss}>
        <PopoverTail panelColor={panelTailColor} anchorOffsetPx={anchorOffset} className="light:border-gray-200" />
        <div className={`w-full sm:max-w-md bg-[#071A2E] light:bg-white sm:rounded-2xl rounded-t-2xl border border-white/10 light:border-gray-200 shadow-2xl ${panelAnim}`} style={panelAnchorStyle}>
          {/* Header */}
          <div className="p-5 border-b border-white/10 light:border-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white light:text-gray-900">Collect Payment</h2>
              <button
                onClick={handleClose}
                className="xl:hidden text-white/40 light:text-gray-500 hover:text-white light:hover:text-gray-900 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-sm text-white/40 light:text-gray-500 mt-1">Choose how the commuter is paying</p>
          </div>

          {/* Method Options */}
          <div className="p-5 space-y-3">
            {blockedReason && (
              <p role="status" className="rounded-xl border border-white/10 light:border-gray-200 bg-[#0E1628] light:bg-gray-50 px-3 py-2 text-xs text-white/70 light:text-gray-700">
                {blockedReason}
              </p>
            )}
            {!isOnline && (
              <div className="rounded-xl border border-amber-500/25 light:border-amber-200 bg-amber-500/10 light:bg-amber-50 px-3 py-2 text-xs text-amber-200 light:text-amber-800">
                Offline mode: cash fares are saved on this device and queued for synchronization. GCash is unavailable.
              </div>
            )}
            {/* Cash Option */}
            <button
              disabled={!!blockedReason}
              onClick={() => {
                if (blockedReason) return;
                setSelectedMethod("Cash");
                setStep("select");
              }}
              className="w-full cursor-pointer text-left p-4 rounded-xl border border-white/10 light:border-gray-200 bg-white/5 light:bg-gray-50 hover:bg-white/10 light:hover:bg-gray-100 hover:border-white/20 light:hover:border-gray-300 transition-all duration-200 group disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/5 light:disabled:hover:bg-gray-50"
            >
              <div className="flex items-center gap-4">
                <svg className="w-9 h-9 flex-shrink-0 text-[#62A0EA] light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <h3 className="text-white light:text-gray-900 font-bold text-sm">Cash Payment</h3>
                  <p className="text-[11px] text-white/40 light:text-gray-500 mt-0.5 leading-relaxed">Collect physical cash from the commuter and record the transaction</p>
                </div>
                <svg className="w-5 h-5 text-white/20 light:text-gray-400 group-hover:text-white/50 light:group-hover:text-gray-600 transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
              </div>
            </button>

            {/* GCash Option */}
            <button
              disabled={!isOnline || !!blockedReason}
              onClick={() => {
                if (!isOnline || blockedReason) return;
                setSelectedMethod("GCash");
                setStep("select");
              }}
              className={`w-full text-left p-4 rounded-xl border transition-all duration-200 group ${!isOnline ? "border-amber-500/20 light:border-amber-200 bg-amber-500/5 light:bg-amber-50 opacity-60 cursor-not-allowed" : blockedReason ? "border-white/10 light:border-gray-200 bg-white/5 light:bg-gray-50 opacity-40 cursor-not-allowed" : "cursor-pointer border-white/10 light:border-gray-200 bg-white/5 light:bg-gray-50 hover:bg-white/10 light:hover:bg-gray-100 hover:border-white/20 light:hover:border-gray-300"}`}
            >
              <div className="flex items-center gap-4">
                <svg className="w-9 h-9 flex-shrink-0 text-[#62A0EA] light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 0 0 6 3.75v16.5a2.25 2.25 0 0 0 2.25 2.25h7.5A2.25 2.25 0 0 0 18 20.25V3.75a2.25 2.25 0 0 0-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
                </svg>
                <div className="flex-1 min-w-0">
                  <h3 className="text-white light:text-gray-900 font-bold text-sm">GCash Payment</h3>
                   <p className="text-[11px] text-white/40 light:text-gray-500 mt-0.5 leading-relaxed">{isOnline ? "Digital payment via GCash — commuter scans QR to pay from their account" : "Unavailable offline. Reconnect to generate a payment QR."}</p>
                </div>
                <svg className="w-5 h-5 text-white/20 light:text-gray-400 group-hover:text-white/50 light:group-hover:text-gray-600 transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
              </div>
            </button>

          </div>

          {/* Footer: history entry + info */}
          <div className="px-5 pb-5 space-y-3">
            {onShowHistory && (
              <button
                type="button"
                onClick={onShowHistory}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/10 light:border-gray-200 bg-[#0E1628] light:bg-white px-4 py-3 text-sm font-semibold text-white light:text-gray-900 hover:bg-[#131C2E] light:hover:bg-gray-100 transition-colors active:scale-[0.98]"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
                Payment History
              </button>
            )}
            <p className="text-[10px] text-white/20 light:text-gray-400 leading-relaxed text-center">
              Both methods will be recorded in the shift transaction log for end-of-day remittance.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ─── STEP: Point Area Selection (FULLSCREEN LOCATION PICKER) ──────

  if (step === "select") {
    // For GCash: no fare display, no commuter type selector
    // For Cash: full existing flow with commuter type + fare overview
    const isGCash = selectedMethod === "GCash";
    const bothLocationsSelected = !!(pickupPoint && dropoffPoint);
    // A GCash payment the conductor stepped back from is still live until
    // it resolves; offering "Generate QR" here would start a second one.
    const hasActiveGcash =
      gcashInitiation !== null &&
      (gcashStatus === null || gcashStatus === "pending" || gcashStatus === "processing");

    return (
      <div className={`fixed inset-0 z-[100] flex flex-col bg-[#050F1A] light:max-sm:bg-gray-50 safe-area-inset sm:items-center sm:justify-center sm:bg-black/60 sm:backdrop-blur-sm sm:p-4 xl:justify-end xl:bg-transparent xl:backdrop-blur-none xl:bottom-24 ${backdropAnim}`} {...backdropDismiss}>
        <PopoverTail panelColor={isLight ? "#F9FAFB" : "#050F1A"} anchorOffsetPx={anchorOffset} className="light:border-gray-200" />
        {/* Own key: without it React reuses the Method step's panel node, so
            the panel's entrance animation never replays and Select Location
            just swaps in. Remounting lets it slide up like the commuter Fare
            Matrix sheet. */}
        <div key="select-location-panel" className={`flex flex-col h-full w-full max-w-lg mx-auto sm:h-auto sm:max-h-[85vh] sm:rounded-2xl sm:border sm:border-white/10 sm:bg-[#050F1A] light:sm:border-gray-200 light:sm:bg-gray-50 sm:shadow-2xl sm:overflow-hidden ${panelAnim}`} style={panelAnchorStyle}>
          {/* ── Fullscreen Header ── */}
          <div className="flex-shrink-0 bg-[#071A2E] light:bg-white border-b border-white/10 light:border-gray-200 pt-safe">
            {/* Top bar: back + title + method badge + close */}
            <div className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => setStep("method")}
                  className="w-9 h-9 rounded-xl bg-white/5 light:bg-gray-50 border border-white/10 light:border-gray-200 flex items-center justify-center text-white/50 light:text-gray-500 hover:text-white light:hover:text-gray-900 hover:bg-white/10 light:hover:bg-gray-100 transition-colors flex-shrink-0"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                  </svg>
                </button>
                <h2 className="text-base sm:text-lg font-bold text-white light:text-gray-900 truncate">Select Location</h2>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Method badge — preserves payment state visibility */}
                <span className="inline-flex items-center gap-2 px-1 text-[10px] font-bold uppercase tracking-[0.16em] text-[#99C1F1] light:text-[#1A5FB4]">
                  <span className="h-1.5 w-1.5 bg-[#62A0EA]" aria-hidden="true" />
                  {selectedMethod}
                </span>
                <button
                  onClick={handleClose}
                  className="xl:hidden w-9 h-9 rounded-xl bg-white/5 light:bg-gray-50 border border-white/10 light:border-gray-200 flex items-center justify-center text-white/40 light:text-gray-500 hover:text-white light:hover:text-gray-900 hover:bg-white/10 light:hover:bg-gray-100 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* ── Pickup & Dropoff Cards with Clear Buttons ──
                Same 0fr -> 1fr row slide as the commuter Fare Matrix. Closed
                below lg it is also `invisible` (switched after the slide
                ends), which keeps its controls out of tab order; always open
                on lg. */}
            <div
              id="conductor-route-panel"
              className={`grid transition-[grid-template-rows,visibility] duration-300 ease-in-out lg:visible lg:grid-rows-[1fr] ${routePanelOpen ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"}`}
            >
            <div className="min-h-0 overflow-hidden">
            <div className="px-4 pb-3 space-y-2.5">
              {/* Pickup Card */}
              <div className="relative">
                <button
                  onClick={() => setSelectingField("pickup")}
                  className={`w-full text-left p-3 rounded-xl border transition-all duration-200 pr-9 ${
                    selectingField === "pickup"
                      ? pickupBorderClass + " border"
                      : pickupPoint
                        ? "border-white/10 light:border-gray-200 bg-white/5 light:bg-gray-50"
                        : "border-white/10 light:border-gray-200 bg-white/5 light:bg-gray-50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${pickupPoint ? pickupDotClass + ' shadow-sm' : 'bg-white/20 light:bg-gray-300'}`} />
                    <span className="text-[10px] font-semibold text-white/40 light:text-gray-500 uppercase tracking-wider">
                      Pickup
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1 ml-[18px]">
                    <span className={`text-sm font-medium ${pickupPoint ? 'text-white light:text-gray-900' : 'text-white/30 light:text-gray-400'}`}>
                      {pickupPoint
                        ? pickupLandmark
                          ? `${pickupPoint.name} · ${pickupLandmark}`
                          : pickupPoint.name
                        : "Select pickup location"}
                    </span>
                    {pickupPoint && (
                      <span className={`text-[10px] ${pickupBadgeClass} px-2 py-0.5 rounded-full ml-2 flex-shrink-0`}>
                        Brgy {pickupPoint.pointNumber}
                      </span>
                    )}
                  </div>
                </button>
                {/* Clear Pickup Button (X) */}
                {pickupPoint && (
                  <button
                    onClick={(e) => { e.stopPropagation(); clearPickup(); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white/5 light:bg-gray-50 border border-white/10 light:border-gray-200 flex items-center justify-center text-white/30 light:text-gray-400 hover:text-white light:hover:text-red-600 hover:bg-red-500/20 hover:border-red-500/30 light:hover:bg-red-50 light:hover:border-red-200 transition-colors"
                    title="Clear pickup"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Swap icon */}
              <div className="flex justify-center">
                <button
                  onClick={() => {
                    if (pickupPoint && dropoffPoint) {
                      const tmpPoint = pickupPoint;
                      const tmpLandmark = pickupLandmark;
                      setPickupPoint(dropoffPoint);
                      setPickupLandmark(dropoffLandmark);
                      setDropoffPoint(tmpPoint);
                      setDropoffLandmark(tmpLandmark);
                    }
                  }}
                  className="w-7 h-7 rounded-full bg-white/5 light:bg-gray-50 border border-white/10 light:border-gray-200 flex items-center justify-center hover:bg-white/10 light:hover:bg-gray-100 transition-colors"
                >
                  <svg className="w-3.5 h-3.5 text-white/40 light:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                  </svg>
                </button>
              </div>

              {/* Dropoff Card */}
              <div className="relative">
                <button
                  onClick={() => setSelectingField("dropoff")}
                  className={`w-full text-left p-3 rounded-xl border transition-all duration-200 pr-9 ${
                    selectingField === "dropoff"
                      ? dropoffBorderClass + " border"
                      : dropoffPoint
                        ? "border-white/10 light:border-gray-200 bg-white/5 light:bg-gray-50"
                        : "border-white/10 light:border-gray-200 bg-white/5 light:bg-gray-50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${dropoffDotClass} ${dropoffPoint ? 'shadow-sm' : 'bg-white/20 light:bg-gray-300'}`} />
                    <span className="text-[10px] font-semibold text-white/40 light:text-gray-500 uppercase tracking-wider">
                      Drop-off
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1 ml-[18px]">
                    <span className={`text-sm font-medium ${dropoffPoint ? 'text-white light:text-gray-900' : 'text-white/30 light:text-gray-400'}`}>
                      {dropoffPoint
                        ? dropoffLandmark
                          ? `${dropoffPoint.name} · ${dropoffLandmark}`
                          : dropoffPoint.name
                        : "Select drop-off location"}
                    </span>
                    {dropoffPoint && (
                      <span className={`text-[10px] ${dropoffBadgeClass} px-2 py-0.5 rounded-full ml-2 flex-shrink-0`}>
                        Brgy {dropoffPoint.pointNumber}
                      </span>
                    )}
                  </div>
                </button>
                {/* Clear Dropoff Button (X) */}
                {dropoffPoint && (
                  <button
                    onClick={(e) => { e.stopPropagation(); clearDropoff(); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white/5 light:bg-gray-50 border border-white/10 light:border-gray-200 flex items-center justify-center text-white/30 light:text-gray-400 hover:text-white light:hover:text-red-600 hover:bg-red-500/20 hover:border-red-500/30 light:hover:bg-red-50 light:hover:border-red-200 transition-colors"
                    title="Clear drop-off"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Same barangay warning */}
              {isSameBarangay && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-violet-500">
                  <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse flex-shrink-0" />
                  <span className="text-[10px] text-violet-300 light:text-violet-700 font-medium">Same pickup & drop-off — both locations shown in violet</span>
                </div>
              )}

              {/* Passenger mode action + single-passenger type selection. */}
              {selectedMethod !== "Voucher" && (
                <div className="mt-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-semibold text-white/40 light:text-gray-500 uppercase tracking-wider">
                      {isGCash ? "Passengers" : "Commuter Type"}
                    </span>
                    <div className="flex rounded-lg border border-white/10 light:border-gray-200 bg-white/5 light:bg-gray-50 p-0.5" role="group" aria-label="Payment passenger mode">
                      {([false, true] as const).map((multiple) => (
                        <button
                          key={String(multiple)}
                          type="button"
                          aria-pressed={isGroupMode === multiple}
                          onClick={() => setIsGroupMode(multiple)}
                          className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition-colors ${isGroupMode === multiple ? "bg-[#1A5FB4] text-white" : "text-white/45 light:text-gray-500 hover:text-white/70 light:hover:text-gray-700"}`}
                        >
                          {multiple ? "Multiple" : "Single"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="mt-1 text-[10px] text-white/45 light:text-gray-500">
                    {isGroupMode
                      ? isGCash
                        ? "Multiple - Enter companions only; the payer is added after QR claim"
                        : "Multiple - Enter passenger quantities"
                      : "Single · One payer, one transaction"}
                  </p>
                  {!isGCash && !isGroupMode && (
                  <div className="flex gap-1.5 mt-1.5 overflow-x-auto pb-1 -mx-1 px-1">
                    {(
                      ["REGULAR", "STUDENT", "SENIOR_CITIZEN", "PWD"] as CommuterType[]
                    ).map((type) => (
                      <button
                        key={type}
                        onClick={() => setCommuterType(type)}
                        className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors whitespace-nowrap flex-shrink-0 ${
                          commuterType === type
                            ? "bg-[#1A5FB4] text-white"
                            : "bg-white/5 light:bg-gray-50 text-white/50 light:text-gray-500 hover:bg-white/10 light:hover:bg-gray-100"
                        }`}
                      >
                        {getCommuterTypeLabel(type)}
                      </button>
                    ))}
                  </div>
                  )}
                  {isGroupMode && (
                    <p className="mt-1.5 text-[10px] text-blue-300/70 light:text-blue-700">
                      Multiple selected - review the route, then enter passenger quantities.
                    </p>
                  )}
                </div>
              )}
            </div>
            </div>
            </div>
            {/* Small-screen toggle bar, same as the commuter Fare Matrix's:
                chevron points down to open the panel, up to close it. */}
            <button
              type="button"
              onClick={() => setRoutePanelOpen((open) => !open)}
              aria-expanded={routePanelOpen}
              aria-controls="conductor-route-panel"
              aria-label={routePanelOpen ? "Hide pickup and drop-off" : "Show pickup and drop-off"}
              className="flex items-center justify-center py-1.5 w-full border-t border-white/5 hover:bg-white/5 transition-colors active:bg-white/10 light:border-gray-200 light:hover:bg-gray-50 light:active:bg-gray-100 lg:hidden"
            >
              <svg className={`w-4 h-4 text-white/30 light:text-gray-400 transition-transform duration-300 ${routePanelOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
          </div>

          {/* ── Search Bar ── */}
          <div className="flex-shrink-0 px-4 pt-3 pb-2 bg-[#050F1A] light:bg-gray-50">
            <div className="relative">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 light:text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
                />
              </svg>
              <input
                type="text"
                placeholder="Search barangay or landmark..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white/5 light:bg-gray-50 border border-white/10 light:border-gray-200 rounded-xl pl-9 pr-3 py-2.5 text-sm text-white light:text-gray-900 placeholder:text-white/30 light:placeholder:text-gray-400 focus:outline-none focus:border-[#62A0EA]/60 transition-colors"
              />
            </div>
            <p className="text-[10px] text-white/30 light:text-gray-400 mt-2">
              {selectingField === "pickup"
                ? "Tap your boarding Point Area — then select a sub pickup point"
                : "Tap your destination Point Area — then select a sub drop-off point"}
              {" "}&middot; Auto-opens after selection
            </p>
          </div>

          {/* ── Barangay List (fills remaining space) ── */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-3 overscroll-contain">
            {filteredPoints.map((point) => {
              const isPickup = pickupPoint?.pointNumber === point.pointNumber;
              const isDropoff = dropoffPoint?.pointNumber === point.pointNumber;
              const isSelected = isPickup || isDropoff;
              const isExpanded = expandedBarangay === point.pointNumber;
              const pointSubDropoffs = subDropoffPoints(point);

              // Color classes for barangay list items (green default, violet when same)
              const itemPickupBg = isSameBarangay ? "border-violet-500" : "border-emerald-500";
              const itemDropoffBg = isSameBarangay ? "border-violet-500" : "border-orange-500";
              const itemBothBg = "border-violet-500";

              return (
                <div key={point.pointNumber} className="mb-1">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (selectingField === "pickup") {
                        setPickupPoint(point);
                        setPickupLandmark(null);
                        if (pointSubDropoffs.length > 0) {
                          setExpandedBarangay(point.pointNumber);
                        } else {
                          setSelectingField("dropoff");
                        }
                      } else {
                        setDropoffPoint(point);
                        setDropoffLandmark(null);
                        if (pointSubDropoffs.length > 0) {
                          setExpandedBarangay(point.pointNumber);
                        }
                      }
                      setSearchQuery("");
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); (e.target as HTMLElement).click(); } }}
                    className={`w-full text-left p-3 rounded-xl transition-colors cursor-pointer border ${
                      isSelected
                        ? isPickup && isDropoff
                          ? itemBothBg
                          : isPickup
                            ? itemPickupBg
                            : itemDropoffBg
                        : "border-white/[0.04] light:border-gray-200 hover:bg-white/[0.04] light:hover:bg-gray-100"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex flex-col items-center flex-shrink-0">
                          <span className="text-[9px] font-bold text-white/25 light:text-gray-400 leading-none">PT</span>
                          <span className="text-sm font-bold text-white/60 light:text-gray-600 leading-none mt-0.5">{point.pointNumber}</span>
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-semibold text-white light:text-gray-900 truncate">{point.name}</span>
                            <span className="text-[9px] font-semibold text-white/20 light:text-gray-400 flex-shrink-0">Brgy {point.pointNumber}</span>
                          </div>
                          {pointSubDropoffs.length > 0 && (
                            <p className="text-[10px] text-white/30 light:text-gray-400 mt-0.5 truncate">
                              {pointSubDropoffs.join(" · ")}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                        {isPickup && (
                          <span className={`text-[8px] font-bold ${pickupTagClass} px-1.5 py-0.5 rounded`}>PICKUP</span>
                        )}
                        {isDropoff && (
                          <span className={`text-[8px] font-bold ${dropoffTagClass} px-1.5 py-0.5 rounded`}>DROP-OFF</span>
                        )}

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedBarangay(isExpanded ? null : point.pointNumber);
                          }}
                          className="w-7 h-7 rounded-lg bg-white/5 light:bg-gray-50 border border-white/10 light:border-gray-200 flex items-center justify-center hover:bg-white/10 light:hover:bg-gray-100 transition-colors"
                        >
                          <svg
                            className={`w-3.5 h-3.5 text-white/40 light:text-gray-500 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="m19.5 8.25-7.5 7.5-7.5-7.5"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Expanded sub pickup/drop-off points */}
                  {isExpanded && (
                    <div className="ml-11 mt-1 mb-2 space-y-1">
                      <p className="text-[10px] text-white/20 light:text-gray-400 uppercase tracking-wider font-medium mb-1.5">
                        Sub pickup/drop-off points in {point.name} <span className="text-white/10 light:text-gray-300">· tap to select</span>
                      </p>
                      {/* Skip sub-point button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (selectingField === "pickup") {
                            setSelectingField("dropoff");
                          }
                          setExpandedBarangay(null);
                        }}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-md w-full text-left transition-colors border cursor-pointer bg-white/[0.02] border-transparent hover:bg-amber-500/5 hover:border-amber-500/20 light:hover:bg-amber-50 light:hover:border-amber-200"
                      >
                        <div className="w-1.5 h-1.5 rounded-full bg-amber-400/50" />
                        <span className="text-[11px] text-amber-400/70 light:text-amber-700">
                          Use Point Area only
                        </span>
                      </button>
                      {pointSubDropoffs.map((landmark, idx) => {
                        const isLandmarkPickup = pickupPoint?.pointNumber === point.pointNumber && pickupLandmark === landmark;
                        const isLandmarkDropoff = dropoffPoint?.pointNumber === point.pointNumber && dropoffLandmark === landmark;
                        const isLandmarkSelected = isLandmarkPickup || isLandmarkDropoff;

                        // Pickup is green and drop-off is red; shared locations stay violet.
                        const lmPickupBgCls = isSameBarangay ? "border-violet-500" : "border-emerald-500";
                        const lmDropoffBgCls = isSameBarangay ? "border-violet-500" : "border-orange-500";
                        const lmPickupDotCls = isSameBarangay ? "bg-violet-400" : "bg-emerald-400";
                        const lmDropoffDotCls = isSameBarangay ? "bg-violet-400" : "bg-orange-400";
                        const lmPickupTextCls = isSameBarangay ? "text-violet-400 light:text-violet-700" : "text-emerald-400 light:text-emerald-700";
                        const lmDropoffTextCls = isSameBarangay ? "text-violet-400 light:text-violet-700" : "text-orange-400 light:text-orange-700";

                        return (
                          <div
                            role="button"
                            tabIndex={0}
                            key={idx}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (selectingField === "pickup") {
                                if (pickupPoint?.pointNumber !== point.pointNumber) {
                                  setPickupPoint(point);
                                }
                                setPickupLandmark(landmark);
                                setSelectingField("dropoff");
                              } else {
                                if (dropoffPoint?.pointNumber !== point.pointNumber) {
                                  setDropoffPoint(point);
                                }
                                setDropoffLandmark(landmark);
                              }
                              setExpandedBarangay(null);
                            }}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); (e.target as HTMLElement).click(); } }}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded-md w-full text-left transition-colors border cursor-pointer ${
                              isLandmarkSelected
                                ? isLandmarkPickup && isLandmarkDropoff
                                  ? "border-violet-500"
                                  : isLandmarkPickup
                                    ? lmPickupBgCls
                                    : lmDropoffBgCls
                                : "bg-white/[0.02] border-transparent hover:bg-white/5 light:hover:bg-gray-100"
                            }`}
                          >
                            <div className={`w-1.5 h-1.5 rounded-full ${
                              isLandmarkSelected
                                ? isLandmarkPickup ? lmPickupDotCls : lmDropoffDotCls
                                : "bg-white/20 light:bg-gray-300"
                            }`} />
                            <span className={`text-[11px] ${
                              isLandmarkSelected
                                ? isLandmarkPickup ? lmPickupTextCls : lmDropoffTextCls
                                : "text-white/40 light:text-gray-500"
                            }`}>
                              {landmark}
                            </span>
                            {isLandmarkPickup && !isLandmarkDropoff && (
                              <span className={`text-[8px] font-bold ${lmPickupTextCls} bg-white/5 light:bg-gray-50 px-1 py-0.5 rounded ml-auto`}>PICKUP</span>
                            )}
                            {isLandmarkDropoff && !isLandmarkPickup && (
                              <span className={`text-[8px] font-bold ${lmDropoffTextCls} bg-white/5 light:bg-gray-50 px-1 py-0.5 rounded ml-auto`}>DROP-OFF</span>
                            )}
                            {isLandmarkPickup && isLandmarkDropoff && (
                              <span className="text-[8px] font-bold text-violet-400 light:text-violet-700 px-1 py-0.5 ml-auto">BOTH</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ── Bottom Action Area ── */}
          {/* GCash mode with a live payment: return to it instead of starting another */}
          {isGCash && hasActiveGcash && gcashInitiation && (
            <div className="flex-shrink-0 border-t border-white/10 light:border-gray-200 bg-[#050F1A] light:bg-gray-50 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <p className="text-xs text-white/70 light:text-gray-700 font-medium">
                  {gcashStatus === "processing" ? "GCash is confirming this payment" : "GCash payment in progress"}
                </p>
                <p className="text-sm font-semibold text-white light:text-gray-900 tabular-nums">{formatCurrency(gcashInitiation.amount)}</p>
              </div>
              <button
                onClick={handleViewCurrentPayment}
                className="w-full py-3.5 rounded-xl font-bold text-sm transition-colors shadow-lg active:scale-[0.98] bg-[#1A5FB4] hover:bg-[#164A8F] text-white shadow-[#1A5FB4]/30"
              >
                View current payment
              </button>
              <p className="text-[10px] text-white/25 light:text-gray-400 text-center mt-2">
                Finish or cancel this payment before generating a new QR code
              </p>
            </div>
          )}

          {/* GCash mode: Show "Generate QR Code" button when both locations selected, NO fare display */}
          {isGCash && !hasActiveGcash && bothLocationsSelected && (
            <div className="flex-shrink-0 border-t border-white/10 light:border-gray-200 bg-[#050F1A] light:bg-gray-50 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
              {/* Route confirmation only, NO fare */}
              <div className="mb-3 flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <div className={`w-2.5 h-2.5 rounded-full ${pickupDotClass}`} />
                  <span className="text-xs text-white/70 light:text-gray-700 font-medium">{pickupPoint?.name}{pickupLandmark ? ` · ${pickupLandmark}` : ""}</span>
                </div>
                <svg className="w-3 h-3 text-white/20 light:text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                </svg>
                <div className="flex items-center gap-1.5">
                  <div className={`w-2.5 h-2.5 rounded-full ${dropoffDotClass}`} />
                  <span className="text-xs text-white/70 light:text-gray-700 font-medium">{dropoffPoint?.name}{dropoffLandmark ? ` · ${dropoffLandmark}` : ""}</span>
                </div>
              </div>

              <button
                onClick={() => isGroupMode ? setStep("passengers") : handleGCashLocationsSelected()}
                className="w-full py-3.5 rounded-xl font-bold text-sm transition-colors shadow-lg active:scale-[0.98] bg-[#1A5FB4] hover:bg-[#164A8F] text-white shadow-[#1A5FB4]/30"
              >
                {isGroupMode ? "Review Transaction" : "Generate QR Code"}
              </button>
              <p className="text-[10px] text-white/25 light:text-gray-400 text-center mt-2">
                Fare will be calculated after the commuter scans the QR code
              </p>
            </div>
          )}

          {/* Cash mode: Show fare summary & pay button (existing behavior) */}
          {!isGCash && fareInfo && (
            <div className="flex-shrink-0 border-t border-white/10 light:border-gray-200 bg-[#050F1A] light:bg-gray-50 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
              {/* Route confirmation with dynamic color indicators */}
              <div className="mb-2 flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <div className={`w-2.5 h-2.5 rounded-full ${pickupDotClass}`} />
                  <span className="text-xs text-white/70 light:text-gray-700 font-medium">{pickupPoint?.name}{pickupLandmark ? ` · ${pickupLandmark}` : ""}</span>
                </div>
                <svg className="w-3 h-3 text-white/20 light:text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                </svg>
                <div className="flex items-center gap-1.5">
                  <div className={`w-2.5 h-2.5 rounded-full ${dropoffDotClass}`} />
                  <span className="text-xs text-white/70 light:text-gray-700 font-medium">{dropoffPoint?.name}{dropoffLandmark ? ` · ${dropoffLandmark}` : ""}</span>
                </div>
              </div>

              {/* Fare Explanation */}
              <div className="mb-3 px-3 py-2 rounded-lg bg-white/[0.03] light:bg-gray-50 border border-white/5 light:border-gray-200">
                <p className="text-[10px] text-white/30 light:text-gray-400 leading-relaxed">
                  {fareInfo.barangaysTraveled} barangay{fareInfo.barangaysTraveled !== 1 ? "s" : ""} traversed
                  {fareInfo.succeedingCount > 0 &&
                    ` · Base fare covers first ${fareInfo.baseBarangayCount} + ${fareInfo.succeedingCount} succeeding`}
                </p>
              </div>

              <div className="mb-3 flex items-center justify-between rounded-xl border border-white/10 light:border-gray-200 bg-white/[0.03] light:bg-gray-50 px-4 py-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45 light:text-gray-500">
                    Total fare
                  </p>
                  {fareInfo.hasDiscount && (
                    <p className="mt-1 text-[10px] font-medium text-[#62A0EA] light:text-[#1A5FB4]">
                      You save {formatCurrency(fareInfo.discountAmount)}
                    </p>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  {fareInfo.hasDiscount && (
                    <p className="mb-0.5 text-xs text-white/30 light:text-gray-400 line-through">
                      {formatCurrency(fareInfo.regularFare)}
                    </p>
                  )}
                  <p className="text-2xl font-extrabold leading-none text-white light:text-gray-900">
                    {formatCurrency(fareInfo.finalFare)}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setStep(isGroupMode ? "passengers" : "confirm")}
                className="w-full py-3.5 rounded-xl font-bold text-sm transition-colors shadow-lg active:scale-[0.98] bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/30"
              >
                {isGroupMode ? "Review Transaction" : `Pay ${formatCurrency(fareInfo.finalFare)} with Cash`}
              </button>
            </div>
          )}

          {/* No locations selected yet — show hint */}
          {isGCash && !hasActiveGcash && !bothLocationsSelected && (
            <div className="flex-shrink-0 border-t border-white/10 light:border-gray-200 bg-[#050F1A] light:bg-gray-50 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
              <div className="text-center py-2">
                <p className="text-[11px] text-white/30 light:text-gray-400">Select both pickup and drop-off locations to generate QR code</p>
              </div>
            </div>
          )}

          {!isGCash && !fareInfo && (
            <div className="flex-shrink-0 border-t border-white/10 light:border-gray-200 bg-[#050F1A] light:bg-gray-50 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
              <div className="text-center py-2">
                <p className="text-[11px] text-white/30 light:text-gray-400">Select both pickup and drop-off to calculate fare</p>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ─── STEP: Group passenger composition ───────────────────────────
  if (step === "passengers") {
    const passengerTypes = GROUP_PASSENGER_TYPES;
    const isGCashGroup = selectedMethod === "GCash";
    const groupDiscountTotal = ((fareInfo?.regularFare ?? 0) * groupPassengerCount) - groupTotalFare;
    const groupNoun = isGCashGroup
      ? groupEnteredCount === 1 ? "companion" : "companions"
      : groupEnteredCount === 1 ? "passenger" : "passengers";

    return (
      <div className={`fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4 xl:items-end xl:justify-center xl:bg-transparent xl:backdrop-blur-none xl:bottom-24 ${backdropAnim}`} {...backdropDismiss}>
        <PopoverTail panelColor={panelTailColor} anchorOffsetPx={anchorOffset} className="light:border-gray-200" />
        {/* Capped to the backdrop's padded height so the header can never be
            pushed off a short phone screen; only the tiles scroll, the
            readout and actions stay pinned. */}
        <div className={`flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 light:border-gray-200 bg-[#071A2E] light:bg-white shadow-2xl ${panelAnim}`} style={panelAnchorStyle}>
          <div className="flex-shrink-0 border-b border-white/10 light:border-gray-200 px-4 py-4 sm:p-5">
            <h2 className="text-lg font-bold text-white light:text-gray-900">Passenger Group</h2>
            <p className="mt-1 text-xs text-white/40 light:text-gray-500">
              {pickupPoint?.name} → {dropoffPoint?.name}
            </p>
          </div>

          {/* Readout: headcount and total first, the mix spelled out below. */}
          <div className="grid flex-shrink-0 grid-cols-[auto_1fr] items-end gap-x-4 gap-y-1 border-b border-white/10 light:border-gray-200 bg-[#050F1A] light:bg-gray-50 px-4 py-5 sm:px-5" aria-live="polite">
            <span className="text-[44px] font-bold leading-[0.9] tracking-tight tabular-nums text-white light:text-gray-900">{groupEnteredCount}</span>
            <span className="text-right text-[22px] font-bold leading-none tabular-nums text-white light:text-gray-900">
              {shouldShowGroupFareSummary && groupEnteredCount > 0 ? formatCurrency(groupTotalFare) : "—"}
            </span>
            <span className="text-[11px] text-white/45 light:text-gray-500">
              {groupNoun}{isGCashGroup && " + payer"}
            </span>
            <span className="text-right text-[11px] text-white/45 light:text-gray-500">
              {shouldShowGroupFareSummary && groupDiscountTotal > 0 ? (
                <><span className="tabular-nums text-emerald-300 light:text-emerald-700">{formatCurrency(groupDiscountTotal)}</span> discount</>
              ) : groupEnteredCount > 0 ? "total" : ""}
            </span>
            <p className="col-span-2 mt-2.5 min-h-4 text-[11px] text-white/55 light:text-gray-600">
              {groupMix || (isGCashGroup ? "Payer is added when they scan the QR" : "Tap a tile for each passenger")}
            </p>
          </div>

          <div className="modal-scroll min-h-0 flex-1 overflow-y-auto">
            <div className="grid grid-cols-2 gap-2.5 px-4 py-4 sm:px-5">
              {passengerTypes.map(({ type, label }) => {
                const count = groupCounts[type];
                const fare = type === "REGULAR" ? fareInfo?.regularFare ?? 0 : fareInfo?.discountedFare ?? 0;
                const shouldShowTypeFare = !isGCashGroup || count > 0;
                return (
                  <div key={type} className="relative">
                    <button
                      type="button"
                      aria-label={`Add ${label}, ${count} added`}
                      disabled={count >= 50}
                      onClick={() => setGroupCounts((current) => ({ ...current, [type]: Math.min(50, current[type] + 1) }))}
                      className={`flex min-h-[104px] w-full cursor-pointer flex-col justify-between rounded-xl border p-3.5 pr-11 text-left transition-[transform,background-color,border-color] duration-150 active:scale-[0.98] disabled:cursor-not-allowed ${
                        count > 0
                          ? "border-[#62A0EA]/45 light:border-[#1A5FB4] bg-[#1A5FB4]/[0.14] light:bg-[#F0F7FF]"
                          : "border-white/10 light:border-gray-200 bg-white/[0.03] light:bg-gray-50 hover:bg-white/[0.06] light:hover:bg-gray-100"
                      }`}
                    >
                      <span>
                        <span className="block text-sm font-semibold text-white light:text-gray-900">{label}</span>
                        {shouldShowTypeFare && (
                          <span className="mt-0.5 block text-[11px] tabular-nums text-white/45 light:text-gray-500">{formatCurrency(fare)}</span>
                        )}
                      </span>
                      <span className={`text-[28px] font-bold leading-none tabular-nums ${count > 0 ? "text-white light:text-gray-900" : "text-white/20 light:text-gray-400"}`}>{count}</span>
                    </button>
                    {count > 0 && (
                      <button
                        type="button"
                        aria-label={`Remove ${label}`}
                        onClick={() => setGroupCounts((current) => ({ ...current, [type]: Math.max(0, current[type] - 1) }))}
                        className="absolute right-2 top-2 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-white/10 light:border-gray-200 bg-[#071A2E] light:bg-white text-white/70 light:text-gray-700 transition-colors hover:text-white light:hover:text-gray-900 active:scale-95"
                      >
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" d="M5 12h14" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="px-4 pb-4 text-[11px] text-white/40 light:text-gray-500 sm:px-5">Tap a tile to add one. Use the minus button to remove one.</p>
          </div>

          <div className="flex flex-shrink-0 gap-3 px-4 pb-4 sm:px-5 sm:pb-5">
            <button type="button" onClick={() => setStep("select")} className="flex-1 cursor-pointer rounded-xl border border-white/10 light:border-gray-200 py-3 text-sm font-semibold text-white/60 light:text-gray-600 transition-colors hover:bg-white/5 light:hover:bg-gray-100">Back</button>
            <button
              type="button"
              disabled={groupEnteredCount === 0 || !pickupPoint || !dropoffPoint || isInitiatingGcash}
              // A cash group is recorded as PAID the moment it's submitted and a
              // conductor can't void it, so it goes through Confirm Payment
              // first. GCash goes straight to the QR, which can still be cancelled.
              onClick={isGCashGroup ? handleConfirmPayment : () => setStep("confirm")}
              className="flex-[2] cursor-pointer rounded-xl bg-[#1A5FB4] py-3 text-sm font-bold text-white transition-colors hover:bg-[#164A8F] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[#1A5FB4]"
            >
              {isInitiatingGcash
                ? "Starting…"
                : isGCashGroup
                  ? groupEnteredCount > 0
                    ? `Generate QR · ${formatCurrency(groupTotalFare)}`
                    : "Generate QR"
                  : `Review · ${formatCurrency(groupTotalFare)}`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── STEP: QR Code (GCash only — commuter scans this) ────────────
  // Displays the server-issued qr_token as a QR code. The commuter scans
  // this QR with their app, which calls POST /api/commuter/payments/claim
  // { qr_token } — the backend binds the commuter's passenger_id to the
  // transaction and returns the PayMongo checkout_url. The commuter then
  // redirects to PayMongo to authorize. The webhook flips status to PAID,
  // which we detect via the polling loop started in handleInitiateGcash.
  // NOTE: pickupPoint/dropoffPoint are NOT required here — a resumed payment
  // (after navigation/refresh) has no location-picker state, so the route is
  // read from the transaction row (gcashInitiation.from/to) as a fallback.
  if (step === "qr_code" && gcashInitiation) {
    // The QR encodes JUST the qr_token (a 32-char opaque string). The
    // commuter's app extracts it and POSTs it to /commuter/payments/claim.
    // We do NOT encode JSON or transaction details in the QR — the backend
    // is the source of truth and the qr_token is the lookup key.
    const qrData = gcashInitiation.qrToken;
    const routeFrom = pickupPoint?.name ?? gcashInitiation.from ?? null;
    const routeTo = dropoffPoint?.name ?? gcashInitiation.to ?? null;
    const countdownLabel =
      qrSecondsLeft !== null
        ? `${Math.floor(qrSecondsLeft / 60)}:${String(qrSecondsLeft % 60).padStart(2, "0")}`
        : null;
    // PROCESSING: the commuter already scanned and authorized; GCash is
    // settling it. The QR is spent (claiming it again would be refused) and
    // its claim countdown no longer applies, and GCash can't cancel it.
    const isConfirming = gcashStatus === "processing";
    const isExpiringSoon = qrSecondsLeft !== null && qrSecondsLeft <= 30;
    // Only null/pending/processing/expired reach this step; paid and the
    // other terminal statuses move the modal to success/failed first.
    const isStatusWarning = gcashStatus === "expired" || (isConfirming && gcashConfirmationDelayed);
    const statusLabel = isConfirming
      ? gcashConfirmationDelayed ? "Confirmation delayed" : "GCash is confirming"
      : gcashStatus === "expired"
        ? "QR expired, waiting for PayMongo"
        : gcashStatus === "pending"
          ? "Waiting for the commuter to pay"
          : "Waiting for commuter scan";

    return (
      <div className={`fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4 xl:items-end xl:justify-center xl:bg-transparent xl:backdrop-blur-none xl:bottom-24 ${backdropAnim}`} {...backdropDismiss}>
        <PopoverTail panelColor={panelTailColor} anchorOffsetPx={anchorOffset} className="light:border-gray-200" />
        <div className={`modal-scroll max-h-full w-full max-w-sm overflow-y-auto rounded-2xl border border-white/10 light:border-gray-200 bg-[#071A2E] light:bg-white shadow-2xl ${panelAnim}`} style={panelAnchorStyle}>
          {/* Amount first, like Confirm Payment: what's being charged and for
              which trip, before the code the commuter has to scan. */}
          <div className="px-5 pt-5 pb-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/40 light:text-gray-500">
                {isConfirming ? "Confirming Payment" : "Scan to Pay"}
              </h2>
              <span className="text-[11px] font-semibold text-white/40 light:text-gray-500">GCash</span>
            </div>
            <p className="mt-2 text-[40px] font-bold leading-none tracking-tight tabular-nums text-white light:text-gray-900">
              {formatCurrency(gcashInitiation.amount)}
            </p>
            {routeFrom && routeTo && (
              <p className="mt-2 text-xs leading-snug text-white/55 light:text-gray-600">
                {routeFrom} <span className="text-white/30 light:text-gray-400">→</span> {routeTo}
              </p>
            )}
          </div>

          {/* The QR is spent once the commuter authorizes, so the plate gives
              way to the confirmation note instead of a dead code. */}
          <div className="px-5">
            {isConfirming ? (
              <div className="rounded-xl border border-white/10 light:border-gray-200 bg-[#050F1A] light:bg-gray-50 px-4 py-5">
                <p className="text-sm font-semibold text-white light:text-gray-900">The commuter authorized this payment.</p>
                <p className="mt-1.5 text-xs leading-relaxed text-white/55 light:text-gray-600">
                  {gcashConfirmationDelayed
                    ? "GCash hasn't confirmed this payment yet. Keep it open and don't collect this fare another way; it updates here once GCash responds."
                    : "GCash is confirming it now, so it can't be cancelled."}
                </p>
              </div>
            ) : (
              <>
                <div className="flex justify-center rounded-xl bg-white p-4 light:border light:border-gray-200">
                  <QRCodeSVG
                    value={qrData}
                    size={256}
                    bgColor="#ffffff"
                    fgColor="#071A2E"
                    level="H"
                    includeMargin={false}
                    className="h-auto w-full max-w-[232px]"
                  />
                </div>
                <p className="mt-2.5 text-[11px] leading-relaxed text-white/45 light:text-gray-500">
                  Commuter scans this with the e-Chatco app to pay through GCash.
                </p>
              </>
            )}
          </div>

          {/* Live status and the QR's remaining time share one readout row. */}
          <div className="mt-4 flex items-center justify-between gap-3 border-y border-white/10 light:border-gray-200 bg-[#050F1A] light:bg-gray-50 px-5 py-3" aria-live="polite">
            <span className={`flex min-w-0 items-center gap-2 text-xs font-semibold ${isStatusWarning ? "text-white light:text-gray-900" : "text-white/80 light:text-gray-800"}`}>
              <span aria-hidden="true" className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${isStatusWarning ? "bg-white/50 light:bg-gray-400" : "bg-[#62A0EA]"}`} />
              <span className="truncate">{statusLabel}</span>
            </span>
            {countdownLabel && !isConfirming && (
              <span className={`flex-shrink-0 text-xs ${isExpiringSoon ? "font-semibold text-red-400 light:text-red-600" : "text-white/45 light:text-gray-500"}`}>
                Expires <span className="tabular-nums">{countdownLabel}</span>
              </span>
            )}
          </div>

          <div className="space-y-3 p-5">
            {gcashError && (
              <p role="alert" className="border-l-2 border-red-500 pl-3 text-xs leading-relaxed text-red-300 light:text-red-700">
                {gcashError}
              </p>
            )}

            {/* Action buttons */}
            <div className="flex gap-3">
              <button
                onClick={handleCancelGcash}
                disabled={isCancellingGcash || isConfirming}
                className="flex-1 cursor-pointer rounded-xl bg-[#DC2626] py-3 text-sm font-semibold text-white transition-colors hover:bg-[#B91C1C] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[#DC2626] disabled:active:scale-100"
              >
                {isCancellingGcash ? "Cancelling…" : "Cancel Payment"}
              </button>
              <button
                onClick={() => { stopPolling(); setStep("select"); }}
                className="flex-1 cursor-pointer rounded-xl border border-white/10 light:border-gray-200 bg-[#131C2E] light:bg-white py-3 text-sm font-semibold text-white/80 light:text-gray-800 transition-colors hover:bg-[#1A2540] light:hover:bg-gray-100 active:scale-[0.98]"
              >
                Back
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── STEP: Scan Result (GCash only — after commuter scans) ────────
  // Commuter type is auto-detected from their e-chatco account.
  // Fare is now calculated based on the detected type.
  if (step === "scan_result" && gcashFareInfo) {
    return (
      <div className={`fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4 xl:items-end xl:justify-center xl:bg-transparent xl:backdrop-blur-none xl:bottom-24 ${backdropAnim}`} {...backdropDismiss}>
        <PopoverTail panelColor={panelTailColor} anchorOffsetPx={anchorOffset} className="light:border-gray-200" />
        <div className={`w-full sm:max-w-sm bg-[#071A2E] light:bg-white rounded-2xl border border-white/10 light:border-gray-200 shadow-2xl ${panelAnim}`} style={panelAnchorStyle}>
          <div className="p-6">
            <h2 className="text-lg font-bold text-white light:text-gray-900 mb-4">
              Fare Breakdown
            </h2>

            {/* Commuter info detected from scan */}
            <div className="bg-blue-500/10 light:bg-blue-50 border border-blue-500/20 light:border-blue-200 rounded-xl p-3 mb-4">
              <div className="flex items-center gap-2 mb-1">
                <svg className="w-4 h-4 text-blue-400 light:text-blue-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                </svg>
                <span className="text-xs font-semibold text-blue-400 light:text-blue-700">
                  Commuter Detected
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-white/70 light:text-gray-700">{scannedCommuterName}</span>
                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                  scannedCommuterType !== "REGULAR"
                    ? "bg-amber-500/15 light:bg-amber-50 text-amber-400 light:text-amber-700 border border-amber-500/25 light:border-amber-200"
                    : "bg-white/5 light:bg-gray-50 text-white/40 light:text-gray-500 border border-white/10 light:border-gray-200"
                }`}>
                  {getCommuterTypeLabel(scannedCommuterType)}
                </span>
              </div>
            </div>

            <div className="space-y-3 mb-6">
              <div className="flex justify-between text-sm">
                <span className="text-white/50 light:text-gray-500">Route</span>
                <span className="text-white light:text-gray-900">
                  {pickupPoint?.name}{pickupLandmark ? ` · ${pickupLandmark}` : ""} →{" "}
                  {dropoffPoint?.name}{dropoffLandmark ? ` · ${dropoffLandmark}` : ""}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/50 light:text-gray-500">Barangays Traveled</span>
                <span className="text-white light:text-gray-900">
                  {gcashFareInfo.barangaysTraveled}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/50 light:text-gray-500">Fare Basis</span>
                <span className="text-white/70 light:text-gray-700 text-xs">
                  {gcashFareInfo.succeedingCount > 0
                    ? `Base fare covers first ${gcashFareInfo.baseBarangayCount} + ${gcashFareInfo.succeedingCount} succeeding`
                    : "Base fare (within first 4 barangays)"}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/50 light:text-gray-500">Regular Fare</span>
                <span className={gcashFareInfo.hasDiscount ? "text-white/30 light:text-gray-400 line-through" : "text-white light:text-gray-900"}>
                  {formatCurrency(gcashFareInfo.regularFare)}
                </span>
              </div>
              {gcashFareInfo.hasDiscount && (
                <div className="flex justify-between text-sm">
                  <span className="text-white/50 light:text-gray-500">Discount ({getCommuterTypeLabel(scannedCommuterType)})</span>
                  <span className="text-green-400 light:text-green-700">
                    -{formatCurrency(gcashFareInfo.discountAmount)}
                  </span>
                </div>
              )}
              <div className="border-t border-white/10 light:border-gray-200 pt-3 flex justify-between">
                <span className="text-white light:text-gray-900 font-semibold">Total</span>
                <span className="text-xl font-extrabold text-white light:text-gray-900">
                  {formatCurrency(gcashFareInfo.finalFare)}
                </span>
              </div>
            </div>

            {/* GCash Payment Notice */}
            <div className="bg-[#1A5FB4]/10 light:bg-[#F0F7FF] border border-[#1A5FB4]/20 light:border-[#DAEEFF] rounded-xl p-3 mb-6">
              <div className="flex items-center gap-2 mb-1">
                <svg className="w-4 h-4 text-[#62A0EA] light:text-[#1A5FB4]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
                </svg>
                <span className="text-xs font-semibold text-[#62A0EA] light:text-[#1A5FB4]">
                  GCash Secure Payment
                </span>
              </div>
              <p className="text-[10px] text-white/40 light:text-gray-500">
                Fare will be charged to the commuter&apos;s GCash account. No wallet balance needed — pay directly.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep("qr_code")}
                className="flex-1 py-3 rounded-xl border border-white/10 light:border-gray-200 text-white/60 light:text-gray-600 text-sm font-semibold hover:bg-white/5 light:hover:bg-gray-100 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => setStep("confirm")}
                className="flex-1 py-3 rounded-xl text-white text-sm font-bold transition-colors shadow-lg bg-[#1A5FB4] hover:bg-[#164A8F] shadow-[#1A5FB4]/30"
              >
                Confirm Payment
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── STEP: Confirm Payment ──────────────────────────────────────

  if (step === "confirm") {
    // For GCash: the commuter type is NOT known yet (it's detected server-side
    // when the commuter claims the QR). So we show the REGULAR fare here —
    // if the commuter turns out to be discounted, the backend applies the
    // discount at claim time.
    // For Cash: the conductor selects the commuter type, so the discount is
    // applied immediately.
    // Voucher amounts are calculated by the backend from the entered code.
    const groupDiscount = ((fareInfo?.regularFare ?? 0) * groupPassengerCount) - groupTotalFare;
    const activeFareInfo = isGroupMode && fareInfo
      ? { ...fareInfo, finalFare: groupTotalFare, discountAmount: groupDiscount, hasDiscount: groupDiscount > 0 }
      : selectedMethod === "GCash" ? gcashFareInfo : fareInfo;
    const activeCommuterType = selectedMethod === "GCash" ? "REGULAR" : commuterType;

    if (!activeFareInfo) return null;

    return (
      <div className={`fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4 xl:items-end xl:justify-center xl:bg-transparent xl:backdrop-blur-none xl:bottom-24 ${backdropAnim}`} {...backdropDismiss}>
        <PopoverTail panelColor={panelTailColor} anchorOffsetPx={anchorOffset} className="light:border-gray-200" />
        <div className={`w-full sm:max-w-sm max-h-full overflow-y-auto modal-scroll bg-[#071A2E] light:bg-white rounded-2xl border border-white/10 light:border-gray-200 shadow-2xl ${panelAnim}`} style={panelAnchorStyle}>
          {/* Amount first: the method, the amount to collect, and the
              instruction as plain text instead of a tinted notice box. */}
          <div className="p-5">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/40 light:text-gray-500">
              Confirm Payment
            </h2>
            <div className="mt-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-white/60 light:text-gray-600">
                {selectedMethod === "GCash" ? (
                  <svg className="w-4 h-4 text-white/50 light:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 0 0 6 3.75v16.5a2.25 2.25 0 0 0 2.25 2.25h7.5A2.25 2.25 0 0 0 18 20.25V3.75a2.25 2.25 0 0 0-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 text-white/50 light:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z" />
                  </svg>
                )}
                {selectedMethod === "GCash" ? "Charge through GCash" : selectedMethod === "Voucher" ? "Apply voucher" : "Collect in cash"}
              </div>
              <p className={`mt-1.5 font-bold leading-tight tracking-tight tabular-nums text-white light:text-gray-900 ${selectedMethod === "Voucher" ? "text-xl" : "text-[40px]"}`}>
                {selectedMethod === "Voucher" ? "Calculated when applied" : formatCurrency(activeFareInfo.finalFare)}
              </p>
              <p className="mt-1 max-w-[34ch] text-[13px] leading-relaxed text-white/60 light:text-gray-600">
                {selectedMethod === "GCash"
                  ? "The commuter scans a QR and pays from their GCash account. No wallet balance needed."
                  : selectedMethod === "Voucher"
                    ? "Enter the commuter's voucher code below. Collect any remaining fare in cash."
                    : "Collect the exact amount from the commuter. It's added to your shift log when you confirm."}
              </p>
            </div>
          </div>

          {/* Details grouped by meaning, each with its supporting line. */}
          <dl className="border-t border-white/10 light:border-gray-200 px-5 py-1 divide-y divide-white/6 light:divide-gray-200">
            {pickupLandmark && (
              <div className="grid grid-cols-[84px_1fr] gap-3 py-3">
                <dt className="pt-px text-xs text-white/45 light:text-gray-500">Pickup</dt>
                <dd className="min-w-0 text-[13px] font-medium text-white light:text-gray-900">{pickupLandmark}</dd>
              </div>
            )}
            {dropoffLandmark && (
              <div className="grid grid-cols-[84px_1fr] gap-3 py-3">
                <dt className="pt-px text-xs text-white/45 light:text-gray-500">Drop-off</dt>
                <dd className="min-w-0 text-[13px] font-medium text-white light:text-gray-900">{dropoffLandmark}</dd>
              </div>
            )}
            <div className="grid grid-cols-[84px_1fr] gap-3 py-3">
              <dt className="pt-px text-xs text-white/45 light:text-gray-500">Distance</dt>
              <dd className="min-w-0 text-[13px] font-medium text-white light:text-gray-900">
                {activeFareInfo.barangaysTraveled} {activeFareInfo.barangaysTraveled === 1 ? "barangay" : "barangays"}
                <span className="mt-0.5 block text-[11px] font-normal leading-snug text-white/45 light:text-gray-500">
                  {activeFareInfo.succeedingCount > 0
                    ? `Base fare covers first ${activeFareInfo.baseBarangayCount} + ${activeFareInfo.succeedingCount} succeeding`
                    : "Base fare (within first 4 barangays)"}
                </span>
              </dd>
            </div>
            <div className="grid grid-cols-[84px_1fr] gap-3 py-3">
              <dt className="pt-px text-xs text-white/45 light:text-gray-500">Commuter</dt>
              <dd className="min-w-0 text-[13px] font-medium text-white light:text-gray-900">
                {isGroupMode ? (
                  <>
                    {groupPassengerCount} {groupPassengerCount === 1 ? "passenger" : "passengers"}
                    <span className="mt-0.5 block text-[11px] font-normal text-white/45 light:text-gray-500">{groupMix}</span>
                  </>
                ) : getCommuterTypeLabel(activeCommuterType)}
              </dd>
            </div>
            <div className="grid grid-cols-[84px_1fr] gap-3 py-3">
              <dt className="pt-px text-xs text-white/45 light:text-gray-500">Fare</dt>
              <dd className="min-w-0 text-[13px] font-medium tabular-nums text-white light:text-gray-900">
                {/* A group's discount covers the whole group, so pair it with the
                    group's full fare rather than one passenger's. */}
                {isGroupMode ? (
                  <>
                    {formatCurrency(activeFareInfo.regularFare * groupPassengerCount)} full fare
                    <span className="mt-0.5 block text-[11px] font-normal text-white/45 light:text-gray-500">
                      {groupPassengerCount} × {formatCurrency(activeFareInfo.regularFare)}
                    </span>
                  </>
                ) : (
                  <>{formatCurrency(activeFareInfo.regularFare)} regular</>
                )}
                {activeFareInfo.hasDiscount && activeFareInfo.discountAmount > 0 && (
                  <span className="mt-0.5 block text-[11px] font-normal text-white/45 light:text-gray-500">
                    − {formatCurrency(activeFareInfo.discountAmount)} {isGroupMode ? "" : `${getCommuterTypeLabel(activeCommuterType).toLowerCase()} `}discount
                  </span>
                )}
              </dd>
            </div>
          </dl>

          <div className="px-5 pt-2 pb-5">
            {/* Voucher Code Input — only for Voucher payment */}
            {selectedMethod === "Voucher" && (
              <div className="mb-6">
                <label className="block text-xs font-medium text-slate-300 light:text-gray-700 mb-1.5">
                  Voucher Code <span className="text-red-400 light:text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={voucherCode}
                  onChange={(e) => setVoucherCode(e.target.value.toUpperCase().trim())}
                  placeholder="e.g. REWARD-AB12CD34"
                  className="block w-full px-4 py-2.5 bg-[#0E1628] light:bg-white border border-[#1E2D45] light:border-gray-200 rounded-md text-white light:text-gray-900 text-sm font-mono placeholder-slate-500 light:placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-violet-400 transition-colors"
                />
                <p className="text-[10px] text-slate-500 light:text-gray-500 mt-1">
                  Enter the code shown by the commuter&apos;s app. Free-ride vouchers cover the fare; discount vouchers reduce it. Collect any remaining fare in cash.
                </p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setStep(isGroupMode ? "passengers" : "select")}
                disabled={isInitiatingGcash}
                className="flex-1 py-3 rounded-xl border border-white/10 light:border-gray-200 text-white/60 light:text-gray-600 text-sm font-semibold hover:bg-white/5 light:hover:bg-gray-100 transition-colors disabled:opacity-50"
              >
                Back
              </button>
              <button
                onClick={handleConfirmPayment}
                disabled={isInitiatingGcash || (selectedMethod === "Voucher" && !voucherCode.trim())}
                className="flex-[2] py-3 rounded-xl bg-[#1A5FB4] hover:bg-[#164A8F] text-white text-sm font-bold transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isInitiatingGcash
                  ? "Starting…"
                  : selectedMethod === "GCash"
                    ? `Generate QR · ${formatCurrency(activeFareInfo.finalFare)}`
                    : selectedMethod === "Voucher"
                      ? "Apply Voucher"
                      : `Pay ${formatCurrency(activeFareInfo.finalFare)}`}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── STEP: Processing ───────────────────────────────────────────

  if (step === "processing") {
    return (
      <div className={`fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 xl:items-end xl:justify-center xl:bg-transparent xl:backdrop-blur-none xl:bottom-24 ${backdropAnim}`} {...backdropDismiss}>
        <PopoverTail panelColor={panelTailColor} anchorOffsetPx={anchorOffset} className="light:border-gray-200" />
        <div className={`w-full max-w-xs bg-[#071A2E] light:bg-white rounded-2xl border border-white/10 light:border-gray-200 shadow-2xl p-8 text-center ${panelAnim}`} style={panelAnchorStyle}>
          <div className={`w-16 h-16 mx-auto mb-4 rounded-full border-4 border-t-transparent animate-spin ${
            selectedMethod === "GCash" ? "border-[#1A5FB4]" : "border-emerald-500"
          }`} />
          <h2 className="text-lg font-bold text-white light:text-gray-900 mb-2">
            Processing Payment
          </h2>
          <p className="text-sm text-white/40 light:text-gray-500">
            {selectedMethod === "GCash"
              ? "Charging fare via GCash..."
              : "Recording cash payment..."}
          </p>
        </div>
      </div>
    );
  }

  // ─── STEP: Success ──────────────────────────────────────────────

  if (step === "success") {
    const receiptTotalFare = (isGroupMode || selectedMethod === "Voucher") && receiptTransactions.length > 0
      ? receiptTransactions.reduce((sum, transaction) => sum + transaction.finalAmount, 0)
      : null;
    const receiptGrossFare = (isGroupMode || selectedMethod === "Voucher") && receiptTransactions.length > 0
      ? receiptTransactions.reduce(
          (sum, transaction) => sum + (transaction.grossAmount ?? transaction.baseFare ?? transaction.finalAmount),
          0
        )
      : null;
    const receiptDiscount = (isGroupMode || selectedMethod === "Voucher") && receiptTransactions.length > 0
      ? receiptTransactions.reduce((sum, transaction) => sum + (transaction.discountAmount ?? 0), 0)
      : null;
    const successPassengerCount = isGroupMode && receiptTransactions.length > 0
      ? receiptTransactions.length
      : finalGroupPassengerCount;
    const receiptCount = Math.max(receiptTransactions.length, 1);
    const activeFareInfo = (isGroupMode || selectedMethod === "Voucher") && fareInfo
      ? {
          ...fareInfo,
          finalFare: receiptTotalFare ?? groupTotalFare,
          discountAmount: receiptDiscount ?? fareInfo.discountAmount,
          hasDiscount: (receiptDiscount ?? 0) > 0,
        }
      : selectedMethod === "GCash" ? gcashFareInfo : fareInfo;
    if (!activeFareInfo) return null;

    return (
      <div className={`fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4 xl:items-end xl:justify-center xl:bg-transparent xl:backdrop-blur-none xl:bottom-24 ${backdropAnim}`} {...backdropDismiss}>
        <PopoverTail panelColor={panelTailColor} anchorOffsetPx={anchorOffset} className="light:border-gray-200" />
        <div className={`w-full sm:max-w-sm max-h-[92vh] overflow-y-auto bg-[#071A2E] light:bg-white rounded-2xl border border-white/10 light:border-gray-200 shadow-2xl modal-scroll ${panelAnim}`} style={panelAnchorStyle}>
          <div className="p-6 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/10 light:bg-green-50 border border-green-500/20 light:border-green-200 flex items-center justify-center">
              <svg className="w-8 h-8 text-green-400 light:text-green-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-white light:text-gray-900 mb-1">
              Payment Successful!
            </h2>
            <p className="text-sm text-white/40 light:text-gray-500 mb-4">
              {selectedMethod === "GCash"
                ? "Fare has been charged via GCash"
                : selectedMethod === "Voucher"
                  ? (activeFareInfo.finalFare > 0 ? "Voucher applied. Collect the remaining fare in cash." : "Voucher covered this ride in full.")
                  : "Cash payment has been recorded"}
            </p>

            <div className="bg-white/5 light:bg-gray-50 rounded-xl p-4 text-left space-y-2 mb-6">
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Amount Paid</span>
                <span className="text-white light:text-gray-900 font-bold">
                  {formatCurrency(activeFareInfo.finalFare)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Route</span>
                <span className="text-white/70 light:text-gray-700">
                  {pickupPoint?.name}{pickupLandmark ? ` · ${pickupLandmark}` : ""} →{" "}
                  {dropoffPoint?.name}{dropoffLandmark ? ` · ${dropoffLandmark}` : ""}
                </span>
              </div>
              {pickupLandmark && (
                <div className="flex justify-between text-sm">
                  <span className="text-white/40 light:text-gray-500">Pickup Landmark</span>
                  <span className={pickupLabelClass}>{pickupLandmark}</span>
                </div>
              )}
              {dropoffLandmark && (
                <div className="flex justify-between text-sm">
                  <span className="text-white/40 light:text-gray-500">Drop-off Landmark</span>
                  <span className={dropoffLabelClass}>{dropoffLandmark}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Barangays</span>
                <span className="text-white/70 light:text-gray-700">
                  {activeFareInfo.barangaysTraveled} traveled
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Commuter Type</span>
                <span className="text-white/70 light:text-gray-700">
                  {getCommuterTypeLabel(selectedMethod === "GCash" ? scannedCommuterType : commuterType)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/40 light:text-gray-500">Method</span>
                <span className={selectedMethod === "GCash" ? "text-[#62A0EA] light:text-[#1A5FB4]" : "text-emerald-400 light:text-emerald-700"}>
                  {selectedMethod}
                </span>
              </div>
              {gcashInitiation && selectedMethod === "GCash" && (
                <div className="flex justify-between text-sm">
                  <span className="text-white/40 light:text-gray-500">Ref ID</span>
                  <span className="text-white/50 light:text-gray-500 text-xs font-mono">
                    {gcashInitiation.transactionId}
                  </span>
                </div>
              )}
              {gcashInitiation && selectedMethod === "GCash" && !gcashInitiation.checkoutUrl && (
                <div className="flex justify-between text-sm">
                  <span className="text-white/40 light:text-gray-500">Mode</span>
                  <span className="text-amber-400/60 light:text-amber-700 text-xs font-medium">
                    Simulated (Dev)
                  </span>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowReceiptDetails((open) => !open)}
              className="mb-3 flex w-full items-center justify-between rounded-xl border border-white/10 light:border-gray-200 bg-white/5 light:bg-gray-50 px-4 py-3 text-left transition-colors hover:bg-white/10 light:hover:bg-gray-100"
            >
              <span>
                <span className="block text-sm font-bold text-white light:text-gray-900">Receipt Details</span>
                <span className="text-[10px] text-white/35 light:text-gray-400">
                  {showReceiptDetails
                    ? `${receiptCount} receipt${receiptCount !== 1 ? "s" : ""} shown`
                    : `Tap to view ${receiptCount} receipt${receiptCount !== 1 ? "s" : ""}`}
                </span>
              </span>
              <svg
                className={`h-4 w-4 text-white/45 light:text-gray-500 transition-transform ${showReceiptDetails ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>

            <button
              type="button"
              onClick={() => window.print()}
              className="mb-3 w-full rounded-xl border border-white/15 light:border-gray-300 bg-white/10 light:bg-gray-100 py-3 text-sm font-bold text-white light:text-gray-900 transition-colors hover:bg-white/15"
            >
              Print {isGroupMode ? "All Receipts" : "Receipt"}
            </button>

            <button
              onClick={handleClose}
              className={`w-full py-3 rounded-xl text-white text-sm font-bold transition-colors ${
                selectedMethod === "GCash"
                  ? "bg-[#1A5FB4] hover:bg-[#164A8F]"
                  : "bg-emerald-600 hover:bg-emerald-700"
              }`}
            >
              Done
            </button>

            <div className={`${showReceiptDetails ? "mt-4 block" : "hidden print:block"} ${isGroupMode ? "max-h-[48vh] space-y-4 overflow-y-auto rounded-xl pr-1" : ""}`}>
              {(receiptTransactions.length > 0 ? receiptTransactions : [null]).map((transaction, index) => (
                <div key={transaction?.transactionId ?? "single"} className={isGroupMode ? "rounded-xl border border-white/15 light:border-gray-300 bg-white/5 light:bg-gray-50 p-2" : ""}>
                  {isGroupMode && (
                    <p className="mb-2 text-left text-[10px] font-bold uppercase tracking-wider text-white/40 light:text-gray-500">
                      Passenger receipt {index + 1} of {receiptTransactions.length}
                    </p>
                  )}
                  <TransactionReceipt
                    settings={receiptSettings}
                    transactionId={transaction?.transactionId ?? receiptTransaction?.transactionId ?? gcashInitiation?.transactionId}
                    timestamp={transaction?.timestamp ?? receiptTransaction?.timestamp}
                    unitNumber={unitNumber || "—"}
                    conductorName={conductorName || "—"}
                    passengerType={transaction?.passengerRole
                      ? getCommuterTypeLabel(transaction.passengerRole as CommuterType)
                      : getCommuterTypeLabel(selectedMethod === "GCash" ? scannedCommuterType : commuterType)}
                    passengerName={selectedMethod === "Cash" ? "Passenger" : transaction?.passengerName}
                    payerName={transaction?.payerName}
                    groupPosition={transaction?.groupPosition}
                    multiplePaymentReference={transaction?.multiplePaymentReference ?? gcashInitiation?.multiplePaymentReference}
                    driverName={transaction?.driverName ?? driverName}
                    totalPassengers={transaction?.totalPassengers ?? (isGroupMode ? successPassengerCount : 1)}
                    grossFare={transaction?.grossAmount ?? (isGroupMode ? receiptGrossFare ?? activeFareInfo.regularFare * successPassengerCount : activeFareInfo.regularFare)}
                    passengerBreakdown={transaction?.passengerBreakdown}
                    from={transaction?.from || pickupPoint?.name || "—"}
                    to={transaction?.to || dropoffPoint?.name || "—"}
                    baseFare={transaction?.baseFare ?? activeFareInfo.regularFare}
                    discountAmount={transaction?.discountAmount ?? activeFareInfo.discountAmount}
                    finalFare={transaction?.finalAmount ?? activeFareInfo.finalFare}
                    paymentMethod={selectedMethod === "Voucher" ? transaction?.paymentMethod ?? "Voucher" : selectedMethod ?? "—"}
                    receiptQrToken={selectedMethod === "Cash" ? transaction?.receiptQrToken ?? cashReceiptToken : null}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── STEP: Failed ───────────────────────────────────────────────

  if (step === "failed") {
    return (
      <div className={`fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4 xl:items-end xl:justify-center xl:bg-transparent xl:backdrop-blur-none xl:bottom-24 ${backdropAnim}`} {...backdropDismiss}>
        <PopoverTail panelColor={panelTailColor} anchorOffsetPx={anchorOffset} className="light:border-gray-200" />
        <div className={`w-full sm:max-w-sm bg-[#071A2E] light:bg-white rounded-2xl border border-white/10 light:border-gray-200 shadow-2xl ${panelAnim}`} style={panelAnchorStyle}>
          <div className="p-6">
            <div className="w-11 h-11 mb-5 rounded-xl bg-[#2B1116] light:bg-red-50 border border-[#5C1F27] light:border-red-200 flex items-center justify-center">
              <svg className="w-5 h-5 text-red-400 light:text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-white light:text-gray-900 mb-1">
              Payment not completed
            </h2>
            <p className="text-sm leading-relaxed text-white/60 light:text-gray-600 mb-6">
              {gcashError
                ? gcashError
                : selectedMethod === "GCash"
                  ? "Could not process the GCash payment. Please try again or pay cash to the conductor."
                  : "Could not record the payment. Please try again."}
            </p>
            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="flex-1 py-3 rounded-xl border border-[#1C3350] light:border-gray-200 bg-[#0B1E33] light:bg-white text-white/80 light:text-gray-800 text-sm font-semibold hover:bg-[#10273F] light:hover:bg-gray-100 active:scale-[0.98] transition-colors"
              >
                Close
              </button>
              <button
                onClick={() => setStep(isGroupMode ? "passengers" : "confirm")}
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
