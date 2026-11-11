// app/(admin)/settings/receipt/page.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Save, AlertCircle, Printer, Check } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { defaultReceiptConfig, type ReceiptConfig } from '@/app/(admin)/settings/data/settings-data';
import { getSettings, updateSetting } from '@/lib/admin/services/setting.service';

// Setting keys persisted under category "receipt". These drive the fare
// receipt that is auto-printed on the conductor's thermal printer after a
// successful cash/GCash transaction.
const KEYS = {
  businessName: 'receipt_business_name',
  addressLine: 'receipt_address_line',
  footerNote: 'receipt_footer_note',
  paperWidth: 'receipt_paper_width',
  autoPrint: 'receipt_auto_print',
  showDateTime: 'receipt_show_datetime',
  showTransactionId: 'receipt_show_transaction_id',
  showRoute: 'receipt_show_route',
  showUnit: 'receipt_show_unit',
  showConductor: 'receipt_show_conductor',
  showPassenger: 'receipt_show_passenger',
  showFareBreakdown: 'receipt_show_fare_breakdown',
  showQrCode: 'receipt_show_qr_code',
  showManualCode: 'receipt_show_manual_code',
} as const;

const bool = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v === 'true');

// The toggle rows, so the form + preview stay in sync from one source.
const DETAIL_TOGGLES: { key: keyof ReceiptConfig; label: string; hint: string }[] = [
  { key: 'showDateTime', label: 'Date & time', hint: 'When the ride was paid.' },
  { key: 'showTransactionId', label: 'Transaction / reference no.', hint: 'Unique ID for disputes and lookups.' },
  { key: 'showRoute', label: 'Route (From → To)', hint: 'Pickup and drop-off stops.' },
  { key: 'showUnit', label: 'Unit / plate number', hint: 'Which vehicle issued the receipt.' },
  { key: 'showConductor', label: 'Conductor name', hint: 'Who collected the fare.' },
  { key: 'showPassenger', label: 'Passenger name & type', hint: 'Regular / Student / Senior / PWD.' },
  { key: 'showFareBreakdown', label: 'Fare breakdown', hint: 'Base fare, distance and discount lines.' },
  { key: 'showQrCode', label: 'Reward QR', hint: 'Scan in Rewards to claim +1 ride.' },
  { key: 'showManualCode', label: 'Manual claim code', hint: 'Enter in Rewards to claim +1 ride.' },
];

