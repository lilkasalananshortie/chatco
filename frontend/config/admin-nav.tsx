import {
  Home,
  Receipt,
  Map,
  Package,
  BarChart3,
  Sliders,
  Users,
  FileText,
  Megaphone,
  History,
} from "lucide-react";
import { mdiJeepney } from "@mdi/js";
import type { ComponentType } from "react";

/* ─── Nav Item Interface ─── */

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

/** The jeepney glyph the live maps use for units, sized like a Lucide icon. */
export function JeepneyIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d={mdiJeepney} />
    </svg>
  );
}

/* ─── Desktop Sidebar Nav Groups ─── */

export const operationsNav: NavItem[] = [
  { href: "/admin-dashboard", label: "Dashboard", icon: Home },
  { href: "/remittance", label: "Remittance", icon: Receipt },
  { href: "/receipts", label: "Receipts", icon: FileText },
  { href: "/monitoring", label: "Monitoring", icon: Map },
];

export const managementNav: NavItem[] = [
  { href: "/vehicles", label: "Fleet Management", icon: JeepneyIcon },
  { href: "/lost-found", label: "Lost & Found", icon: Package },
  { href: "/announcements", label: "Updates Center", icon: Megaphone },
  { href: "/users", label: "User Management", icon: Users },
];

export const systemNav: NavItem[] = [
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/activity-logs", label: "Activity Logs", icon: History },
  { href: "/settings", label: "Settings", icon: Sliders },
];

/* ─── Mobile Bottom Nav ─── */

// Derived from the sidebar groups so both navs list modules in the same order:
// the first four sit in the tab bar, the rest in the More sheet.
const sidebarOrder: NavItem[] = [...operationsNav, ...managementNav, ...systemNav];

export const mobileMainItems: NavItem[] = sidebarOrder.slice(0, 4);

export const mobileMoreItems: NavItem[] = sidebarOrder.slice(4);

/* ─── Settings sub-routes (for active-state matching) ─── */

export const settingsSubRoutes = [
  "/settings/fare-matrix",
  "/settings/financial-rules",
  "/settings/voucher-generator",
  "/settings/safety-notifications",
  "/settings/receipt",
  "/settings/app-configuration",
  "/settings/operations-rules",
  "/settings/faq-management",
];
