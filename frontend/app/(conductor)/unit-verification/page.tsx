"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { ChartColumn, ChevronLeft, ChevronRight, Clock, LogOut, Settings, X } from "lucide-react";
import minibusFront from "@/assets/minibus-front.svg";
import { startShift } from "@/lib/conductor/services/shift.service";
import { fetchRemittanceHistory, type RemittanceRecord } from "@/lib/conductor/services/remittance.service";
import type { ConductorDriver, ConductorUnit } from "@/lib/conductor/types";
import { useUnitVerification } from "@/app/(conductor)/hooks/use-unit-verification";
import { useConductorShift } from "@/app/(conductor)/hooks/use-conductor-shift";
import UnitList from "@/components/conductor/unit-verification/UnitList";
import DriverList from "@/components/conductor/unit-verification/DriverList";
import StartShiftModal from "@/components/conductor/unit-verification/StartShiftModal";
import { UnitVerificationSkeleton } from "@/components/conductor/ui/skeleton";
import { useAuth } from "@/contexts/auth-context";
import { useLightModeToggle } from "@/contexts/commuter-theme-context";
import { ThemeToggleIcons } from "@/components/commuter/profile/profile-theme-toggle";
import MetricsContent from "@/components/conductor/metrics/metrics-content";
import SettingsContent from "@/components/conductor/settings/settings-content";
import { APP_DIALOG as D } from "@/components/shared/app-dialog-styles";

type Step = "select-unit" | "select-driver";
type AccountView = "metrics" | "settings";

// Same content as the Metrics and Settings tabs. Those tabs' own modals are
// dock-anchored popovers, and this page has no dock, so it opens them in a
// plain dialog instead.
const ACCOUNT_VIEWS: Record<AccountView, { label: string; title: string; icon: typeof Settings }> = {
  metrics: { label: "View all-time performance", title: "Performance Metrics", icon: ChartColumn },
  settings: { label: "Account settings and photo", title: "Settings", icon: Settings },
};

