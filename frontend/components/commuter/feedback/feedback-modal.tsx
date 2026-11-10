"use client";

import type { ComponentType, ReactNode } from "react";
import { X } from "lucide-react";

/**
 * Overlay + panel for the commuter feedback modals (QR scan and the scan
 * results that replace it in place). Overlays whatever page is open rather
 * than routing away from it. No backdrop-click-to-close — the scan step runs
 * a live camera, same convention as the GCash scan modal.
 */
export function FeedbackModalFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="animate-fade-in w-full max-w-sm max-h-[88vh] rounded-2xl border border-white/10 light:border-gray-200 shadow-2xl overflow-hidden"
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Header + scrolling body inside FeedbackModalFrame. The header matches the
 * QrScanner 'modal' variant's (bare icon, title, subtitle, close), so
 * swapping from the scanner to a result keeps the same chrome.
 */
export function FeedbackModalContent({
  icon: Icon,
  title,
  subtitle,
  onClose,
  children,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex max-h-[88vh] w-full flex-col overflow-hidden bg-[#050F1A] light:bg-white">
      <div className="flex items-center justify-between gap-4 border-b border-white/10 p-5 light:border-gray-200">
        <div className="flex items-center gap-3 min-w-0">
          <Icon size={24} className="text-[#62A0EA] light:text-[#1A5FB4] flex-shrink-0" />
          <div className="min-w-0">
            <h2 className="text-white font-bold text-lg light:text-gray-900 leading-tight">{title}</h2>
            <p className="text-white/40 text-xs mt-0.5 light:text-gray-500 truncate">{subtitle}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-white/40 hover:text-white transition-colors light:text-gray-400 light:hover:text-gray-900 flex-shrink-0"
          aria-label="Close"
        >
          <X size={20} />
        </button>
      </div>

      <div className="overflow-y-auto scrollbar-themed p-5 animate-fade-in">{children}</div>
    </div>
  );
}
