// lib/shared/remittance-status.ts
//
// Single source of truth for RemittanceStatus → Badge color, replacing the
// ad-hoc ternaries previously duplicated across remittance-table.tsx,
// conductor-detail-modal.tsx, and the conductor's HistorySection/
// OfficialReportModal — all of which need to agree once a 6th status
// ("For Cash Declaration") exists.

import type { RemittanceStatus } from "@/types";
import type { BadgeVariant } from "@/components/shared/badge";

export function remittanceStatusVariant(status: RemittanceStatus): BadgeVariant {
  switch (status) {
    case "Settled":
      return "success";
    case "For Cash Declaration":
      return "info";
    case "Pending":
    case "Not Remitted":
    case "Overdue":
      return "warning";
    case "Shortage":
    case "Overage":
      return "danger";
  }
}
