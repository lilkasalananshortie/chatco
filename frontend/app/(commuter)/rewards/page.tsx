"use client";

import { useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  AlertCircle, ArrowRight, Bell, CheckCheck, CheckCircle2, ChevronRight, CircleHelp,
  Clock3, GraduationCap, Loader2, QrCode, RefreshCw, Ticket,
} from "lucide-react";
import { VoucherWallet } from "@/components/commuter/rewards/voucher-wallet";
import { PageTabs } from "@/components/admin/ui/page-tabs";
import { Modal } from "@/components/shared/modal";
import { useAnnouncements } from "@/contexts/announcements-context";
import { useRewards } from "./use-rewards";
import type { Announcement, Voucher, VoucherTab } from "./types";
import { announcementCategory } from "@/lib/shared/announcement-category";
import Link from "next/link";
import { useAuth } from "@/contexts/auth-context";
import { useRewardsData } from "@/contexts/rewards-context";
import { RENEWAL_LABELS, type RenewalState } from "@/lib/shared/services/student-renewal.service";

const ReceiptScanModal = dynamic(
  () => import("@/components/commuter/modals/receipt-scan-modal"),
  { ssr: false }
);

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })
    : "";
}

function voucherStatus(voucher: Voucher): Voucher["status"] {
  return voucher.status === "AVAILABLE" && voucher.expiresAt && new Date(voucher.expiresAt).getTime() <= Date.now()
    ? "EXPIRED" : voucher.status;
}

