export type ItemCategory = "ALL" | "ACCESSORY" | "BAG" | "WALLET" | "GADGET" | "CLOTHING" | "DOCUMENT" | "OTHER";
/** Checked category filters; an empty list means "All" (no category filter). */
export type CategorySelection = Exclude<ItemCategory, "ALL">[];
/** Inclusive posted-date window ('YYYY-MM-DD', '' = open end). */
export type DateWindow = { from: string; to: string };
export type ClaimStatus = "NONE" | "PENDING" | "VALIDATED" | "REJECTED" | "RELEASED";
export type ClaimFilter = "ALL" | Exclude<ClaimStatus, "NONE">;
export type ViewTab = "ALL" | "WATCHLIST" | "MY_CLAIMS";
/** Posted-within filter; "ALL" means no limit (the default newest-first list). */
export type TimeRange = "ALL" | "today" | "week" | "month" | "year";

export interface LostItem {
  id: string;
  itemName: string;
  description: string;
  imageUrl: string;
  plateNumber: string;
  driverName: string;
  conductorName: string;
  estimatedTimeLost: string; 
  category: Exclude<ItemCategory, "ALL">;
  datePosted: string;
  /** All item photos (up to 3), thumbnail first. Optional so the static mock rows stay valid. */
  photos?: { id: string; url: string }[];
  /** Last day this unclaimed item stays listed; null once it has a claim. */
  claimableUntil?: string | null;
  /** The commuter's own latest claim (backend status), from the browse + watchlist lists. */
  myClaim?: { id: string; status: string } | null;
}

export interface ClaimData {
  /** The backend claim row id — needed to cancel (withdraw) the claim. */
  claimId: string;
  status: Exclude<ClaimStatus, "NONE">;
  proof: string;
  claimDate: string;
  reviewedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  releasedAt: string | null;
  rejectionReason: string | null;
  /** Where/when to collect the item — set by the admin when approving. */
  pickupLocation: string | null;
  pickupAt: string | null;
  pickupReminder: string | null;
  /** Approved but never collected by the pickup date, so the claim was closed automatically. */
  noShowAt: string | null;
  /** The claimed item (eager-loaded by GET /commuter/claims); null if deleted. */
  item: LostItem | null;
}

export interface PaginatedAPIResponse {
  items: LostItem[];
  totalPages: number;
  totalItems: number;
  currentPage: number;
}
