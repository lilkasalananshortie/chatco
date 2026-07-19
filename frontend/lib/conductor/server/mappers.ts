// Shape mappers -- translate Laravel Eloquent model JSON (snake_case, relations
// nested) into the frontend's conductor types (camelCase, flat).
// Used by the Next.js conductor API routes which act as server-side proxies.

// ─── Laravel model shapes (as returned by the API) ───────────────────

interface LaravelRoute {
  id: string;
  name: string;
}

interface LaravelVehicle {
  id: string;
  unit_number: string;
  plate_number: string;
  vehicle_type: string | null;
  route_id: string | null;
  status: string;
  capacity_status: string | null;
  route?: LaravelRoute | null;
}

interface LaravelDriver {
  id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  status: string;
}

interface LaravelHailCommuter {
  // The User model has no `name` column (name lives in commuterProfile and is
  // only exposed via getDisplayName()). It is mapped here defensively so that
  // if the backend later eager-loads the profile or appends a display name,
  // this picks it up without a frontend change.
  name?: string | null;
  email?: string | null;
}

interface LaravelHail {
  id: string;
  // decimal:7 / decimal:2 casts serialize as STRINGS — must be coerced to
  // numbers before Leaflet / distance math can use them.
  commuter_lat: string | number;
  commuter_lng: string | number;
  commuter?: LaravelHailCommuter | null;
}

interface LaravelShiftLog {
  shift_id: string;
  conductor_id: string;
  driver_id: string;
  vehicle_id: string;
  route_id: string | null;
  conductor_name: string;
  driver_name: string;
  unit_number: string;
  plate_number: string;
  time_in: string;
  time_out: string | null;
  status: string;
  route?: LaravelRoute | null;
  vehicle?: LaravelVehicle | null;
  driver?: LaravelDriver | null;
}

/**
 * Laravel Transaction model shape (as returned by /api/v1/conductor/transactions).
 *
 * S4-T1 added: status, paymongo_intent_id, paymongo_checkout_url, qr_token,
 * paid_at. payment_method collapsed to CASH | GCASH (old GCash_Scanned /
 * GCash_Direct / Voucher values are gone).
 *
 * decimal:2 casts serialize as STRINGS — must be coerced to numbers.
 */