export default function RewardsPage() {
  const { commuterProfile } = useAuth();
  // Renewal state is shared with the tab badge (contexts/rewards-context.tsx).
  const { renewal, refreshRenewal } = useRewardsData();
  const {
    data, isLoading, error, refetch, progressPercent, ridesRemaining,
  } = useRewards();
  const { announcements, isLoading: announcementsLoading, markAsRead, markAllAsRead, unreadCount } = useAnnouncements();
  const [section, setSection] = useState<"rewards" | "announcements">("rewards");
  // Opening the page or switching sections re-reads it, as before.
  useEffect(() => { refreshRenewal(); }, [refreshRenewal, section]);
  const [voucherTab, setVoucherTab] = useState<VoucherTab>("available");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [showReceiptScan, setShowReceiptScan] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<Announcement | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogOpen = showHelp || selectedAnnouncement !== null;

  // Keep keyboard focus in the active rewards dialog and restore its trigger.
  useEffect(() => {
    if (!dialogOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]') ?? []);
    controls()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowHelp(false);
        setSelectedAnnouncement(null);
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, [dialogOpen]);

  const available = (data?.vouchers ?? []).filter(voucher => voucherStatus(voucher) === "AVAILABLE");
  // The wallet tabs reload whenever the usable set changes: a voucher earned,
  // used by the conductor, or expired.
  const walletResetKey = available.map(voucher => voucher.id).sort().join(",");
  const visibleAnnouncements = unreadOnly ? announcements.filter(item => !item.isRead) : announcements;
  const selectedCategory = selectedAnnouncement ? announcementCategory(selectedAnnouncement) : null;
  const progress = Math.min(100, Math.max(0, Number.isFinite(progressPercent) ? progressPercent : 0));
  const remaining = Math.max(0, ridesRemaining);

  const refreshRewards = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try { await refetch(); } finally { setIsRefreshing(false); }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#050F1A] text-white light:bg-[#F8FAFC] light:text-gray-900">
      <header className="shrink-0 border-b border-white/10 bg-[#071A2E] light:border-gray-200 light:bg-white">
        <div className="mx-auto max-w-4xl px-4 pt-5 lg:px-8 lg:pt-7">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-xl font-bold lg:text-2xl">Rewards & Updates</h1>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setShowHelp(true)} aria-label="How rewards work" title="How rewards work" className="hidden h-10 w-10 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/5 hover:text-white light:text-gray-500 light:hover:bg-gray-100 light:hover:text-gray-900 lg:flex">
                <CircleHelp size={19} />
              </button>
              <button type="button" onClick={() => setShowReceiptScan(true)} aria-label="Scan receipt" title="Scan receipt QR" className="inline-flex h-11 w-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-[#050F1A] text-sm font-semibold transition-colors hover:bg-white/5 lg:h-10 lg:w-auto lg:rounded-lg lg:border-transparent lg:bg-[#1A5FB4] lg:px-3 lg:hover:bg-[#164A8F] text-white light:max-lg:border-gray-200 light:max-lg:bg-white light:max-lg:text-gray-700 light:max-lg:hover:bg-gray-100">
                <QrCode size={19} /><span className="hidden lg:inline">Scan receipt</span>
              </button>
            </div>
          </div>
          <PageTabs
            activeId={section}
            onChange={next => { setSection(next); scrollRef.current?.scrollTo({ top: 0 }); }}
            tabs={[
              { id: "rewards", label: "Rewards", icon: Ticket, count: available.length || undefined },
              { id: "announcements", label: "Updates", icon: Bell, count: unreadCount || undefined },
            ]}
          />
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div role="tabpanel" aria-label={section === "rewards" ? "Rewards" : "Updates"} className="mx-auto max-w-4xl px-4 pb-28 pt-6 lg:px-8 lg:pt-8">
          {section === "rewards" ? (
            isLoading ? <LoadingState label="Loading rewards" /> : !data ? (
              <div className="py-12 text-center">
                <h2 className="text-lg font-semibold">Rewards are unavailable</h2>
                <p role="alert" className="mt-2 text-sm text-white/60 light:text-gray-500">{error ?? "Please try again."}</p>
                <button onClick={() => void refreshRewards()} disabled={isRefreshing} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#1A5FB4] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
                  <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} /> Try again
                </button>
              </div>
            ) : (
              <>
                {error && <p role="alert" className="mb-5 flex items-start gap-2 text-sm text-red-400 light:text-red-600"><AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" /><span>{error} Showing your last loaded rewards.</span></p>}
                <section aria-labelledby="mobile-progress-title" className="relative flex flex-col items-center gap-8 rounded-2xl border border-white/10 bg-[#071A2E] p-6 pt-12 shadow-xl shadow-black/20 light:border-gray-200 light:bg-white light:shadow-black/5 md:flex-row md:p-8 lg:hidden">
                  <button type="button" onClick={() => setShowHelp(true)} aria-label="How rewards work" title="How rewards work" className="absolute left-4 top-4 flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-[#050F1A] text-white/50 hover:text-white light:border-gray-200 light:bg-gray-50 light:text-gray-500 light:hover:text-gray-900">
                    <CircleHelp size={16} />
                  </button>
                  <div role="progressbar" aria-label="Paid rides toward your next free ride" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${data.currentCycleRides} of ${data.ridesNeeded} paid rides`} className="relative h-48 w-48 shrink-0">
                    <svg aria-hidden="true" className="h-full w-full -rotate-90" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="8" className="light:stroke-gray-200" />
                      <circle cx="50" cy="50" r="40" fill="none" stroke={progress === 100 ? "#10B981" : "#1A5FB4"} strokeWidth="8" strokeLinecap="round" strokeDasharray={2 * Math.PI * 40} strokeDashoffset={2 * Math.PI * 40 * (1 - progress / 100)} className="transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none" />
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-3xl font-bold tabular-nums">{data.currentCycleRides}</span>
                      <span className="text-[10px] font-semibold uppercase text-white/50 light:text-gray-500">of {data.ridesNeeded} rides</span>
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 text-center md:text-left">
                    <h2 id="mobile-progress-title" className="mb-2 text-xl font-bold">{remaining === 0 ? "Free Ride Unlocked!" : `${remaining} Ride${remaining === 1 ? "" : "s"} to Free Ride`}</h2>
                    <p className="mb-6 text-sm leading-relaxed text-white/50 light:text-gray-500">Complete {data.ridesNeeded} paid rides to earn a free ride voucher. GCash counts automatically; cash counts once you scan the receipt QR.</p>
                    <dl className="flex flex-wrap justify-center gap-6 md:justify-start">
                      <div><dt className="text-[10px] font-semibold uppercase text-white/50 light:text-gray-500">Total Rides</dt><dd className="mt-1 text-lg font-bold tabular-nums">{data.totalRides}</dd></div>
                      <div><dt className="text-[10px] font-semibold uppercase text-white/50 light:text-gray-500">Vouchers Available</dt><dd className="mt-1 text-lg font-bold tabular-nums">{available.length}</dd></div>
                    </dl>
                  </div>
                </section>
                <section aria-labelledby="progress-title" className="hidden border-b border-white/10 pb-7 light:border-gray-200 lg:block">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-medium text-[#99C1F1] light:text-[#1A5FB4]">Next free ride</p>
                      <h2 id="progress-title" className="mt-2 text-xl font-bold">
                        {remaining === 0 ? "Free ride earned" : `${remaining} more paid ride${remaining === 1 ? "" : "s"}`}
                      </h2>
                    </div>
                    <button onClick={() => void refreshRewards()} disabled={isRefreshing} aria-label="Refresh rewards" title="Refresh rewards" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/50 hover:bg-white/5 hover:text-white light:text-gray-500 light:hover:bg-gray-100 light:hover:text-gray-900 disabled:opacity-50">
                      <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} />
                    </button>
                  </div>
                  <div className="mt-5 flex items-baseline justify-between gap-3 text-sm">
                    <p><span className="font-semibold tabular-nums">{data.currentCycleRides}</span><span className="text-white/50 light:text-gray-500"> / {data.ridesNeeded} rides</span></p>
                    <span className="text-xs text-white/50 light:text-gray-500">{data.totalRides} paid rides total</span>
                  </div>
                  <div role="progressbar" aria-label="Paid rides toward your next free ride" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${data.currentCycleRides} of ${data.ridesNeeded} paid rides`} className="mt-2 h-2 overflow-hidden rounded-full bg-white/10 light:bg-gray-200">
                    <div className="h-full rounded-full bg-[#62A0EA] light:bg-[#1A5FB4] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="mt-4 text-xs leading-relaxed text-white/60 light:text-gray-500">GCash rides count automatically. Scan your cash receipt to add a paid ride.</p>
                </section>

                <VoucherWallet
                  tab={voucherTab}
                  onTabChange={setVoucherTab}
                  availableCount={available.length}
                  ridesRemaining={remaining || data.ridesNeeded}
                  resetKey={walletResetKey}
                  onScanReceipt={() => setShowReceiptScan(true)}
                />
              </>
            )
          ) : (
            <section aria-labelledby="updates-title">
              {renewal?.notice_active && <RenewalNotice renewal={renewal} />}
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <h2 id="updates-title" className="text-base font-semibold">Announcements</h2>
                <button onClick={markAllAsRead} disabled={unreadCount === 0 || announcementsLoading} className="inline-flex items-center gap-2 text-xs font-medium text-[#99C1F1] hover:text-white light:text-[#1A5FB4] light:hover:text-[#164A8F] disabled:text-white/30 light:disabled:text-gray-300"><CheckCheck size={16} /> Mark all read</button>
              </div>
              <label className="mb-4 inline-flex cursor-pointer items-center gap-2 text-xs text-white/70 light:text-gray-600"><input type="checkbox" checked={unreadOnly} onChange={event => setUnreadOnly(event.target.checked)} className="h-4 w-4 accent-[#1A5FB4]" /> Unread only</label>
              {announcementsLoading ? <LoadingState label="Loading updates" /> : visibleAnnouncements.length === 0 ? (
                <div className="border-y border-white/10 py-9 light:border-gray-200">
                  <h3 className="text-sm font-semibold">{unreadOnly ? "No unread updates" : "No updates right now"}</h3>
                  {unreadOnly && <button onClick={() => setUnreadOnly(false)} className="mt-3 text-sm text-[#99C1F1] hover:text-white light:text-[#1A5FB4] light:hover:text-[#164A8F]">View all updates</button>}
                </div>
              ) : (
                <ul className="space-y-3 lg:space-y-0 lg:divide-y lg:divide-white/10 lg:border-y lg:border-white/10 light:divide-gray-200 light:border-gray-200">
                  {visibleAnnouncements.map(item => {
                    const category = announcementCategory(item);
                    return (
                      <li key={item.id}>
                        <button onClick={() => { markAsRead(item.id); setSelectedAnnouncement(item); }} className="flex w-full items-start gap-3 rounded-xl border border-white/10 bg-[#071A2E] p-4 text-left transition-colors hover:bg-white/[0.03] light:max-lg:border-gray-200 light:max-lg:bg-white light:hover:bg-gray-50 lg:rounded-none lg:border-0 lg:bg-transparent lg:px-0 lg:py-5">
                          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${item.isRead ? "bg-transparent" : "bg-[#62A0EA] light:bg-[#1A5FB4]"}`} aria-hidden="true" />
                          <div className="min-w-0 flex-1">
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs"><span className={`break-words ${category.color}`}>{category.label}{!item.isRead && <span className="ml-2 text-white/60 light:text-gray-500">Unread</span>}</span><time dateTime={item.createdAt} className="text-white/40 light:text-gray-400">{formatDate(item.createdAt)}</time></div>
                            <h3 className={`break-words text-sm font-semibold ${item.isRead ? "text-white/70 light:text-gray-600" : "text-white light:text-gray-900"}`}>{item.title}</h3>
                            <p className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-white/50 light:text-gray-500">{item.message}</p>
                          </div>
                          <ChevronRight size={16} className="mt-1 shrink-0 text-white/40 light:text-gray-400" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>

      {showReceiptScan && <ReceiptScanModal onClose={() => setShowReceiptScan(false)} />}
      <div ref={dialogRef} className="relative z-[100]">
        <Modal themed isOpen={showHelp} onClose={() => setShowHelp(false)}>
          <h2 className="pr-8 text-lg font-bold">How rewards work</h2>
          <ol className="mt-6 space-y-5 text-sm leading-relaxed text-white/60 light:text-gray-600">
            <li><h3 className="mb-1 font-semibold text-white light:text-gray-900">1. Complete paid rides</h3>GCash rides count automatically. For cash rides, scan the QR on your conductor&apos;s receipt. Each receipt can be claimed once within its claim window.</li>
            <li><h3 className="mb-1 font-semibold text-white light:text-gray-900">2. Earn a free ride</h3>Every {data?.ridesNeeded ?? 10} paid rides earns a voucher. Your progress then starts toward the next voucher.</li>
            <li><h3 className="mb-1 font-semibold text-white light:text-gray-900">3. Use it with GCash</h3>When you scan the conductor&apos;s GCash QR to pay, we offer your available voucher. Accept it to get the ride free or discounted; any remaining fare is paid by GCash.</li>
          </ol>
          <p className="mt-6 border-t border-white/10 pt-4 text-xs leading-relaxed text-white/60 light:border-gray-200 light:text-gray-500">Check each voucher&apos;s expiry date before riding. Free rides paid with vouchers do not count toward the next reward.</p>
        </Modal>
        <Modal themed isOpen={selectedAnnouncement !== null} onClose={() => setSelectedAnnouncement(null)} maxWidth="max-w-lg">
          {selectedAnnouncement && <>
            <p className={`pr-8 text-xs ${selectedCategory?.color}`}>{selectedCategory?.label}</p>
            <h2 className="mt-3 break-words pr-8 text-lg font-bold">{selectedAnnouncement.title}</h2>
            <p className="mt-2 text-xs text-white/50 light:text-gray-500">{formatDate(selectedAnnouncement.createdAt)}</p>
            <p className="mt-5 whitespace-pre-wrap break-words border-t border-white/10 pt-5 text-sm leading-relaxed text-white/70 light:border-gray-200 light:text-gray-600">{selectedAnnouncement.message}</p>
            {selectedAnnouncement.rawType?.startsWith('DISCOUNT_APPLICATION') && commuterProfile?.commuterType === 'REGULAR' && <Link href="/discount-application" onClick={() => setSelectedAnnouncement(null)} className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#1A5FB4] px-4 text-sm font-semibold text-white hover:bg-[#164A8F]">View discount application<ArrowRight size={16} aria-hidden="true" /></Link>}
            {selectedAnnouncement.rawType?.startsWith('STUDENT_RENEWAL') && <div className="mt-5 space-y-3"><Link href="/student-renewal" onClick={() => setSelectedAnnouncement(null)} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#1A5FB4] px-4 text-sm font-semibold text-white hover:bg-[#164A8F]">{renewal?.can_submit ? 'Renew student status' : 'View renewal status'}<ArrowRight size={16} aria-hidden="true" /></Link>{renewal?.can_switch_to_regular && renewal.status !== 'PENDING' && renewal.status !== 'APPROVED' && <Link href="/student-renewal#regular" onClick={() => setSelectedAnnouncement(null)} className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-white/20 px-4 text-sm light:border-gray-300 light:text-gray-700">No Longer a Student</Link>}</div>}
            {selectedAnnouncement.type === "VOUCHER" && <button type="button" onClick={() => { setSelectedAnnouncement(null); setSection("rewards"); setVoucherTab("available"); }} className="mt-5 min-h-11 w-full rounded-lg bg-[#1A5FB4] px-4 text-sm font-semibold text-white hover:bg-[#164A8F]">View vouchers</button>}
          </>}
        </Modal>
      </div>
    </div>
  );
}

function RenewalNotice({ renewal }: { renewal: RenewalState }) {
  const pending = renewal.status === "PENDING";
  const correction = renewal.status === "NEEDS_CORRECTION";
  const status = renewal.status === "NOT_RENEWED" ? "For renewal" : RENEWAL_LABELS[renewal.status];
  const statusColor = "text-white/85 light:text-gray-700";
  const title = pending ? "Your proof is being reviewed" : correction ? "Update your enrollment proof" : "Renew your student status";
  const description = pending
    ? "We’ll notify you when the review is complete. No need to submit again."
    : correction
      ? "Check the reviewer’s note and send corrected proof before your correction deadline."
      : "Have your current school ID or enrollment proof ready to continue your student discount.";
  const action = renewal.can_submit ? (correction ? "Submit corrected proof" : "Renew student status") : "View renewal status";
  const formatDeadline = (value: string) => new Date(value).toLocaleString("en-PH", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila",
  });
  const deadline = formatDeadline(renewal.deadline);

  // "What happens next" floats over the card at lg+, where it opens on mouse
  // hover and stays open once clicked. Below lg the text is too long to float
  // over a narrow card, so the same button expands it in place instead.
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const helpOpen = hovered || pinned;

  useEffect(() => {
    if (!helpOpen) return;
    const close = () => { setHovered(false); setPinned(false); };
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    // Only the floating panel dismisses on an outside press; collapsing the
    // in-place one would shift the page under the commuter's finger.
    const handlePointer = (event: PointerEvent) => {
      if (!window.matchMedia("(min-width: 1024px)").matches) return;
      if (!helpRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("pointerdown", handlePointer);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("pointerdown", handlePointer);
    };
  }, [helpOpen]);

  return (
    <section aria-labelledby="renewal-notice-title" className="mb-7 rounded-2xl border border-[#62A0EA]/30 bg-[#071A2E] light:border-[#1A5FB4]/30 light:bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="inline-flex items-center gap-2 text-xs font-medium text-[#99C1F1] light:text-[#1A5FB4]">
          <GraduationCap size={18} aria-hidden="true" /> Student renewal
        </p>
        <span className={`text-xs font-medium ${statusColor}`}>{status}</span>
      </div>
      {/* The wrapper holds both the icon and the panel, so the pointer stays
          inside the hover area on its way from one down to the other. */}
      <div ref={helpRef} className="relative mt-4" onPointerLeave={() => setHovered(false)}>
        <div className="flex gap-2">
          <h3 id="renewal-notice-title" className="text-lg font-semibold leading-snug sm:text-xl">{title}</h3>
          <button
            type="button"
            onClick={() => setPinned(value => !value)}
            onPointerEnter={event => { if (event.pointerType === "mouse" && window.matchMedia("(min-width: 1024px)").matches) setHovered(true); }}
            aria-label="What happens next"
            aria-expanded={helpOpen}
            aria-controls={helpOpen ? helpId : undefined}
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-white/5 hover:text-white light:hover:bg-gray-100 light:hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#99C1F1] ${helpOpen ? "bg-white/5 text-white light:bg-gray-100 light:text-gray-900" : "text-white/50 light:text-gray-500"}`}
          >
            <CircleHelp size={16} aria-hidden="true" />
          </button>
        </div>
        {helpOpen && (
          <div id={helpId} className="pt-3 lg:absolute lg:left-0 lg:top-full lg:z-20 lg:w-104 lg:pt-2">
            <div className="border-l border-white/15 pl-4 lg:rounded-xl lg:border lg:border-[#2A3A55] lg:bg-[#1A2540] lg:p-4 lg:shadow-2xl light:border-gray-200 light:lg:bg-white">
              <h4 className="text-sm font-medium">What happens next</h4>
              <ul className="mt-3 list-disc space-y-3 pl-4 text-xs leading-relaxed text-white/65 marker:text-white/35 light:text-gray-600 light:marker:text-gray-400">
                <li><span className="font-medium text-white/90 light:text-gray-900">Your discount: </span>{renewal.discount_eligible
                  ? <>You can still use it until {formatDeadline(renewal.discount_expires_at ?? renewal.deadline)} (Philippine time), unless your renewal is approved and extends it.</>
                  : "Regular fares apply until your renewal is approved."}</li>
                <li><span className="font-medium text-white/90 light:text-gray-900">If you miss the deadline: </span>Without proof submitted before {deadline} (Philippine time), your commuter type automatically changes to Regular. Your account stays active, and you can still submit proof afterward, for example if your school released it late. Regular fares apply until it is approved.</li>
                <li><span className="font-medium text-white/90 light:text-gray-900">If you submit on time: </span>You keep the Student type while your proof is reviewed. Once your current discount expires, Regular fares apply until approval.{correction && " Send any corrections before the correction deadline shown above."}</li>
              </ul>
            </div>
          </div>
        )}
      </div>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/65 light:text-gray-600">{description}</p>
      <dl className="my-5 grid gap-4 border-y border-white/10 py-4 light:border-gray-200 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-white/50 light:text-gray-500">Renewal period</dt>
          <dd className="mt-1 text-sm font-medium">{renewal.renewal_period}</dd>
          <dd className="mt-1 text-xs text-white/40 light:text-gray-400">Philippine time</dd>
        </div>
        <div>
          <dt className="text-xs text-white/50 light:text-gray-500">Student discount</dt>
          <dd className="mt-1 inline-flex items-center gap-2 text-sm font-medium">
            {renewal.discount_eligible
              ? <CheckCircle2 size={15} aria-hidden="true" className="shrink-0 text-white/60 light:text-gray-500" />
              : <Clock3 size={15} aria-hidden="true" className="shrink-0 text-white/60 light:text-gray-500" />}
            {renewal.discount_eligible ? "Available" : "Unavailable"}
          </dd>
        </div>
        {correction && renewal.application?.correction_due_at && <div className="sm:col-span-2">
          <dt className="text-xs text-white/50 light:text-gray-500">Correction deadline</dt>
          <dd className="mt-1 text-sm font-medium">{new Date(renewal.application.correction_due_at).toLocaleString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" })} (Philippine time)</dd>
        </div>}
      </dl>
      <Link href="/student-renewal" className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#1A5FB4] px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#164A8F] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#99C1F1] sm:w-auto">
        {action}<ArrowRight size={16} aria-hidden="true" />
      </Link>
    </section>
  );
}

function LoadingState({ label }: { label: string }) {
  return <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm text-white/60 light:text-gray-500"><Loader2 size={20} className="animate-spin" />{label}</div>;
}