export default function ConductorLoginPage() {
  const router = useRouter();
  const { logout } = useAuth();
  const { profile, units, drivers, status, error, refresh } = useUnitVerification();
  const { shift, status: shiftStatus, refresh: refreshShift } = useConductorShift();
  const [isLight, setIsLight] = useLightModeToggle();

  const [step, setStep] = useState<Step>("select-unit");
  const [selectedUnit, setSelectedUnit] = useState<ConductorUnit | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<ConductorDriver | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Reason shown when an unavailable unit/driver is tapped — the same text
  // the backend would refuse the shift with.
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [isCheckingShift, setIsCheckingShift] = useState(true);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  // Remitted shift the admin hasn't declared yet: no new shift until settled.
  const [awaitingDeclaration, setAwaitingDeclaration] = useState<RemittanceRecord | null>(null);
  const [isRechecking, setIsRechecking] = useState(false);
  const [accountView, setAccountView] = useState<AccountView | null>(null);

  // Read fresh from the server, not the local history cache. Not Remitted
  // goes to End-of-Day to be remitted (oldest first there); a remitted but
  // undeclared shift shows the notice below. If the check itself fails, let
  // them through: starting a shift is refused server-side anyway, with the
  // same reason.
  const checkRemittances = useCallback(async (isCancelled: () => boolean = () => false) => {
    try {
      const history = await fetchRemittanceHistory();
      if (isCancelled()) return;
      if (history.some((record) => record.remittanceStatus === "Not Remitted")) {
        router.replace("/conductor-dashboard/end-of-day");
        return;
      }
      // History is newest first; name the oldest one still waiting.
      const waiting = history.filter(
        (record) => record.remittanceStatus === "For Cash Declaration" || record.remittanceStatus === "Overdue",
      );
      setAwaitingDeclaration(waiting[waiting.length - 1] ?? null);
    } catch {
      // Fall through to unit selection (see above).
    }
  }, [router]);

  const recheckDeclaration = async () => {
    if (isRechecking) return;
    setIsRechecking(true);
    await checkRemittances();
    setIsRechecking(false);
  };

  // Reuse the shift already fetched by ConductorShiftProvider (wraps the
  // whole (conductor) route group) instead of calling fetchActiveShift()
  // again here — this page used to fire a redundant duplicate request.
  useEffect(() => {
    if (shiftStatus === "loading") return;

    if (shift) {
      router.replace("/conductor-dashboard");
      return;
    }

    let cancelled = false;
    void checkRemittances(() => cancelled).finally(() => {
      if (!cancelled) setIsCheckingShift(false);
    });

    return () => {
      cancelled = true;
    };
  }, [shift, shiftStatus, router, checkRemittances]);

  if (isCheckingShift || status === "loading") {
    return <UnitVerificationSkeleton />;
  }

  const handleSelectUnit = (unit: ConductorUnit) => {
    setSelectionError(null);
    setSelectedUnit(unit);
    setStep("select-driver");
  };

  const handleSelectDriver = (driver: ConductorDriver) => {
    setSelectionError(null);
    setSubmitError(null);
    setSelectedDriver(driver);
    setShowConfirmModal(true);
  };

  const handleUnavailable = (item: ConductorUnit | ConductorDriver) => {
    setSelectionError(item.unavailableReason ?? "This option can't be used for a shift right now.");
  };

  const goBack = () => {
    if (step === "select-driver") {
      setSelectionError(null);
      setSelectedDriver(null);
      setStep("select-unit");
    }
  };

  const handleConfirmShift = async () => {
    if (!selectedUnit || !selectedDriver || !profile) return;

    setIsProcessing(true);
    setSubmitError(null);

    try {
      await startShift({
        unitId: selectedUnit.id,
        driverId: selectedDriver.id,
        routeId: selectedUnit.routeId,
      });
      // Sync the shared shift context before navigating — it's still
      // holding the pre-shift "empty" status from this page's own load,
      // and the dashboard's guard redirects back to unit-verification if
      // it mounts before that's corrected.
      await refreshShift();
      router.push("/conductor-dashboard");
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Unable to start shift. Please try again."
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const handleLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);

    await logout();
  };

  const accountLinks = (
    <div className="mb-4 shrink-0 space-y-2">
      {(Object.keys(ACCOUNT_VIEWS) as AccountView[]).map((view) => {
        const { label, icon: Icon } = ACCOUNT_VIEWS[view];
        return (
          <button
            key={view}
            type="button"
            onClick={() => setAccountView(view)}
            className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-[#1C3350] light:border-gray-200 bg-[#0B1E33] light:bg-white px-4 py-3 text-left transition-colors hover:bg-[#10273F] light:hover:bg-gray-100 active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1A5FB4]"
          >
            <Icon size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-slate-400 light:text-gray-500" />
            <span className="min-w-0 flex-1 text-sm font-medium text-slate-300 light:text-gray-700">{label}</span>
            <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-slate-500 light:text-gray-400" />
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="h-[100dvh] overflow-hidden bg-[#050F1A] light:bg-gray-50 flex flex-col">
      <div className="relative flex min-h-0 flex-1 flex-col px-4 py-4 sm:py-6 max-w-md lg:max-w-lg mx-auto w-full">
        <div className="mb-6 flex shrink-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Image src="/logo-transparent.png" alt="" width={40} height={40} className="shrink-0" priority />
            <div className="min-w-0">
              <p className="text-2xl font-extrabold text-white light:text-gray-900 tracking-tight">
                CHATCO<span className="text-[#62A0EA] light:text-[#1A5FB4]">.</span>
              </p>
              <p className="text-[10px] text-slate-500 light:text-gray-500 uppercase tracking-[0.2em] font-semibold mt-1">
                Conductor Portal
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Same light/dark preference and Moon/Sun swap as the profile
                toggle, on every screen size, in this page's solid button style. */}
            <button
              type="button"
              onClick={() => setIsLight(!isLight)}
              aria-label="Toggle dark and light mode"
              aria-pressed={isLight}
              title={isLight ? "Light mode · Switch to dark mode" : "Dark mode · Switch to light mode"}
              className="relative flex h-10 w-10 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-[#1C3350] light:border-gray-200 bg-[#0B1E33] light:bg-white text-slate-300 light:text-gray-700 transition-colors hover:bg-[#10273F] light:hover:bg-gray-100 hover:text-white light:hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1A5FB4]"
            >
              <ThemeToggleIcons isLight={isLight} size={18} />
            </button>
            <button
              type="button"
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-xl border border-[#1C3350] light:border-gray-200 bg-[#0B1E33] light:bg-white px-3 text-xs font-semibold text-slate-300 light:text-gray-700 transition-colors hover:bg-[#10273F] light:hover:bg-gray-100 hover:text-white light:hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <LogOut size={15} />
              {isLoggingOut ? "Signing out" : "Sign out"}
            </button>
          </div>
        </div>

        {status === "error" && error && (
          <div className="mb-4 rounded-xl border border-[#5C1F27] light:border-red-200 bg-[#2B1116] light:bg-red-50 px-4 py-3 text-center">
            <p className="text-sm text-red-300 light:text-red-700">{error}</p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="mt-2 text-xs font-semibold text-red-200 light:text-red-700 hover:text-white light:hover:text-gray-900 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {awaitingDeclaration && (
          <div role="status" className="animate-fade-in border-y border-[#1C3350] light:border-gray-200 py-6">
            <Clock size={32} strokeWidth={1.75} aria-hidden="true" className="text-[#62A0EA] light:text-[#1A5FB4]" />
            <h1 className="mt-4 text-xl font-bold text-white light:text-gray-900">Remittance awaiting declaration</h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-400 light:text-gray-600">
              Your remittance for the{" "}
              <span className="font-semibold text-white light:text-gray-900">
                {new Date(`${String(awaitingDeclaration.date).slice(0, 10)}T00:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}
              </span>{" "}
              shift is awaiting the admin&apos;s cash declaration. Please coordinate with the admin to have it settled before starting a new shift.
            </p>
            <button
              type="button"
              onClick={() => void recheckDeclaration()}
              disabled={isRechecking}
              className="mt-6 inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-xl bg-[#1A5FB4] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#164A8F] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRechecking ? "Checking" : "Check again"}
            </button>
          </div>
        )}

        {!awaitingDeclaration && status === "empty" && (
          <div className="rounded-xl border border-[#1C3350] light:border-gray-200 bg-[#0B1E33] light:bg-white px-6 py-10 text-center">
            <p className="text-sm font-semibold text-slate-200 light:text-gray-800">No units available</p>
            <p className="text-xs text-slate-400 light:text-gray-600 mt-2 leading-relaxed">
              Active units will appear here when they are not assigned to another conductor or already on shift.
            </p>
          </div>
        )}

        {!awaitingDeclaration && step === "select-unit" && units.length > 0 && (
          <div className="flex min-h-0 flex-1 flex-col animate-fade-in">
            <div className="mb-4 shrink-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 light:text-gray-500">Step 1 of 2</p>
              <h1 className="mt-1 text-xl font-bold text-white light:text-gray-900">Select your unit</h1>
              <p className="mt-1 text-sm text-slate-400 light:text-gray-600">
                Choose the vehicle unit assigned to you for this shift.
              </p>
            </div>
            {accountLinks}
            {selectionError && (
              <p role="alert" className="mb-3 shrink-0 rounded-xl border border-[#5C1F27] light:border-red-200 bg-[#2B1116] light:bg-red-50 px-4 py-2.5 text-xs font-medium text-red-300 light:text-red-700">
                {selectionError}
              </p>
            )}
            <UnitList units={units} onSelect={handleSelectUnit} onUnavailable={handleUnavailable} />
          </div>
        )}

        {!awaitingDeclaration && step === "select-driver" && (
          <div className="flex min-h-0 flex-1 flex-col animate-fade-in">
            <div className="mb-4 flex shrink-0 items-start gap-3">
              <button
                type="button"
                onClick={goBack}
                aria-label="Back to unit selection"
                className="mt-0.5 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[#1C3350] light:border-gray-200 bg-[#0B1E33] light:bg-white text-slate-300 light:text-gray-700 transition-colors hover:bg-[#10273F] light:hover:bg-gray-100 hover:text-white light:hover:text-gray-900 active:scale-95"
              >
                <ChevronLeft size={20} />
              </button>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 light:text-gray-500">Step 2 of 2</p>
                <h1 className="mt-1 text-xl font-bold text-white light:text-gray-900">Select your driver</h1>
                <p className="mt-1 text-sm text-slate-400 light:text-gray-600">
                  Choose the driver you will be assisting for today&apos;s shift.
                </p>
              </div>
            </div>

            {accountLinks}

            {selectedUnit && (
              <div className="mb-4 flex shrink-0 items-center gap-3 border-y border-[#1C3350] light:border-gray-200 py-3">
                <Image src={minibusFront} alt="" width={32} height={32} className="h-8 w-8 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 light:text-gray-500">Your unit</p>
                  <p className="text-sm font-semibold text-white light:text-gray-900">
                    {selectedUnit.unitNumber}
                    <span className="ml-2 font-medium text-slate-400 light:text-gray-600">{selectedUnit.plateNumber}</span>
                  </p>
                </div>
              </div>
            )}

            {drivers.length === 0 ? (
              <div className="rounded-xl border border-[#1C3350] light:border-gray-200 bg-[#0B1E33] light:bg-white px-6 py-8 text-center">
                <p className="text-sm font-semibold text-slate-200 light:text-gray-800">No drivers available</p>
                <p className="text-xs text-slate-400 light:text-gray-600 mt-2">
                  Driver assignments will appear here once the backend connection is active.
                </p>
              </div>
            ) : (
              <>
                {selectionError && (
                  <p role="alert" className="mb-3 shrink-0 rounded-xl border border-[#5C1F27] light:border-red-200 bg-[#2B1116] light:bg-red-50 px-4 py-2.5 text-xs font-medium text-red-300 light:text-red-700">
                    {selectionError}
                  </p>
                )}
                <DriverList drivers={drivers} onSelect={handleSelectDriver} onUnavailable={handleUnavailable} />
              </>
            )}
          </div>
        )}
      </div>

      <StartShiftModal
        show={showConfirmModal}
        unit={selectedUnit}
        driver={selectedDriver}
        conductorName={profile?.name ?? "Conductor"}
        isProcessing={isProcessing}
        error={submitError}
        onConfirm={handleConfirmShift}
        onCancel={() => { setShowConfirmModal(false); setSubmitError(null); }}
      />

      {accountView && (
        <div className={D.overlay} onClick={(e) => { if (e.target === e.currentTarget) setAccountView(null); }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-view-title"
            className={`${D.panel} animate-fade-in ${accountView === "metrics" ? "max-w-3xl" : "max-w-lg"}`}
          >
            <div className={`sticky top-0 z-10 flex items-center justify-between gap-4 border-b bg-[#0B1E33] light:bg-white px-5 py-4 ${D.hairline}`}>
              <h2 id="account-view-title" className={D.title}>{ACCOUNT_VIEWS[accountView].title}</h2>
              <button type="button" onClick={() => setAccountView(null)} aria-label="Close" className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-[#10273F] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] light:text-gray-400 light:hover:bg-gray-100 light:hover:text-gray-900">
                <X className="h-5 w-5" />
              </button>
            </div>
            {accountView === "metrics" ? <MetricsContent showHeader={false} /> : <SettingsContent showHeader={false} showSignOut={false} />}
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in {
          animation: fade-in 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}