export default function ReceiptSettingsPage() {
  const [config, setConfig] = useState<ReceiptConfig>({ ...defaultReceiptConfig });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'settings' | 'preview'>('settings');

  const fetchSettings = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const d = await getSettings('receipt');
      setConfig({
        businessName: d[KEYS.businessName] ?? defaultReceiptConfig.businessName,
        addressLine: d[KEYS.addressLine] ?? defaultReceiptConfig.addressLine,
        footerNote: d[KEYS.footerNote] ?? defaultReceiptConfig.footerNote,
        paperWidth: (d[KEYS.paperWidth] as ReceiptConfig['paperWidth']) ?? defaultReceiptConfig.paperWidth,
        autoPrint: bool(d[KEYS.autoPrint], defaultReceiptConfig.autoPrint),
        showDateTime: bool(d[KEYS.showDateTime], defaultReceiptConfig.showDateTime),
        showTransactionId: bool(d[KEYS.showTransactionId], defaultReceiptConfig.showTransactionId),
        showRoute: bool(d[KEYS.showRoute], defaultReceiptConfig.showRoute),
        showUnit: bool(d[KEYS.showUnit], defaultReceiptConfig.showUnit),
        showConductor: bool(d[KEYS.showConductor], defaultReceiptConfig.showConductor),
        showPassenger: bool(d[KEYS.showPassenger], defaultReceiptConfig.showPassenger),
        showFareBreakdown: bool(d[KEYS.showFareBreakdown], defaultReceiptConfig.showFareBreakdown),
        showQrCode: bool(d[KEYS.showQrCode], defaultReceiptConfig.showQrCode),
        showManualCode: bool(d[KEYS.showManualCode], defaultReceiptConfig.showManualCode),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load receipt settings');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const set = <K extends keyof ReceiptConfig>(field: K, value: ReceiptConfig[K]) => {
    setConfig(prev => ({ ...prev, [field]: value }));
    setIsSaved(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    try {
      await Promise.all([
        updateSetting(KEYS.businessName, config.businessName, 'receipt'),
        updateSetting(KEYS.addressLine, config.addressLine, 'receipt'),
        updateSetting(KEYS.footerNote, config.footerNote, 'receipt'),
        updateSetting(KEYS.paperWidth, config.paperWidth, 'receipt'),
        updateSetting(KEYS.autoPrint, String(config.autoPrint), 'receipt'),
        updateSetting(KEYS.showDateTime, String(config.showDateTime), 'receipt'),
        updateSetting(KEYS.showTransactionId, String(config.showTransactionId), 'receipt'),
        updateSetting(KEYS.showRoute, String(config.showRoute), 'receipt'),
        updateSetting(KEYS.showUnit, String(config.showUnit), 'receipt'),
        updateSetting(KEYS.showConductor, String(config.showConductor), 'receipt'),
        updateSetting(KEYS.showPassenger, String(config.showPassenger), 'receipt'),
        updateSetting(KEYS.showFareBreakdown, String(config.showFareBreakdown), 'receipt'),
        updateSetting(KEYS.showQrCode, String(config.showQrCode), 'receipt'),
        updateSetting(KEYS.showManualCode, String(config.showManualCode), 'receipt'),
      ]);
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save receipt settings');
    } finally {
      setIsSaving(false);
    }
  };

  const inputClasses = 'block h-11 w-full rounded-lg border border-[#23344F] admin-light:border-[#CBD5E1] bg-[#0E1628] admin-light:bg-[#F8FAFC] px-3 text-base text-white admin-light:text-slate-900 placeholder-slate-500 admin-light:placeholder-slate-400 outline-none transition-colors focus:border-[#62A0EA] admin-light:focus:border-[#1A5FB4] focus:ring-2 focus:ring-[#62A0EA]/20 admin-light:focus:ring-[#1A5FB4]/20 @sm:text-sm';
  const labelClasses = 'mb-2 block text-sm font-medium text-slate-300 admin-light:text-slate-700';
  const sectionClasses = 'min-w-0 rounded-xl border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#111A2B] admin-light:bg-white p-4 @sm:p-5';

  if (isLoading) {
    return (
      <div className="p-4 sm:p-6" role="status" aria-label="Loading receipt settings">
        <div className="mx-auto w-full max-w-5xl animate-pulse space-y-4">
          <div className="h-7 w-48 rounded bg-[#1E2D45] admin-light:bg-slate-200" />
          <div className="h-60 rounded-xl border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#111A2B] admin-light:bg-white" />
          <div className="h-40 rounded-xl border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#111A2B] admin-light:bg-white" />
        </div>
      </div>
    );
  }

  return (
    <div className="@container min-w-0 px-4 sm:px-6">
      <div className="mx-auto w-full max-w-5xl space-y-5 pt-5">
        <div className="flex items-start gap-3">
          <Printer size={32} className="shrink-0 text-[#62A0EA] admin-light:text-[#1A5FB4]" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-white admin-light:text-slate-900">Receipt settings</h1>
            <p className="mt-1 text-sm leading-relaxed text-slate-400 admin-light:text-slate-500">Customize the receipt passengers receive after a payment.</p>
          </div>
        </div>

        {error && (
          <div role="alert" className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2">
            <AlertCircle size={16} className="text-red-400 admin-light:text-red-600 flex-shrink-0" />
            <p className="text-sm text-red-400 admin-light:text-red-600">{error}</p>
          </div>
        )}

        <div role="group" aria-label="Receipt settings view" className="flex rounded-lg border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-[#F8FAFC] p-1 @[48rem]:hidden">
          {(['settings', 'preview'] as const).map((view) => (
            <button key={view} type="button" aria-pressed={activeView === view} aria-controls={`receipt-${view}-panel`} onClick={() => setActiveView(view)} className={`min-h-11 flex-1 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]/50 admin-light:focus-visible:ring-[#1A5FB4]/50 ${activeView === view ? 'bg-[#62A0EA]/15 admin-light:bg-[#1A5FB4]/10 text-[#8CB9F0] admin-light:text-[#1A5FB4]' : 'text-slate-400 admin-light:text-slate-500 hover:text-white admin-light:hover:text-slate-900'}`}>
              {view === 'settings' ? 'Settings' : 'Preview'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSave} className="grid grid-cols-1 gap-5 items-start @[48rem]:grid-cols-[minmax(0,1fr)_20rem]">
          {/* ── Settings column ── */}
          <div id="receipt-settings-panel" className={`min-w-0 space-y-4 @[48rem]:block ${activeView === 'settings' ? 'block' : 'hidden'}`}>
            {/* Branding */}
            <section className={`${sectionClasses} space-y-4`} aria-labelledby="receipt-branding-title">
              <div>
                <h2 id="receipt-branding-title" className="text-sm font-semibold text-white admin-light:text-slate-900">Receipt header & footer</h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">Add your business details and a message for passengers.</p>
              </div>
              <div>
                <label htmlFor="receipt-business-name" className={labelClasses}>Business name</label>
                <input id="receipt-business-name" type="text" value={config.businessName} onChange={(e) => set('businessName', e.target.value)} placeholder="CHATCO" className={inputClasses} />
              </div>
              <div>
                <label htmlFor="receipt-address" className={labelClasses}>Address or contact <span className="text-xs text-slate-500 font-normal">(optional)</span></label>
                <input id="receipt-address" type="text" value={config.addressLine} onChange={(e) => set('addressLine', e.target.value)} placeholder="e.g. Malolos, Bulacan · 0917 000 0000" className={inputClasses} />
              </div>
              <div>
                <label htmlFor="receipt-footer" className={labelClasses}>Footer message</label>
                <input id="receipt-footer" type="text" value={config.footerNote} onChange={(e) => set('footerNote', e.target.value)} placeholder="Thank you for riding with Chatco!" className={inputClasses} />
              </div>
            </section>

            {/* Printer */}
            <section className={`${sectionClasses} space-y-4`} aria-labelledby="receipt-printer-title">
              <h2 id="receipt-printer-title" className="text-sm font-semibold text-white admin-light:text-slate-900">Printing</h2>
              <fieldset>
                <legend className={labelClasses}>Paper width</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(['58', '80'] as const).map((w) => (
                    <button
                      key={w}
                      type="button"
                      aria-pressed={config.paperWidth === w}
                      onClick={() => set('paperWidth', w)}
                      className={`flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]/50 admin-light:focus-visible:ring-[#1A5FB4]/50 ${config.paperWidth === w ? 'bg-[#62A0EA]/10 admin-light:bg-[#1A5FB4]/10 text-[#8CB9F0] admin-light:text-[#1A5FB4] border-[#62A0EA]/60 admin-light:border-[#1A5FB4]/60' : 'bg-[#0E1628] admin-light:bg-[#F8FAFC] text-slate-300 admin-light:text-slate-700 border-[#23344F] admin-light:border-[#CBD5E1] hover:border-[#62A0EA]/50 admin-light:hover:border-[#1A5FB4]/50'}`}
                    >
                      {w} mm
                      {config.paperWidth === w && <Check size={14} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">Match the paper loaded in your thermal printer.</p>
              </fieldset>
              <ToggleRow
                label="Auto-print after each transaction"
                hint="Print after a cash or GCash payment. Turn off to print manually."
                checked={config.autoPrint}
                onChange={(v) => set('autoPrint', v)}
              />
            </section>

            {/* Details on the receipt */}
            <section className={sectionClasses} aria-labelledby="receipt-details-title">
              <div>
                <h2 id="receipt-details-title" className="text-sm font-semibold text-white admin-light:text-slate-900">Receipt details</h2>
                <p className="text-xs leading-relaxed text-slate-500 mt-1">Choose what appears on each receipt.</p>
              </div>
              <div className="mt-3 divide-y divide-[#1E2D45] admin-light:divide-[#E2E8F0]">
                {DETAIL_TOGGLES.map((t) => (
                  <div key={t.key} className="py-3 first:pt-1 last:pb-0">
                    <ToggleRow
                      label={t.label}
                      hint={t.hint}
                      checked={config[t.key] as boolean}
                      onChange={(v) => set(t.key, v as ReceiptConfig[typeof t.key])}
                    />
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* ── Live preview column ── */}
          <section id="receipt-preview-panel" aria-labelledby="receipt-preview-title" className={`min-w-0 rounded-xl border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#111A2B] admin-light:bg-white @[48rem]:sticky @[48rem]:top-5 @[48rem]:block ${activeView === 'preview' ? 'block' : 'hidden'}`}>
            <div className="flex items-center justify-between gap-2 border-b border-[#1E2D45] admin-light:border-[#E2E8F0] px-4 py-3">
              <h2 id="receipt-preview-title" className="text-sm font-semibold text-white admin-light:text-slate-900">Live preview</h2>
              <span className="rounded-md bg-[#62A0EA]/10 admin-light:bg-[#1A5FB4]/10 px-2 py-1 text-xs font-medium text-[#8CB9F0] admin-light:text-[#1A5FB4]">{config.paperWidth} mm</span>
            </div>
            <div className="overflow-hidden rounded-b-xl bg-[#0E1628] admin-light:bg-[#E2E8F0] px-3 py-6">
              <ReceiptPreview config={config} />
              <p className="mt-4 text-center text-xs leading-relaxed text-slate-500">Sample transaction. Updates as you edit.</p>
            </div>
          </section>

          {/* Save (spans full width under both columns) */}
          <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0B1120] admin-light:bg-[#F1F5F9] px-4 py-4 sm:-mx-6 sm:px-6 @sm:flex-row @sm:items-center @sm:justify-between @[48rem]:col-span-2">
            <p role="status" className={`text-xs ${isSaved ? 'text-[#8CB9F0] admin-light:text-[#1A5FB4]' : 'text-slate-500'}`}>
              {isSaved ? 'Receipt settings saved.' : 'Changes apply after saving.'}
            </p>
            <button
              type="submit"
              disabled={isSaving}
              className="flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-[#62A0EA] admin-light:bg-[#1A5FB4] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#4A8BD4] admin-light:hover:bg-[#164A8F] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]/50 admin-light:focus-visible:ring-[#1A5FB4]/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B1120] admin-light:focus-visible:ring-offset-[#F1F5F9] disabled:opacity-50 disabled:cursor-not-allowed @sm:w-auto"
            >
              {isSaved ? <Check size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              <span>{isSaving ? 'Saving...' : 'Save changes'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-white admin-light:text-slate-900 font-medium text-sm">{label}</p>
        <p className="text-xs text-slate-500 mt-0.5">{hint}</p>
      </div>
      <label className="inline-flex min-h-11 shrink-0 cursor-pointer items-center">
        <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only peer" />
        <span aria-hidden="true" className="relative h-6 w-11 rounded-full bg-[#23344F] admin-light:bg-slate-300 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[#62A0EA]/50 admin-light:peer-focus-visible:ring-[#1A5FB4]/50 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[#111A2B] admin-light:peer-focus-visible:ring-offset-white peer-checked:bg-[#62A0EA] admin-light:peer-checked:bg-[#1A5FB4] peer-checked:[&>span]:translate-x-5">
          <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform" />
        </span>
      </label>
    </div>
  );
}

// A representative thermal receipt rendered from sample transaction data +
// the current config, so the admin sees exactly what the toggles produce.
function ReceiptPreview({ config }: { config: ReceiptConfig }) {
  const widthPx = config.paperWidth === '80' ? 300 : 230;
  const sampleReceiptCode = 'SAMPLE-RECEIPT-CODE';
  const claimInstruction = config.showQrCode && config.showManualCode
    ? 'Scan or enter code in Rewards: +1 ride.'
    : config.showQrCode ? 'Scan in Rewards: +1 ride.' : 'Enter code in Rewards: +1 ride.';

  return (
    <div
      className="bg-white text-black font-mono rounded-sm shadow-lg mx-auto px-3 py-4 text-[11px] leading-snug break-words"
      style={{ width: widthPx, maxWidth: '100%' }}
    >
      <div className="text-center">
        <p className="font-bold text-[13px] tracking-wide">{config.businessName || 'CHATCO'}</p>
        {config.addressLine && <p className="text-[10px] mt-0.5">{config.addressLine}</p>}
        <p className="text-[10px] mt-0.5">FARE RECEIPT</p>
      </div>
      <Line />

      {config.showDateTime && <Row k="Date" v="2026-07-23 14:05" />}
      {config.showTransactionId && <Row k="Ref" v="TXN-8K2P4Q" />}
      {config.showUnit && <Row k="Unit" v="UNIT-005 · ABC 1234" />}
      {config.showConductor && <Row k="Conductor" v="Juan Dela Cruz" />}
      {config.showPassenger && <Row k="Passenger" v="M. Santos (Student)" />}
      {config.showRoute && (
        <>
          <Line />
          <Row k="From" v="Malolos" />
          <Row k="To" v="Calumpit" />
        </>
      )}

      {config.showFareBreakdown && (
        <>
          <Line />
          <Row k="Base fare" v="₱13.00" />
          <Row k="Distance" v="6 km" />
          <Row k="Discount" v="-₱5.20" />
        </>
      )}

      <Line />
      <div className="flex justify-between font-bold text-[13px]">
        <span>TOTAL</span>
        <span>₱20.80</span>
      </div>
      <Row k="Paid via" v="Cash" />

      {(config.showQrCode || config.showManualCode) && (
        <>
          <Line />
          {config.showQrCode && (
            <div className="mx-auto w-fit bg-white p-1">
              <QRCodeSVG value={sampleReceiptCode} size={112} level="M" title="Sample receipt QR placeholder" />
            </div>
          )}
          <div className="mt-1 text-center text-[9px]">
            {config.showManualCode && (
              <>
                <p className="text-black/60">Receipt code</p>
                <p className="break-all font-bold">{sampleReceiptCode}</p>
              </>
            )}
            <p className="mt-1">{claimInstruction}</p>
            <p className="mt-1 font-bold">10/10 rides = 1 free ride.</p>
            <p className="mt-1 text-black/50">Sample only · Not claimable.</p>
          </div>
        </>
      )}
      <Line />

      {config.footerNote && <p className="text-center text-[10px] mt-1">{config.footerNote}</p>}
      <p className="mt-2 text-center text-[10px]">
        Visit Chatco at{' '}
        <a href="https://chatco.online" target="_blank" rel="noopener noreferrer" className="font-bold underline">chatco.online</a>
      </p>
    </div>
  );
}

function Line() {
  return <div className="border-t border-dashed border-black/40 my-1.5" />;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-black/60">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}
