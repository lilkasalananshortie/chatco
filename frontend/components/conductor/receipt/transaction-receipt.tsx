import { QRCodeSVG } from "qrcode.react";
import type { CSSProperties } from "react";
import type { ReceiptSettings } from "@/lib/conductor/services/receipt-settings.service";
import type { PassengerBreakdown } from "@/lib/conductor/persistence/transactions.store";

interface TransactionReceiptProps {
  settings: ReceiptSettings;
  transactionId?: string;
  timestamp?: number;
  unitNumber: string;
  conductorName: string;
  passengerType: string;
  passengerName?: string | null;
  from: string;
  to: string;
  baseFare: number;
  discountAmount: number;
  finalFare: number;
  paymentMethod: string;
  receiptQrToken?: string | null;
  payerName?: string | null;
  groupPosition?: number | null;
  multiplePaymentReference?: string | null;
  driverName?: string;
  totalPassengers?: number;
  grossFare?: number;
  passengerBreakdown?: PassengerBreakdown[];
}

function money(value: number): string {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
  }).format(value);
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-black/60">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

export default function TransactionReceipt({
  settings,
  transactionId,
  timestamp,
  unitNumber,
  conductorName,
  passengerType,
  passengerName,
  from,
  to,
  baseFare,
  discountAmount,
  finalFare,
  paymentMethod,
  receiptQrToken,
  payerName,
  groupPosition,
  multiplePaymentReference,
  driverName,
  totalPassengers = 1,
  grossFare,
  passengerBreakdown = [],
}: TransactionReceiptProps) {
  const width = settings.paperWidth === "80" ? 300 : 230;
  const claimInstruction = settings.showQrCode && settings.showManualCode
    ? "Scan or enter code in Rewards: +1 ride."
    : settings.showQrCode ? "Scan in Rewards: +1 ride." : "Enter code in Rewards: +1 ride.";

  return (
    <section
      aria-label="Fare receipt"
      className="thermal-receipt mx-auto bg-white px-3 py-4 font-mono text-[11px] leading-snug text-black shadow-lg"
      style={{
        width,
        maxWidth: "100%",
        "--receipt-paper-width": `${settings.paperWidth}mm`,
      } as CSSProperties}
    >
      <header className="text-center">
        <p className="text-[13px] font-bold tracking-wide">
          {settings.businessName || "CHATCO"}
        </p>
        {settings.addressLine && <p className="mt-0.5 text-[10px]">{settings.addressLine}</p>}
        <p className="mt-0.5 text-[10px]">FARE RECEIPT</p>
      </header>

      <div className="my-1.5 border-t border-dashed border-black/40" />
      {settings.showDateTime && timestamp && (
        <Row label="Date" value={new Date(timestamp).toLocaleString("en-PH")} />
      )}
      {settings.showTransactionId && transactionId && (
        <Row label="Ref" value={transactionId} />
      )}
      {multiplePaymentReference && <Row label="Group ref" value={multiplePaymentReference} />}
      {settings.showUnit && <Row label="Unit" value={unitNumber} />}
      {settings.showConductor && <Row label="Conductor" value={conductorName} />}
      {driverName && <Row label="Driver" value={driverName} />}
      {settings.showPassenger && (
        <div className="flex justify-between gap-3">
          <span className="text-black/60">Commuter</span>
          <div className="text-right">
            <p>{groupPosition && groupPosition > 1 ? "Passenger" : passengerName || payerName || "Passenger"}</p>
            <p className="text-[10px] text-black/60">{passengerType}</p>
            {groupPosition && groupPosition > 1 && payerName && (
              <p className="text-[10px]">Paid by: {payerName}</p>
            )}
          </div>
        </div>
      )}

      {settings.showRoute && (
        <>
          <div className="my-1.5 border-t border-dashed border-black/40" />
          <Row label="From" value={from} />
          <Row label="To" value={to} />
        </>
      )}

      {settings.showFareBreakdown && (
        <>
          <div className="my-1.5 border-t border-dashed border-black/40" />
          {passengerBreakdown.length > 0 ? passengerBreakdown.filter((line) => line.quantity > 0).map((line) => (
            <Row
              key={line.passengerType}
              label={`${line.passengerType === "SENIOR" || line.passengerType === "SENIOR_CITIZEN" ? "Senior Citizen" : line.passengerType.charAt(0) + line.passengerType.slice(1).toLowerCase()} × ${line.quantity}`}
              value={money(line.subtotal)}
            />
          )) : <Row label="Base fare" value={money(baseFare)} />}
          <Row label="Passengers" value={String(totalPassengers)} />
          {grossFare != null && <Row label="Gross fare" value={money(grossFare)} />}
          {discountAmount > 0 && <Row label="Discount" value={`-${money(discountAmount)}`} />}
        </>
      )}

      <div className="my-1.5 border-t border-dashed border-black/40" />
      <div className="flex justify-between text-[13px] font-bold">
        <span>TOTAL</span>
        <span>{money(finalFare)}</span>
      </div>
      <Row label="Paid via" value={paymentMethod} />

      {receiptQrToken && (settings.showQrCode || settings.showManualCode) && (
        <>
          <div className="my-1.5 border-t border-dashed border-black/40" />
          {settings.showQrCode && (
            <div className="mx-auto w-fit bg-white p-1">
              <QRCodeSVG value={receiptQrToken} size={112} level="M" />
            </div>
          )}
          <div className="mt-1 text-center text-[9px]">
            {settings.showManualCode && (
              <>
                <p className="text-black/60">Receipt code</p>
                <p className="break-all font-bold">{receiptQrToken}</p>
              </>
            )}
            <p className="mt-1">{claimInstruction}</p>
          </div>
        </>
      )}

      <div className="my-1.5 border-t border-dashed border-black/40" />
      {settings.footerNote && <p className="text-center text-[10px]">{settings.footerNote}</p>}
      <p className="mt-2 text-center text-[10px]">
        Visit Chatco at{' '}
        <a href="https://chatco.online" target="_blank" rel="noopener noreferrer" className="font-bold underline">chatco.online</a>
      </p>
    </section>
  );
}
