"use client";

import { useState, useMemo, useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { LockKeyhole, UserRound } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { clearShift } from "@/lib/conductor/services/shift.service";
import { useConductorShift } from "@/app/(conductor)/hooks/use-conductor-shift";
import { useRemittanceData } from "@/app/(conductor)/hooks/use-remittance-data";
import { patchConductorProfile, useConductorProfile } from "@/app/(conductor)/hooks/use-conductor-profile";
import { uploadConductorProfilePhoto } from "@/lib/conductor/services/profile.service";
import ProfilePhoto from "@/components/commuter/profile/profile-photo";
import { SettingsSkeleton } from "@/components/conductor/ui/skeleton";
import type { SignOutControl } from "@/components/commuter/profile/account-menu";
import HistorySection, { filterRemittanceHistory, type RemittanceHistoryFilter } from "@/components/conductor/remittance/HistorySection";
import OfficialReportModal, { printRemittanceReport } from "@/components/conductor/remittance/OfficialReportModal";
import type { RemittanceRecord } from "@/lib/conductor/services/remittance.service";

export const LOGOUT_LOCKED_HINT = "Remit all pending collections before signing out.";

/**
 * The actual Settings body — everything except page chrome (the outer
 * sidebar-clearance wrapper, which only makes sense for the full page, not
 * the xl:+ popover — see ConductorSettingsModal). Extracted so the business
 * logic (profile fetch, past shifts, the
 * remittance-gated logout flow) has exactly one implementation shared by
 * both:
 *   - the full page (app/(conductor)/conductor-dashboard/conductor-settings/page.tsx),
 *     kept for phones/tablets (below xl:) and for anyone linking/refreshing
 *     directly into the URL.
 *   - the xl:+ popover (ConductorSettingsModal), opened from ConductorDock
 *     instead of navigating away from whatever tab the conductor was on.
 *
 * Same split as EndOfDayContent/MetricsContent.
 *
 * @param showHeader Set false when a caller's own shell already shows the
 * "Settings" title (ConductorSettingsModal's sticky header) — the page has
 * no such chrome of its own, so it keeps this true (the default) and gets
 * the title from here instead.
 *
 * @param onSignOutControl Given by shells that show AccountMenu in their
 * header (lg:+): receives the confirm trigger and remittance lock, and the
 * bottom Log Out button is hidden at lg:+ so it isn't shown twice.
 *
 * @param showSignOut False when the caller's page already has its own Sign
 * out (unit verification), so the bottom button isn't shown at all.
 */
export default function SettingsContent({ showHeader = true, onSignOutControl, showSignOut = true }: { showHeader?: boolean; onSignOutControl?: (control: SignOutControl | null) => void; showSignOut?: boolean }) {
  const { user, logout } = useAuth();
  const profileHeadingId = useId();
  const detailsHeadingId = useId();
  const { shift, status: shiftStatus, error: shiftError } = useConductorShift();
  const { history, transactions, status: remitStatus, error: remitError } = useRemittanceData();
  // The conductor's real profile (name, username, photo), shared with the
  // shell's avatars so it's fetched once.
  const conductorProfile = useConductorProfile();

  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // Past shifts: same filters and defaults as End-of-Day, but open by default.
  const [showHistory, setShowHistory] = useState(true);
  const [historyFilter, setHistoryFilter] = useState<RemittanceHistoryFilter>("week");
  const [historyDateFrom, setHistoryDateFrom] = useState("");
  const [historyDateTo, setHistoryDateTo] = useState("");
  const [reportRecord, setReportRecord] = useState<RemittanceRecord | null>(null);
  const filteredHistory = useMemo(
    () => filterRemittanceHistory(history, historyFilter, historyDateFrom, historyDateTo),
    [history, historyFilter, historyDateFrom, historyDateTo],
  );
  // Records carry no route; End-of-Day prints the current shift's, so match it.
  const reportRoute = shift?.route || "—";

  // ── DEBUG ONLY ──────────────────────────────────────────────────
  // Conductors normally cannot self-logout: remittance is what closes out an
  // account, so the button stays locked until cash is settled. This override
  // unlocks it for testing (e.g. switching accounts to exercise single-device
  // session enforcement). Gated on NODE_ENV, so a production build always
  // keeps the remittance rule — it cannot be flipped on by accident.
  const debugLogoutUnlocked = process.env.NODE_ENV !== "production";

  const logoutLocked = useMemo(() => {
    if (debugLogoutUnlocked) return false;
    if (!shift) return false;

    const hasPendingRemit = history.some(
      (record) => (record.remittanceStatus === "Not Remitted" || record.remittanceStatus === "For Cash Declaration" || record.remittanceStatus === "Overdue") && record.cashTotal > 0
    );
    if (hasPendingRemit) return true;

    const totalCollections = transactions.reduce((sum, txn) => sum + txn.finalAmount, 0);
    const hasSubmitted = history.some(
      (record) => record.shiftId === shift.shiftId
        && (record.remittanceStatus === "Settled" || record.remittanceStatus === "Shortage" || record.remittanceStatus === "Overage" || record.remittanceStatus === "For Cash Declaration" || record.remittanceStatus === "Overdue")
    );
    if (totalCollections > 0 && !hasSubmitted) return true;

    return false;
  }, [debugLogoutUnlocked, shift, history, transactions]);

  // Only offered once shift/remittance data has loaded: until then the lock
  // can't be evaluated, and the confirmation dialog isn't rendered.
  const isReady = shiftStatus !== "loading" && shiftStatus !== "error" && remitStatus !== "loading" && remitStatus !== "error";
  useEffect(() => {
    if (!onSignOutControl || !isReady) return;
    onSignOutControl({ request: () => setShowLogoutConfirm(true), locked: logoutLocked });
    return () => onSignOutControl(null);
  }, [onSignOutControl, isReady, logoutLocked]);

  const handleLogout = () => {
    setShowLogoutConfirm(true);
  };

  const confirmLogout = () => {
    setShowLogoutConfirm(false);
    clearShift();
    // Must revoke the session, not just navigate: router.push alone left the
    // Sanctum token and the httpOnly cookie intact, so the "logged out"
    // conductor could reach the dashboard again just by navigating back.
    // logout() clears both server-side and hard-redirects to /login.
    void logout();
  };

  if (shiftStatus === "loading" || remitStatus === "loading") {
    return <SettingsSkeleton />;
  }

  if (shiftStatus === "error" || remitStatus === "error") {
    return (
      <div className="flex items-center justify-center px-6 py-16">
        <div className="max-w-sm text-center">
          <p className="text-red-300 light:text-red-600 text-sm">{shiftError || remitError}</p>
        </div>
      </div>
    );
  }

  const conductorName = conductorProfile?.name?.trim() || shift?.conductorName?.trim() || "Conductor";
  const username = conductorProfile?.username?.trim();

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 lg:py-8 space-y-6 text-white light:text-gray-900">
      {/* ===== Page Header ===== */}
      {showHeader && (
        <div>
          <h1 className="text-white light:text-gray-900 font-bold text-xl lg:text-2xl">Settings</h1>
          <p className="text-white/40 light:text-gray-600 text-sm mt-1">
            Manage your app preferences and account
          </p>
        </div>
      )}

      {/* ===== Profile Section ===== */}
      <section aria-labelledby={profileHeadingId} className="relative isolate flex items-center gap-4 overflow-hidden rounded-2xl border border-[#62A0EA]/20 light:border-blue-200 bg-gradient-to-br from-[#102E50] to-[#071A2E] light:from-blue-50 light:to-white p-5 xl:gap-5 xl:from-[#153C66] xl:via-[#0C2743] light:xl:from-blue-50 light:xl:via-blue-50 light:xl:to-white xl:p-6">
        <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-16 -z-10 h-56 w-56 rounded-full border border-[#99C1F1]/10 light:border-[#1A5FB4]/10 bg-[#62A0EA]/5">
          <div className="absolute inset-6 rounded-full border border-[#99C1F1]/10 light:border-[#1A5FB4]/10" />
          <div className="absolute inset-12 rounded-full border border-[#99C1F1]/10 light:border-[#1A5FB4]/10" />
        </div>
        {/* The default avatar remains until the conductor uploads a photo. */}
        <ProfilePhoto
          profileImageUrl={conductorProfile?.photoUrl}
          onPhotoUploaded={(photoUrl) => patchConductorProfile({ photoUrl })}
          uploadPhoto={uploadConductorProfilePhoto}
          className="group relative h-20 w-20 xl:h-24 xl:w-24 rounded-2xl border border-[#62A0EA]/30 bg-[#1A5FB4] text-white xl:border-[#99C1F1]/30 xl:bg-gradient-to-br xl:from-[#337DD2] xl:to-[#1A5FB4] xl:shadow-lg xl:shadow-[#050F1A]/30 xl:ring-4 xl:ring-white/5 transition-colors hover:border-[#99C1F1] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#99C1F1]"
          iconClassName="h-10 w-10 xl:h-12 xl:w-12"
          sizes="(min-width: 1280px) 96px, 80px"
        />
        <div className="min-w-0 flex-1">
          <h2 id={profileHeadingId} className="break-words text-xl font-bold leading-snug tracking-tight text-white light:text-gray-900 xl:text-2xl">
            {conductorName}
          </h2>
          {username && <p className="mt-1 break-words text-sm text-white/50 light:text-gray-600">@{username}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-[#337DD2] bg-[#1A5FB4] px-2.5 py-1 text-[11px] font-semibold text-white">Conductor</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-600 bg-slate-700 px-2.5 py-1 text-[11px] font-medium text-white">
              <LockKeyhole size={12} aria-hidden="true" />Managed by admin
            </span>
          </div>
        </div>
      </section>

      <section aria-labelledby={detailsHeadingId} className="rounded-2xl border border-white/10 light:border-gray-200 bg-[#0B223A] light:bg-white p-5">
        <h3 id={detailsHeadingId} className="flex items-center gap-2 text-sm font-semibold text-white light:text-gray-900">
          <UserRound size={17} aria-hidden="true" className="text-[#99C1F1] light:text-blue-600" />Personal details
        </h3>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5">
          <div className="col-span-full">
            <dt className="text-xs text-white/50 light:text-gray-500">Full name</dt>
            <dd className="mt-1 break-words text-sm text-white/90 light:text-gray-900">{conductorName}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-white/50 light:text-gray-500">Username</dt>
            <dd className="mt-1 break-words text-sm text-white/90 light:text-gray-900">{username || "Not provided"}</dd>
          </div>
          <div>
            <dt className="text-xs text-white/50 light:text-gray-500">Account type</dt>
            <dd className="mt-1 text-sm text-white/90 light:text-gray-900">Conductor</dd>
          </div>
          <div className="col-span-full border-t border-white/10 light:border-gray-200 pt-4">
            <dt className="text-xs text-white/50 light:text-gray-500">Email address</dt>
            <dd className="mt-1 break-all text-sm text-white/90 light:text-gray-900">{conductorProfile?.email || user?.email || "Not provided"}</dd>
          </div>
        </dl>
      </section>

      {/* ===== Past shifts — the same list as End-of-Day's Remittance History ===== */}
      <HistorySection
        showHistory={showHistory}
        setShowHistory={setShowHistory}
        filteredHistory={filteredHistory}
        historyFilter={historyFilter}
        setHistoryFilter={setHistoryFilter}
        historyDateFrom={historyDateFrom}
        setHistoryDateFrom={setHistoryDateFrom}
        historyDateTo={historyDateTo}
        setHistoryDateTo={setHistoryDateTo}
        openOfficialReport={(record) => setReportRecord(record ?? null)}
        onPrintReport={(record) => printRemittanceReport(record, reportRoute)}
      />
      {/* Portaled for the same reason as the logout confirmation below. */}
      {reportRecord && createPortal(
        <OfficialReportModal show onClose={() => setReportRecord(null)} activeReport={reportRecord} route={reportRoute} />,
        document.body,
      )}

      {/* ===== Logout (Bottom of scroll for both Mobile & Desktop) ===== */}
      {showSignOut && (
      <div className={`pt-6 border-t border-white/[0.06] light:border-gray-200 ${onSignOutControl ? "lg:hidden" : ""}`}>
        {logoutLocked && (
          <div className="flex items-center justify-center gap-1.5 mb-3">
            <svg
              className="w-3 h-3 text-amber-400/70 light:text-amber-700 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
            <p className="text-xs text-amber-400/70 light:text-amber-700 font-medium">
              {LOGOUT_LOCKED_HINT}
            </p>
          </div>
        )}
        <button
          onClick={handleLogout}
          disabled={logoutLocked}
          className="w-full flex min-h-12 items-center justify-center gap-2 rounded-xl border border-red-500/20 bg-red-500/5 px-4 text-red-400 light:text-red-600 hover:bg-red-500/10 transition-colors disabled:opacity-25 disabled:cursor-not-allowed active:scale-[0.98]"
        >
          <svg
            className="w-[17px] h-[17px]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9"
            />
          </svg>
          <span className="text-sm font-medium">
            Sign out
          </span>
        </button>
      </div>
      )}

      {/* ===== Logout Confirmation Modal ===== */}
      {/* Portaled to <body>: inside the xl:+ Settings popover, this component
          sits within a scrolling panel whose entrance animation leaves a
          `transform` on it, and a transformed ancestor becomes the containing
          block for `position: fixed` descendants — so the overlay was pinned
          to the panel's scrollable content (off-screen when Log Out, at the
          bottom, was clicked) instead of the viewport. Same shell as
          End-of-Day's ConfirmModal (remit to admin). */}
      {showLogoutConfirm && createPortal(
        <div className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowLogoutConfirm(false)} />
          <div className="relative w-full max-w-sm bg-[#0B1E33] light:bg-white border border-white/10 light:border-gray-200 rounded-3xl overflow-hidden shadow-2xl animate-slide-up max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex flex-col items-center text-center space-y-4">
                <div className="w-14 h-14 bg-red-500/15 rounded-full flex items-center justify-center">
                  <svg className="w-7 h-7 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white light:text-gray-900">Sign out?</h2>
                  <p className="text-sm text-white/50 light:text-gray-600 mt-1">Are you sure you want to sign out? You will need to sign in again to continue.</p>
                </div>
                <div className="w-full grid grid-cols-2 gap-3 pt-2">
                  <button
                    onClick={() => setShowLogoutConfirm(false)}
                    className="py-3 rounded-xl text-sm font-semibold border border-white/10 light:border-gray-300 text-gray-300 light:text-gray-700 hover:bg-white/5 light:hover:bg-gray-100 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmLogout}
                    className="py-3 rounded-xl text-sm font-bold bg-red-600 text-white hover:bg-red-700 transition-colors"
                  >
                    Sign out
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
