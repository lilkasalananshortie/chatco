// components/admin/ui/page-tabs.tsx
'use client';

import { useRef, type ComponentType, type KeyboardEvent } from 'react';

export type PageTabAccent = 'blue' | 'amber' | 'red';

export interface PageTab<T extends string> {
  id: T;
  label: string;
  count?: number;
  /** Any lucide icon, or a custom glyph taking the same props (e.g. admin-nav's JeepneyIcon). */
  icon: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  /** Underline/icon color when active. Blue by default; amber/red mark
   *  tabs whose content needs attention (pending, rejected, records). */
  accent?: PageTabAccent;
}

interface PageTabsProps<T extends string> {
  tabs: PageTab<T>[];
  activeId: T;
  onChange: (id: T) => void;
  className?: string;
}

const ACCENTS: Record<PageTabAccent, { bar: string; icon: string; count: string }> = {
  blue: { bar: 'bg-[#62A0EA] admin-light:bg-[#1A5FB4] light:bg-[#1A5FB4]', icon: 'text-[#62A0EA] admin-light:text-[#1A5FB4] light:text-[#1A5FB4]', count: 'bg-[#62A0EA]/15 admin-light:bg-[#1A5FB4]/10 text-[#8CB9F0] admin-light:text-[#1A5FB4] light:bg-[#1A5FB4]/10 light:text-[#1A5FB4]' },
  amber: { bar: 'bg-amber-400', icon: 'text-amber-300 admin-light:text-amber-700 light:text-amber-600', count: 'bg-amber-400/15 admin-light:bg-amber-500/15 text-amber-200 admin-light:text-amber-800 light:text-amber-700' },
  red: { bar: 'bg-red-400', icon: 'text-red-300 admin-light:text-red-700 light:text-red-600', count: 'bg-red-400/15 admin-light:bg-red-500/10 text-red-200 admin-light:text-red-700 light:text-red-700' },
};

/**
 * Page-level section tabs for admin screens (Fleet Management, User
 * Management): labels on a divider line, with the active tab marked by white
 * text and a 2px accent underline. Shared so the pages can't drift apart.
 *
 * Phones: tabs split the width evenly. From md up they size to their labels
 * and sit left-aligned. Arrow keys / Home / End move between tabs (ARIA
 * tablist pattern, activation follows focus).
 */
export function PageTabs<T extends string>({ tabs, activeId, onChange, className = '' }: PageTabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const next =
      event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
      : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(tabs[next].id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={onKeyDown}
      className={`flex w-full shrink-0 gap-1 overflow-x-auto border-b border-[#1E2D45] admin-light:border-[#E2E8F0] light:border-gray-200 scrollbar-themed ${className}`}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const accent = ACCENTS[tab.accent ?? 'blue'];
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`relative flex min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap px-3 pb-3 pt-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]/50 focus-visible:rounded-md md:flex-none md:px-4 ${
              isActive ? 'text-white admin-light:text-slate-900 light:text-gray-900' : 'text-slate-400 admin-light:text-slate-500 hover:text-slate-200 admin-light:hover:text-slate-700 light:text-gray-500 light:hover:text-gray-900'
            }`}
          >
            <tab.icon size={16} aria-hidden="true" className={isActive ? accent.icon : 'text-slate-500 light:text-gray-400'} />
            <span className="truncate">{tab.label}</span>
            {tab.count !== undefined && (
              <span
                className={`rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums ${
                  isActive ? accent.count : 'bg-[#1A2540] admin-light:bg-[#EEF2F7] text-slate-500 light:bg-gray-100 light:text-gray-500'
                }`}
              >
                {tab.count}
              </span>
            )}
            <span
              aria-hidden="true"
              className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-opacity ${accent.bar} ${
                isActive ? 'opacity-100' : 'opacity-0'
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}
