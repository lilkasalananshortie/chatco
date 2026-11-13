"use client";

import Link from "next/link";
import { useConductorShift } from "@/app/(conductor)/hooks/use-conductor-shift";
import { useConductorProfile } from "@/app/(conductor)/hooks/use-conductor-profile";
import { ConductorAvatar } from "@/components/conductor/conductor-avatar";

const navItems = [
  { href: "/conductor-dashboard", label: "Dashboard", icon: "M2.25 12l8.954-8.955a1.126 1.126 0 0 1 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" },
  { href: "/conductor-dashboard/end-of-day", label: "End-of-Day Tally & Report", icon: "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" },
  { href: "/conductor-dashboard/metrics", label: "Driver Performance Metrics", icon: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" },
  { href: "/conductor-dashboard/conductor-settings", label: "Settings", icon: "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" },
];

// Payment icon SVG path for the special Payment button
const paymentIconPath = "M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z";

export default function ConductorSidebar({ pathname }: { pathname: string }) {
  const { shift } = useConductorShift();
  const conductorName = shift?.conductorName ?? "Conductor";
  const conductorPhotoUrl = useConductorProfile()?.photoUrl ?? null;
  const statusLabel = shift?.isActive ? "Shift Active" : "No Active Shift";

  return (
    <aside className="w-64 bg-[#071A2E] flex flex-col border-r border-white/10 light:bg-white light:border-gray-200">
      {/* Logo / Header */}
      <div className="h-20 flex items-center px-6 border-b border-white/10 light:border-gray-200">
        <h1 className="text-white light:text-gray-900 font-bold text-xl tracking-tight">E-CHATCO<span className="text-[#62A0EA] light:text-[#1A5FB4]">.</span></h1>
      </div>

      {/* Nav Links */}
      <nav className="flex-1 px-4 py-6 space-y-2">
        {/* Dashboard link */}
        <Link
          href={navItems[0].href}
          className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
            pathname === navItems[0].href
              ? "bg-[#1A5FB4] text-white"
              : "text-white/50 hover:text-white hover:bg-white/5 light:text-gray-500 light:hover:text-gray-900 light:hover:bg-gray-100"
          }`}
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d={navItems[0].icon} />
          </svg>
          <span className="font-medium text-sm leading-tight">{navItems[0].label}</span>
        </Link>

        {/* Payment button (dispatches event, not a link) */}
        <button
          onClick={() => {
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("conductor:open-payment"));
            }
          }}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 cursor-pointer text-white/50 hover:text-white hover:bg-white/5 light:text-gray-500 light:hover:text-gray-900 light:hover:bg-gray-100"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d={paymentIconPath} />
          </svg>
          <span className="font-medium text-sm leading-tight">Payment</span>
        </button>

        {/* Remaining nav links */}
        {navItems.slice(1).map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
                isActive
                  ? "bg-[#1A5FB4] text-white"
                  : "text-white/50 hover:text-white hover:bg-white/5 light:text-gray-500 light:hover:text-gray-900 light:hover:bg-gray-100"
              }`}
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
              </svg>
              <span className="font-medium text-sm leading-tight">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* User Info Footer */}
      <div className="p-4 border-t border-white/10 light:border-gray-200">
        <div className="flex items-center gap-3 px-2">
          <ConductorAvatar src={conductorPhotoUrl} className="w-10 h-10" iconClassName="w-5 h-5" sizes="40px" />
          <div className="min-w-0">
            <p className="text-white light:text-gray-900 text-sm font-semibold truncate">{conductorName}</p>
            <p className="text-white/40 light:text-gray-500 text-xs">{statusLabel}</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
