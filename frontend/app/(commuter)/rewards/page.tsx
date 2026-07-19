// app/(commuter)/rewards/page.tsx
"use client";

import { useState } from "react";
import { useRewards } from "./use-rewards";
import { useAnnouncements } from "../announcements/use-announcements";
import { Voucher, AnnouncementType, Announcement } from "./types";

// Each category gets a catchy emoji + colour so announcements pop in the feed.
const announcementConfig: Record<AnnouncementType, { color: string; bg: string; label: string; emoji: string }> = {
  PROMO: { color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20", label: "Promo", emoji: "🎉" },
  SAFETY: { color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", label: "Safety", emoji: "🛡️" },
  SYSTEM: { color: "text-[#62A0EA]", bg: "bg-[#1A5FB4]/10 border-[#1A5FB4]/20", label: "System", emoji: "🔔" },
  MAINTENANCE: { color: "text-red-400", bg: "bg-red-500/10 border-red-500/20", label: "Advisory", emoji: "🚧" },
};

function formatRelativeTime(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function RewardsPage() {
  const { 
    data, isLoading: rewardsLoading, progressPercent, ridesRemaining, 
    showVoucherModal, setShowVoucherModal, activeVoucher, redeemVoucher
  } = useRewards();

  const {
    announcements, isLoading: announcementsLoading, markAsRead, markAllAsRead, unreadCount
  } = useAnnouncements();

  // The announcement currently expanded in the overlay modal (null = closed).
  const [selectedAnnouncement, setSelectedAnnouncement] = useState<Announcement | null>(null);

  // Open the full-detail modal + mark the item as read in one tap.
  const openAnnouncement = (item: Announcement) => {
    markAsRead(item.id);
    setSelectedAnnouncement(item);
  };

  if (rewardsLoading || announcementsLoading || !data) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-[#050F1A]">
        <div className="w-8 h-8 border-2 border-white/20 border-t-[#62A0EA] rounded-full animate-spin" />
      </div>
    );
  }

  const getStatusColor = (status: Voucher["status"]) => {
    switch (status) {
      case "AVAILABLE": return "border-emerald-500/30 bg-emerald-500/10 text-emerald-400";
      case "ACTIVE": return "border-amber-500/30 bg-amber-500/10 text-amber-400";
      case "USED": return "border-white/10 bg-white/5 text-white/30";
      case "EXPIRED": return "border-red-500/30 bg-red-500/10 text-red-400";
      default: return "";
    }
  };

  return (
    <div className="h-full w-full bg-[#050F1A] overflow-y-auto pb-28 lg:pb-8">
      <div className="max-w-4xl mx-auto p-6 lg:p-8 space-y-8">
        
        {/* --- HEADER --- */}
        <div>
          <h1 className="text-white font-bold text-2xl">Rewards & Updates</h1>
          <p className="text-white/40 text-sm mt-1">Your perks, progress, and latest alerts.</p>
        </div>

        {/* --- 1. ANNOUNCEMENTS SECTION --- */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white/70 uppercase tracking-wider">Latest Updates</h3>
            {unreadCount > 0 && (
              <button onClick={markAllAsRead} className="text-xs font-semibold text-[#62A0EA] hover:text-white transition-colors">
                Mark all read
              </button>
            )}
          </div>

          <div className="space-y-3">
            {announcements.slice(0, 3).map((item) => {
              const config = announcementConfig[item.type];
              return (
                <div
                  key={item.id}
                  onClick={() => openAnnouncement(item)}
                  className={`relative bg-[#071A2E] border rounded-xl p-4 transition-all duration-300 cursor-pointer hover:bg-[#0B1E33] ${item.isRead ? 'border-white/5 opacity-60' : 'border-white/10 shadow-lg shadow-black/20'}`}
                >
                  {!item.isRead && (
                    <div className="absolute top-4 right-4 w-2 h-2 rounded-full bg-[#62A0EA]" />
                  )}
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${config.bg} ${config.color}`}>
                      <span className="text-[11px] leading-none">{config.emoji}</span>
                      {config.label}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className={`text-sm font-bold ${item.isRead ? 'text-white/60' : 'text-white'}`}>{item.title}</h4>
                      <p className="text-xs text-white/40 leading-relaxed mt-0.5 line-clamp-2">{item.message}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* --- 2. PROGRESS RING SECTION --- */}
        <div className="bg-[#071A2E] border border-white/10 rounded-2xl p-8 flex flex-col md:flex-row items-center gap-8 shadow-xl shadow-black/20">
          <div className="relative w-48 h-48 flex-shrink-0">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="8" />
              <circle 
                cx="50" cy="50" r="40" fill="none" 
                stroke={progressPercent === 100 ? "#10B981" : "#1A5FB4"} 
                strokeWidth="8" 
                strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 40}`} 
                strokeDashoffset={`${2 * Math.PI * 40 * (1 - progressPercent / 100)}`}
                className="transition-all duration-1000 ease-out"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-3xl font-extrabold text-white">{data.currentCycleRides}</span>
              <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">of {data.ridesNeeded} rides</span>
            </div>
          </div>

          <div className="flex-1 text-center md:text-left">
            <h2 className="text-white font-bold text-xl mb-2">
              {ridesRemaining === 0 ? "Free Ride Unlocked! 🎉" : `${ridesRemaining} Rides to Free Ride`}
            </h2>
            <p className="text-white/40 text-sm mb-6">
              Complete {data.ridesNeeded} cashless rides to earn a free ride voucher. Your total completed rides: <span className="text-[#62A0EA] font-bold">{data.totalRides}</span>.
            </p>
            <div className="flex gap-3 justify-center md:justify-start">
              <div className="bg-[#050F1A] border border-white/10 rounded-xl px-4 py-3 text-center">
                <p className="text-[10px] text-white/40 uppercase font-semibold">Total Rides</p>
                <p className="text-lg font-bold text-white">{data.totalRides}</p>
              </div>
              <div className="bg-[#050F1A] border border-white/10 rounded-xl px-4 py-3 text-center">
                <p className="text-[10px] text-white/40 uppercase font-semibold">Vouchers Available</p>
                <p className="text-lg font-bold text-emerald-400">{data.vouchers.filter(v => v.status === "AVAILABLE").length}</p>
              </div>
            </div>
          </div>
        </div>

        {/* --- 3. VOUCHERS LIST --- */}
        <div>
          <h3 className="text-sm font-bold text-white/70 uppercase tracking-wider mb-4">My Vouchers</h3>
          <div className="space-y-4">
            {data.vouchers.map(voucher => (
              <div key={voucher.id} className={`border rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 transition-all ${getStatusColor(voucher.status)}`}>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center border border-white/10">
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 11.25v8.25a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 109.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1114.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" /></svg>
                  </div>
                  <div>
                    <h4 className="font-bold text-base">Free Ride Voucher</h4>
                    <p className="text-xs opacity-70 mt-0.5">Source: {voucher.rideOrigin} • Exp: {new Date(voucher.expiresAt).toLocaleDateString()}</p>
                  </div>
                </div>

                <div>
                  {voucher.status === "AVAILABLE" && (
                    <button 
                      onClick={() => redeemVoucher(voucher.id)}
                      className="bg-[#FF6D3A] hover:bg-[#e55a2b] text-white text-sm font-bold py-2.5 px-6 rounded-xl shadow-lg shadow-[#FF6D3A]/30 transition-colors"
                    >
                      Use Voucher
                    </button>
                  )}
                  {voucher.status === "ACTIVE" && (
                    <span className="text-sm font-bold uppercase tracking-wider animate-pulse">Active - Show to Conductor</span>
                  )}
                  {voucher.status === "USED" && (
                    <span className="text-sm font-bold uppercase tracking-wider opacity-50">Redeemed</span>
                  )}
                </div>
              </div>
            ))}

            {data.vouchers.length === 0 && (
              <div className="text-center py-12 bg-[#071A2E] rounded-2xl border border-white/10">
                <p className="text-white/40 text-sm">No vouchers yet. Keep riding to earn your first free ride!</p>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* --- ACTIVE VOUCHER MODAL --- */}
      {showVoucherModal && activeVoucher && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={() => setShowVoucherModal(false)}>
          <div className="bg-[#071A2E] w-full max-w-sm rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="p-6 text-center border-b border-white/10">
              <h2 className="text-white font-bold text-xl">Voucher Activated!</h2>
              <p className="text-white/40 text-xs mt-1">Show this screen to the conductor</p>
            </div>
            <div className="p-8 flex flex-col items-center justify-center flex-1 bg-[#050F1A]">
              <div className="w-40 h-40 bg-white rounded-xl flex items-center justify-center shadow-lg mb-4">
                <div className="grid grid-cols-5 gap-1 w-24 h-24">
                  {Array.from({length: 25}).map((_, i) => (
                    <div key={i} className={`w-full h-full rounded-sm ${Math.random() > 0.3 ? 'bg-black' : 'bg-white'}`}></div>
                  ))}
                </div>
              </div>
              <p className="text-emerald-400 font-extrabold text-lg tracking-widest mt-2">{activeVoucher}</p>
            </div>
            <div className="p-4 border-t border-white/10">
              <button onClick={() => setShowVoucherModal(false)} className="w-full bg-white/5 hover:bg-white/10 text-white/70 text-sm font-semibold py-3 rounded-xl border border-white/10 transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* --- ANNOUNCEMENT DETAIL MODAL --- */}
      {selectedAnnouncement && (() => {
        const config = announcementConfig[selectedAnnouncement.type];
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={() => setSelectedAnnouncement(null)}>
            <div className="bg-[#071A2E] w-full max-w-md rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden max-h-[85vh]" onClick={e => e.stopPropagation()}>
              <div className="p-6 border-b border-white/10">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border ${config.bg} ${config.color}`}>
                    <span className="text-sm leading-none">{config.emoji}</span>
                    {config.label}
                  </div>
                  <span className="text-[11px] text-white/40">{formatRelativeTime(selectedAnnouncement.createdAt)}</span>
                </div>
                <h2 className="text-white font-bold text-lg leading-tight">{selectedAnnouncement.title}</h2>
              </div>
              <div className="p-6 overflow-y-auto">
                <p className="text-sm text-white/70 leading-relaxed whitespace-pre-wrap wrap-break-word">
                  {selectedAnnouncement.message}
                </p>
              </div>
              <div className="p-4 border-t border-white/10">
                <button onClick={() => setSelectedAnnouncement(null)} className="w-full bg-white/5 hover:bg-white/10 text-white/70 text-sm font-semibold py-3 rounded-xl border border-white/10 transition-colors">Close</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}