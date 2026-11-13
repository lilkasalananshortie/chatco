// app/(commuter)/layout.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Calculator } from "lucide-react";
import { RequireRole, useAuth } from "@/contexts/auth-context";
import { AnnouncementsProvider, useAnnouncements } from "@/contexts/announcements-context";
import { RewardsProvider, useRewardsData } from "@/contexts/rewards-context";
import { CommuterThemeProvider } from "@/contexts/commuter-theme-context";
import MaintenanceGate from "@/components/shared/maintenance-gate";
import { getCommuterTypeLabel } from "@/types";
import { FeedbackScanModal } from "@/components/commuter/feedback/feedback-scan-modal";
import CommuterDock from "@/components/commuter/commuter-dock";
import { CommuterAvatar } from "@/components/commuter/commuter-avatar";
import CommuterProfileModal from "@/components/commuter/commuter-profile-modal";
import CommuterFareModal from "@/components/commuter/commuter-fare-modal";
import StudentRenewalReminder from "@/components/commuter/student-renewal-reminder";
import MobileNavHighlight, { useMobileNavHighlight } from "@/components/shared/mobile-nav-highlight";
import { resumeShareTracking } from "@/lib/commuter/share-ride-tracker";

/**
 * Spell out what the Rewards badge is counting for screen readers — the number
 * alone is ambiguous when it merges two different things.
 */
function rewardsBadgeLabel(unread: number, vouchers: number, renewalDue: boolean): string {
  const parts: string[] = [];
  if (unread > 0) parts.push(`${unread} unread update${unread === 1 ? "" : "s"}`);
  if (vouchers > 0) parts.push(`${vouchers} voucher${vouchers === 1 ? "" : "s"} ready to redeem`);
  if (renewalDue) parts.push("student renewal due");
  return parts.join(", ");
}

function CommuterLayoutInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, commuterProfile, isLoading: authLoading } = useAuth();
  // A reload mid-share picks the live link back up, so the viewer's map keeps
  // moving (lib/commuter/share-ride-tracker.ts).
  useEffect(() => {
    if (user?.id) resumeShareTracking(user.id);
  }, [user?.id]);
  // The Feedback tab opens the QR scanner as an overlay instead of routing to
  // /feedback directly — scanning doesn't need a full page, and
  // this way it can be launched from wherever the commuter already is. What
  // happens after a scan (in place at lg+, or via /feedback) is owned by
  // FeedbackScanModal.
  const [showFeedbackScan, setShowFeedbackScan] = useState(false);
  const closeFeedbackScan = useCallback(() => setShowFeedbackScan(false), []);
  // The Rewards tab covers both announcements and vouchers, so its badge is
  // the sum of the two things worth opening it for: updates you haven't read,
  // and free-ride vouchers you can redeem right now (one per 10 cashless
  // rides, and the cycle repeats — several can be waiting at once).
  // Both come from providers shared with the rewards page, so acting on either
  // there decrements this badge immediately. 0 renders no badge at all.
  const { unreadCount, claimUpdatesUnreadCount } = useAnnouncements();
  const { availableVoucherCount, renewal } = useRewardsData();
  // The renewal notice on the rewards page counts as one until the renewal is
  // approved, even after its reminder announcement has been read.
  const renewalDue = renewal?.notice_active === true;
  const rewardsBadge = unreadCount + availableVoucherCount + (renewalDue ? 1 : 0);

  const mobileActiveHref = showFeedbackScan ? "/feedback" : pathname;
  const { navRowRef, highlightRef, iconRefs } = useMobileNavHighlight(mobileActiveHref);

  const navItemsWithBadges = navItems.map(item => {
    if (item.href === "/rewards") {
      return { ...item, badge: rewardsBadge, badgeLabel: rewardsBadgeLabel(unreadCount, availableVoucherCount, renewalDue) };
    }
    if (item.href === "/lost-and-found") {
      const label = claimUpdatesUnreadCount > 0
        ? `${claimUpdatesUnreadCount} unread claim update${claimUpdatesUnreadCount === 1 ? "" : "s"}`
        : "";
      return { ...item, badge: claimUpdatesUnreadCount, badgeLabel: label };
    }
    return { ...item, badge: 0, badgeLabel: "" };
  });

  // Derive user info from auth context
  const userName = commuterProfile
    ? `${commuterProfile.firstName} ${commuterProfile.surname}`
    : authLoading ? "Loading..." : "Guest";
  const userTypeLabel = commuterProfile
    ? getCommuterTypeLabel(commuterProfile.commuterType)
    : "";

  return (
    <div className="fixed inset-0 bg-[#050F1A] light:bg-[#F8FAFC] flex font-sans overflow-hidden">
      {/* The shell's own fill shows in the xl:pb-28 strip <main> keeps clear
          of the dock, so it follows the theme like the pages above it. */}

      {/* --- DESKTOP SIDEBAR --- */}
      {/* 1024–1279px only. At xl:+ (1280px) CommuterDock takes over as a
          floating bottom dock instead of a space-reserving rail (hidden
          entirely there, not just visually) — same split as the conductor
          app's ConductorSidebar/ConductorDock. */}
      <aside className="hidden lg:flex xl:hidden flex-col w-64 xl:w-72 bg-[#071A2E] border-r border-white/10 light:bg-white light:border-gray-200 z-50 flex-shrink-0">
        <div className="h-20 flex items-center px-6 border-b border-white/10 light:border-gray-200">
          <img src="/logo-transparent.png" alt="CHATCO" className="w-10 h-10 rounded-xl object-contain" />
          <span className="ml-3 text-white light:text-gray-900 font-extrabold text-lg tracking-tight">E-CHATCO</span>
        </div>

        <nav className="flex-1 py-6 px-4 space-y-1">
          {navItemsWithBadges.map((item) => {
            const isActive = pathname === item.href;
            const isFeedback = item.href === "/feedback";
            const className = `relative flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 min-w-0 ${
              isActive ? "bg-[#1A5FB4] text-white shadow-lg shadow-[#1A5FB4]/30" : "text-white/50 hover:text-white hover:bg-white/5 light:text-gray-500 light:hover:text-gray-900 light:hover:bg-gray-100"
            }`;
            const label = item.badge > 0 ? `${item.label} — ${item.badgeLabel}` : undefined;
            const content = (
              <>
                <div className="relative flex-shrink-0">
                  <item.icon className="w-5 h-5" />
                  {item.badge > 0 && (
                     <span
                       aria-hidden="true"
                       className="absolute -top-2 -right-2 min-w-4 h-4 px-1 bg-[#FF6D3A] rounded-full text-[9px] font-bold text-white flex items-center justify-center ring-2 ring-[#071A2E] light:ring-white tabular-nums"
                     >
                       {item.badge > 99 ? "99+" : item.badge}
                     </span>
                  )}
                </div>
                <span className="truncate">{item.label}</span>
              </>
            );
            return isFeedback ? (
              <button
                key={item.href}
                type="button"
                onClick={() => setShowFeedbackScan(true)}
                aria-label={label}
                className={className}
              >
                {content}
              </button>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                aria-label={label}
                className={className}
              >
                {content}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-white/10 light:border-gray-200">
          <div className="flex items-center gap-3 px-2">
            <CommuterAvatar
              src={commuterProfile?.profileImageUrl}
              className="w-9 h-9"
              iconClassName="w-[18px] h-[18px]"
              sizes="36px"
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white light:text-gray-900 truncate">{userName}</p>
              <p className="text-[10px] text-white/40 light:text-gray-500">{userTypeLabel}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* --- MAIN CONTENT AREA --- */}
      {/* xl:pb-28 clears the floating CommuterDock on scrolling pages so their
          last content isn't hidden behind it. Skipped on the dashboard: its
          map is full-bleed and should run under the dock, not stop above it. */}
      <main className={`flex-1 relative overflow-hidden ${pathname === "/dashboard" ? "" : "xl:pb-28"}`}>
        {children}

        {/* --- MOBILE BOTTOM NAV --- */}
        {/* Chrome matches components/conductor/conductor-bottom-nav.tsx so both
            roles read as the same app: same surface, blur, lift shadow and
            circular highlight and slide animation. */}
        <nav className="absolute bottom-0 inset-x-0 z-50 lg:hidden pb-safe">
          <div className="bg-[#0B1E33]/90 backdrop-blur-2xl shadow-[0_-4px_30px_rgba(0,0,0,0.3)] border-t border-white/[0.06] light:bg-white/90 light:shadow-[0_-4px_24px_rgba(15,23,42,0.08)] light:border-gray-200">
            <div ref={navRowRef} className="relative grid grid-cols-5 max-w-lg mx-auto pt-1 pb-1 md:pt-1.5 md:pb-1.5">
              <MobileNavHighlight highlightRef={highlightRef} />

              {/* Fare is reached from the dashboard's "Fare Matrix" action below lg:, not a tab. */}
              {navItemsWithBadges.filter((item) => item.href !== "/fare").map((item) => {
                const isActive = mobileActiveHref === item.href;
                const isFeedback = item.href === "/feedback";
                const label = item.badge > 0 ? `${item.label} — ${item.badgeLabel}` : undefined;
                const content = (
                  <>
                    <div
                      ref={(element) => {
                        if (element) iconRefs.current.set(item.href, element);
                        else iconRefs.current.delete(item.href);
                      }}
                      className={`relative flex items-center justify-center w-9 h-9 md:w-10 md:h-10 rounded-full transition-colors duration-300 ${
                        isActive ? "" : "hover:bg-white/[0.06] light:hover:bg-gray-900/[0.05]"
                      }`}
                    >
                      <item.icon className={`w-[17px] h-[17px] md:w-[18px] md:h-[18px] transition-colors duration-300 ${isActive ? "text-white" : "text-white/40 group-hover:text-white/70 light:text-gray-400 light:group-hover:text-gray-600"}`} />

                      {item.badge > 0 && (
                        <span
                          aria-hidden="true"
                          className="absolute -top-1 -right-1 min-w-4 h-4 px-1 bg-[#FF6D3A] rounded-full text-[9px] font-bold text-white flex items-center justify-center ring-2 ring-[#0B1E33] light:ring-white tabular-nums"
                        >
                          {item.badge > 99 ? "99+" : item.badge}
                        </span>
                      )}
                    </div>

                    <span className={`text-[10px] font-medium mt-0.5 md:mt-1 transition-colors duration-300 leading-none truncate max-w-full px-0.5 text-center ${
                      isActive ? "text-white light:text-[#1A5FB4]" : "text-white/30 group-hover:text-white/50 light:text-gray-400 light:group-hover:text-gray-600"
                    }`}>
                      {item.shortLabel || item.label}
                    </span>
                  </>
                );
                return isFeedback ? (
                  <button
                    key={item.href}
                    type="button"
                    onClick={() => setShowFeedbackScan(true)}
                    aria-label={label}
                    className="flex min-w-0 flex-col items-center justify-center py-1 relative z-10 group"
                  >
                    {content}
                  </button>
                ) : (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-label={label}
                    aria-current={pathname === item.href ? "page" : undefined}
                    className="flex min-w-0 flex-col items-center justify-center py-1 relative z-10 group"
                  >
                    {content}
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>
      </main>

      {/* --- LARGE-SCREEN FLOATING DOCK (xl:+ only — see CommuterDock) --- */}
      <CommuterDock
        items={navItemsWithBadges}
        pathname={pathname}
        onFeedbackClick={() => setShowFeedbackScan(true)}
        userPhotoUrl={commuterProfile?.profileImageUrl ?? null}
        userName={userName}
        userTypeLabel={userTypeLabel}
      />

      {/* --- PROFILE POPOVER (xl:+, opened from CommuterDock) --- */}
      <CommuterProfileModal />
      <CommuterFareModal />
      <StudentRenewalReminder />

      {/* --- FEEDBACK QR SCAN MODAL --- */}
      {showFeedbackScan && <FeedbackScanModal onClose={closeFeedbackScan} />}
    </div>
  );
}

// Auth state comes from the AuthProvider in the root layout. Mounting a second
// one here made every commuter page load fetch /api/auth/me twice (once per
// provider), and again on the login redirect. The announcement and rewards
// providers sit inside the root one (both read auth to decide whether to
// fetch) and outside the layout body, so the tab badge and the rewards page
// share one copy of the feed and one copy of the vouchers.
export default function CommuterLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole role="COMMUTER">
    <CommuterThemeProvider>
    <AnnouncementsProvider>
      <RewardsProvider>
        <MaintenanceGate>
          <CommuterLayoutInner>{children}</CommuterLayoutInner>
        </MaintenanceGate>
      </RewardsProvider>
    </AnnouncementsProvider>
    </CommuterThemeProvider>
    </RequireRole>
  );
}

// --- ICONS ---
const HomeIcon = ({ className }: { className?: string }) => (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" /></svg>);
const LostFoundIcon = ({ className }: { className?: string }) => (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>);
const GiftIcon = ({ className }: { className?: string }) => (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M21 11.25v8.25a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 1 0 9.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1 1 14.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>);
const BellIcon = ({ className }: { className?: string }) => (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" /></svg>);
const UserIcon = ({ className }: { className?: string }) => (<svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" /></svg>);

// Navigation items — 6 tabs
const navItems = [
  { href: "/dashboard", label: "Home", shortLabel: "Home", icon: HomeIcon },
  { href: "/fare", label: "Fare", shortLabel: "Fare", icon: Calculator },
  { href: "/lost-and-found", label: "Lost & Found", shortLabel: "Lost & Found", icon: LostFoundIcon },
  { href: "/rewards", label: "Rewards & Announcements", shortLabel: "Rewards", icon: GiftIcon },
  { href: "/feedback", label: "Feedback", shortLabel: "Feedback", icon: BellIcon },
  { href: "/profile", label: "Profile", shortLabel: "Profile", icon: UserIcon },
];