interface LaravelTransaction {
  transaction_id: string;
  shift_id: string;
  payment_method: string; // "CASH" | "GCASH"
  final_amount: string | number;
  passenger_id: string | null;
  passenger_name: string | null;
  passenger_role: string | null;
  pickup_stop_id: string | null;
  dropoff_stop_id: string | null;
  pickup_name: string | null;
  dropoff_name: string | null;
  distance: string | number | null;
  base_fare: string | number | null;
  succeeding_km: string | number | null;
  discount_amount: string | number | null;
  conductor_name: string | null;
  unit_number: string | null;
  driver_name: string | null;
  voucher_id: string | null;
  status: string; // "PENDING" | "PAID" | "FAILED"
  paymongo_intent_id: string | null;
  paymongo_checkout_url: string | null;
  qr_token: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Frontend types ──────────────────────────────────────────────────

import type {
  ConductorUnit,
  ConductorDriver,
  ConductorHailRequest,
} from "@/lib/conductor/types";
import type { ConductorShift } from "@/lib/conductor/persistence/shift.store";
import type { Transaction } from "@/lib/conductor/persistence/transactions.store";
import type { RemittanceRecord } from "@/lib/conductor/persistence/remittance.store";
import type { PaymentMethodType } from "@/types";

// ─── Mappers ─────────────────────────────────────────────────────────

export function mapVehicle(v: unknown): ConductorUnit {
  const vehicle = v as LaravelVehicle;
  return {
    id: vehicle.id,
    unitNumber: vehicle.unit_number,
    plateNumber: vehicle.plate_number,
    route: vehicle.route?.name ?? "—",
    routeId: vehicle.route_id ?? undefined,
    status: "available",
  };
}

export function mapDriver(d: unknown): ConductorDriver {
  const driver = d as LaravelDriver;
  const name = [driver.first_name, driver.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  return {
    id: driver.id,
    name: name || "Unknown Driver",
    status: "available",
  };
}

export function mapShiftLog(s: unknown): ConductorShift {
  const shift = s as LaravelShiftLog;
  return {
    shiftId: shift.shift_id,
    conductorName: shift.conductor_name,
    unitNumber: shift.unit_number,
    route: shift.route?.name ?? "",
    driverName: shift.driver_name,
    timeIn: shift.time_in,
    timeOut: shift.time_out,
    isActive: shift.status === "ACTIVE",
  };
}

/**
 * Map a Laravel Remittance model (snake_case, decimals-as-strings) to the
 * frontend's RemittanceRecord shape (camelCase). The conductor's
 * remittance-history list (GET /conductor/remittances) returns these rows
 * inside a paginator — the route unwraps the paginator, this maps each row.
 *
 * remittance_status: the backend writes 'COMPLETE' (no shortage) or
 * 'SHORTAGE'; both mean the shift WAS remitted, so they map to "Remitted".
 * Anything else (e.g. 'PENDING') maps to "Pending".
 *
 * time_in/time_out live on the related shift_log, not the remittance row.
 */
export function mapRemittance(r: unknown): RemittanceRecord {
  const row = r as Record<string, unknown>;
  const shift = (row.shift ?? null) as Record<string, unknown> | null;
  const num = (v: unknown) => Number(v) || 0;
  const status = String(row.remittance_status ?? "");

  return {
    shiftId: String(row.shift_id ?? ""),
    date: String(row.date ?? ""),
    conductorName: String(row.conductor_name ?? "—"),
    driverName: String(row.driver_name ?? "—"),
    unitNumber: String(row.unit_number ?? "—"),
    totalPassengers: num(row.total_passengers),
    cashlessBreakdown: {
      gcashScanned: num(row.gcash_scanned_total),
      gcashDirect: num(row.gcash_direct_total),
      voucher: num(row.voucher_total),
    },
    totalCashless: num(row.total_cashless),
    cashDeclared: num(row.cash_declared),
    cashTotal: num(row.cash_total),
    gcashTotal: num(row.gcash_total),
    remittanceStatus:
      status === "COMPLETE" || status === "SHORTAGE" || status === "Remitted"
        ? "Remitted"
        : "Pending",
    timeIn: String(shift?.time_in ?? ""),
    timeOut: String(shift?.time_out ?? ""),
  };
}

export function mapConductorHail(h: unknown): ConductorHailRequest {
  const hail = h as LaravelHail;
  return {
    id: hail.id,
    // No display name is serialized by the backend yet, so fall back to a
    // generic label rather than rendering "undefined" in the map popup.
    commuterName: hail.commuter?.name ?? "Commuter",
    latitude: Number(hail.commuter_lat),
    longitude: Number(hail.commuter_lng),
  };
}

/**
 * Map an array of Laravel models. Returns [] for null/undefined input.
 */
export function mapArray<T>(items: unknown, mapFn: (item: unknown) => T): T[] {
  if (!Array.isArray(items)) return [];
  return items.map(mapFn);
}

// ─── Transaction Mapper (S4-T8) ──────────────────────────────────────

/**
 * Map Laravel's uppercase payment_method to the frontend's PaymentMethodType.
 *
 * Backend (S4-T1): payment_method collapsed to "CASH" | "GCASH" (old
 * GCash_Scanned / GCash_Direct / Voucher values are gone).
 *
 * Frontend: the existing dashboard / end-of-day summary logic checks for
 * "Cash", "GCash_Scanned", "GCash_Direct", "Voucher". To keep that logic
 * unchanged (per S4-T8 spec: "The Transaction shape consumed by the
 * dashboard / end-of-day is unchanged"), we map:
 *   CASH  -> "Cash"
 *   GCASH -> "GCash_Scanned"  (the Scanned/Direct distinction is no
 *                              longer relevant — all GCash is the same
 *                              binding-QR flow)
 */
function mapPaymentMethod(method: string): PaymentMethodType {
  switch (method) {
    case "CASH":
      return "Cash";
    case "GCASH":
      return "GCash_Scanned";
    default:
      // Unknown methods default to Cash (safe fallback — cash is the
      // most common payment method and won't break the summary).
      return "Cash";
  }
}

/**
 * Map a Laravel Transaction model to the frontend's Transaction shape.
 *
 * Converts snake_case → camelCase, coerces decimal strings to numbers,
 * maps payment_method values, and maps pickup_name/dropoff_name → from/to.
 * The `timestamp` field is derived from `created_at` (epoch millis).
 *
 * The output shape matches `Transaction` from transactions.store.ts so
 * the dashboard / end-of-day / remittance logic needs no changes.
 */
export function mapTransaction(t: unknown): Transaction {
  const txn = t as LaravelTransaction;

  return {
    transactionId: txn.transaction_id,
    paymentMethod: mapPaymentMethod(txn.payment_method),
    finalAmount: Number(txn.final_amount) || 0,
    passengerName: txn.passenger_name ?? "",
    passengerId: txn.passenger_id ?? "",
    passengerRole: txn.passenger_role ?? undefined,
    from: txn.pickup_name ?? "",
    to: txn.dropoff_name ?? "",
    distance: Number(txn.distance) || 0,
    baseFare: Number(txn.base_fare) || 0,
    succeedingKm: Number(txn.succeeding_km) || 0,
    discountAmount: txn.discount_amount != null ? Number(txn.discount_amount) || 0 : undefined,
    conductorName: txn.conductor_name ?? undefined,
    unitNumber: txn.unit_number ?? undefined,
    driverName: txn.driver_name ?? undefined,
    // created_at is an ISO 8601 string; timestamp is epoch millis
    timestamp: new Date(txn.created_at).getTime(),
  };
}
