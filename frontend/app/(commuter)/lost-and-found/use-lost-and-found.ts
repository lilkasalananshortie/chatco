import { useState, useEffect, useCallback, useRef } from "react";
import { ItemCategory, CategorySelection, ClaimFilter, ClaimStatus, DateWindow, LostItem, ClaimData, PaginatedAPIResponse, TimeRange, ViewTab } from "./types";
import { CLAIMS_PER_PAGE, ITEMS_PER_PAGE, categories as CATEGORY_OPTIONS } from "./data";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { RequestCancelledError } from "@/lib/api/client";
import {
  list as listItems,
  claim as claimItem,
  myClaims as fetchMyClaims,
  cancelClaim as apiCancelClaim,
  myWatchlist as fetchMyWatchlist,
  watch as apiWatch,
  unwatch as apiUnwatch,
  LostFoundOperationError,
  type BackendClaimStatus,
  type LostFoundItem,
  type LostFoundTimeRange,
} from "@/lib/shared/services/lost-found.service";

/** Server-side cap on `per_page` for Lost & Found list endpoints (see LostItemController). */
const MAX_PER_PAGE = 50;
/** Sanity ceiling on how many watchlist pages loadWatchlistIds() will walk, so a
 *  backend bug (e.g. lastPage that never converges) can't spin this into an
 *  infinite loop. 500 pages at MAX_PER_PAGE is 25,000 watchlisted items — far
 *  beyond any realistic commuter's list. */
const MAX_WATCHLIST_PAGES = 500;

/**
 * Sprint 6 (S6-T8) — Commuter Lost & Found hook, fully DB-backed.
 *
 *   list()        → GET    /api/v1/lost-found (paginated, categories[]/search/date_from/date_to/range)
 *   claim()       → POST   /api/v1/lost-found/{id}/claim (proof of ownership)
 *   myClaims()    → GET    /api/v1/commuter/claims (item eager-loaded)
 *   cancelClaim() → DELETE /api/v1/lost-found/claims/{claimId}
 *   myWatchlist() → GET    /api/v1/commuter/watchlist (paginated)
 *   watch()       → POST   /api/v1/lost-found/{id}/watchlist
 *   unwatch()     → DELETE /api/v1/lost-found/{id}/watchlist
 *
 * ALL state that matters lives in the database:
 *   - Claims (badges, "My Claims" tab, cancel) come from
 *     GET /commuter/claims — they survive reloads and follow the commuter
 *     across devices. Cancel actually deletes the claim row server-side.
 *   - The watchlist is persisted per commuter; the heart toggle is optimistic
 *     (flips immediately, reverts if the API call fails).
 *
 * Tabs:
 *   ALL       → server-paginated browse list
 *   WATCHLIST → server-paginated GET /commuter/watchlist
 *   MY_CLAIMS → server-paginated GET /commuter/claims
 * Every tab sends categories/date window/range/search to the server, so
 * pagination always matches what's shown.
 *
 * Claim status mapping (backend → UI): PENDING→PENDING, APPROVED→VALIDATED,
 * REJECTED→REJECTED. When a commuter has several claims on one item (e.g.
 * re-claimed after a rejection), the NEWEST claim wins.
 */
export function useLostAndFound() {
  const [activeTab, setActiveTab] = useState<ViewTab>("ALL");
  // Checked categories; empty = "All". Kept in display order so an equal
  // selection is an equal list.
  const [activeCategories, setActiveCategories] = useState<CategorySelection>([]);
  const [claimFilter, setClaimFilter] = useState<ClaimFilter>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  // The input stays bound to `searchQuery` for instant keystroke feedback;
  // fetches key off the debounced value so typing doesn't fire a request
  // (and DB query) per keystroke.
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 400);
  // Posted-date window (start/end pickers). Either end may be open.
  const [dateWindow, setDateWindow] = useState<DateWindow>({ from: "", to: "" });
  // Posted-within window ("ALL" = no limit, the default newest-first list).
  // Mutually exclusive with `dateWindow`; see the handlers below.
  const [timeRange, setTimeRange] = useState<TimeRange>("ALL");
  const [currentPage, setCurrentPage] = useState(1);

  const [showClaimModal, setShowClaimModal] = useState(false);
  const [itemToClaim, setItemToClaim] = useState<LostItem | null>(null);
  const [proofText, setProofText] = useState("");
  const [proofImages, setProofImages] = useState<File[]>([]);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [isSubmittingClaim, setIsSubmittingClaim] = useState(false);
  // Cancel-claim confirmation flow: `claimToCancel` (an item id) drives the
  // confirmation modal — non-null means it's open for that item.
  // `isCancellingClaim` is true only once the user has confirmed and the
  // DELETE request + claims reload are actually in flight; it gates both
  // modal buttons so a rapid double-click on "Yes, Cancel Claim" can't fire
  // two requests. `cancelToast` is the post-success notification.
  const [claimToCancel, setClaimToCancel] = useState<string | null>(null);
  const [isCancellingClaim, setIsCancellingClaim] = useState(false);
  const [cancelToast, setCancelToast] = useState<string | null>(null);

  // DB-backed: watchlisted item ids (for the card hearts) + the commuter's
  // current claims page keyed by item id. Claims are loaded page-by-page.
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [claims, setClaims] = useState<Map<string, ClaimData>>(new Map());
  const [claimPageData, setClaimPageData] = useState({ totalPages: 1, totalItems: 0, currentPage: 1 });
  // Bumped after a claim or cancel to refetch the open tab, so its cards and
  // claims come back from the DB instead of being patched locally.
  const [reloadKey, setReloadKey] = useState(0);

  const [apiData, setApiData] = useState<PaginatedAPIResponse>({ items: [], totalPages: 1, totalItems: 0, currentPage: 1 });
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const toBackendClaimStatus = (filter: ClaimFilter): BackendClaimStatus | undefined => {
    if (filter === "PENDING") return "PENDING";
    if (filter === "VALIDATED") return "APPROVED";
    if (filter === "REJECTED") return "REJECTED";
    if (filter === "RELEASED") return "RELEASED";
    return undefined;
  };

  /** Reload one page of the commuter's own claims from the DB. */
  const loadClaims = useCallback(async (page = currentPage, filter = claimFilter, posted = dateWindow, search = debouncedSearchQuery, range = timeRange, cats = activeCategories, signal?: AbortSignal) => {
    setIsLoading(true);
    setListError(null);
    try {
      const result = await fetchMyClaims({
        page,
        perPage: CLAIMS_PER_PAGE,
        status: toBackendClaimStatus(filter),
        dateFrom: posted.from || undefined,
        dateTo: posted.to || undefined,
        search: search.trim() || undefined,
        range: toBackendRange(range),
        categories: cats,
        signal,
      });
      const next = new Map<string, ClaimData>();
      // Rows are newest-first. Keep one visible card state per item on this page.
      for (const row of result.claims) {
        if (next.has(row.itemId)) continue;
        next.set(row.itemId, {
          claimId: row.id,
          status: toUiClaimStatus(row.status),
          proof: row.proof,
          claimDate: row.claimDate,
          reviewedAt: row.reviewedAt,
          approvedAt: row.approvedAt,
          rejectedAt: row.rejectedAt,
          releasedAt: row.releasedAt,
          rejectionReason: row.rejectionReason,
          pickupLocation: row.pickupLocation,
          pickupAt: row.pickupAt,
          pickupReminder: row.pickupReminder,
          noShowAt: row.noShowAt,
          item: row.item ? mapServiceItemToViewModel(row.item) : null,
        });
      }
      setClaims(next);
      setClaimPageData({
        totalPages: result.lastPage,
        totalItems: result.total,
        currentPage: result.page,
      });
      setIsLoading(false);
    } catch (err) {
      // A stale request cancelled in favor of a newer one — the newer
      // request owns isLoading/listError/claims from here, don't touch them.
      if (err instanceof RequestCancelledError) return;
      setListError("Unable to load your claims.");
      setClaims(new Map());
      setClaimPageData({ totalPages: 1, totalItems: 0, currentPage: page });
      setIsLoading(false);
    }
  }, [claimFilter, currentPage, dateWindow, debouncedSearchQuery, timeRange, activeCategories]);

  // Flips true once fetchWatchlistItems() has returned a result whose single
  // page already covers the whole watchlist (lastPage === 1) — at that point
  // we already hold the complete id set and the walk below would just be
  // re-fetching the same rows, so it's skipped/stopped instead.
  const watchlistCompleteRef = useRef(false);

  /**
   * Reload the watchlisted item ids from the DB (for the card hearts).
   * Walks every page rather than assuming a fixed ceiling fits everyone —
   * a commuter with a very large watchlist still gets correct heart state.
   */
  const loadWatchlistIds = useCallback(async () => {
    if (watchlistCompleteRef.current) return;
    try {
      const ids = new Set<string>();
      let page = 1;
      let lastPage = 1;
      do {
        if (watchlistCompleteRef.current) return;
        const result = await fetchMyWatchlist({ page, perPage: MAX_PER_PAGE });
        for (const item of result.items) ids.add(item.id);
        lastPage = result.lastPage;
        page += 1;
      } while (page <= lastPage && page <= MAX_WATCHLIST_PAGES);
      if (!watchlistCompleteRef.current) setWatchlist(ids);
    } catch {
      // Non-fatal: hearts render unfilled until the next reload.
    }
  }, []);

  useEffect(() => { void loadWatchlistIds(); }, [loadWatchlistIds]);

  const fetchLostItems = useCallback(async (page: number, limit: number, cats: CategorySelection, search: string, posted: DateWindow, range: TimeRange, signal?: AbortSignal) => {
    setIsLoading(true);
    setListError(null);
    try {
      const result = await listItems({
        page,
        perPage: limit,
        categories: cats,
        search: search.trim() || undefined,
        dateFrom: posted.from || undefined,
        dateTo: posted.to || undefined,
        range: toBackendRange(range),
        signal,
      });
      const items = result.items.map(mapServiceItemToViewModel);
      setApiData({
        items,
        totalPages: result.lastPage,
        totalItems: result.total,
        currentPage: result.page,
      });
      // The page itself says which items this commuter has claimed, so the
      // card buttons are right after a refresh, not only after claiming.
      setClaims(claimsFromItems(items));
      setIsLoading(false);
    } catch (err) {
      if (err instanceof RequestCancelledError) return;
      setListError(err instanceof LostFoundOperationError ? err.message : "Unable to load items.");
      setApiData({ items: [], totalPages: 1, totalItems: 0, currentPage: page });
      setIsLoading(false);
    }
  }, []);

  const fetchWatchlistItems = useCallback(async (page: number, limit: number, posted: DateWindow, search: string, range: TimeRange, cats: CategorySelection, signal?: AbortSignal) => {
    setIsLoading(true);
    setListError(null);
    try {
      const result = await fetchMyWatchlist({
        page,
        perPage: limit,
        dateFrom: posted.from || undefined,
        dateTo: posted.to || undefined,
        search: search.trim() || undefined,
        range: toBackendRange(range),
        categories: cats,
        signal,
      });
      const items = result.items.map(mapServiceItemToViewModel);
      setApiData({
        items,
        totalPages: result.lastPage,
        totalItems: result.total,
        currentPage: result.page,
      });
      setClaims(claimsFromItems(items));
      // This page came straight from the watchlist endpoint, so every item
      // on it is watched by definition — keep the heart id-set in sync.
      // Only an unfiltered single page is the whole watchlist; a filtered
      // one is a subset, so it may only add ids, never replace the set.
      const isUnfiltered = cats.length === 0 && range === "ALL" && !posted.from && !posted.to && !search.trim();
      if (result.lastPage === 1 && isUnfiltered) {
        // This one page IS the entire watchlist — it's now the authoritative
        // full set, making the separate multi-page walk in loadWatchlistIds()
        // redundant, so stop/skip it rather than re-fetching the same rows.
        watchlistCompleteRef.current = true;
        setWatchlist(new Set(result.items.map(item => item.id)));
      } else {
        setWatchlist(prev => {
          const next = new Set(prev);
          for (const item of result.items) next.add(item.id);
          return next;
        });
      }
      setIsLoading(false);
    } catch (err) {
      if (err instanceof RequestCancelledError) return;
      setListError(err instanceof LostFoundOperationError ? err.message : "Unable to load your bookmarks.");
      setApiData({ items: [], totalPages: 1, totalItems: 0, currentPage: page });
      setIsLoading(false);
    }
  }, []);

  // Cancels the in-flight list request whenever the tab/filters change again
  // (or the component unmounts) before it resolves, so a slow earlier
  // response can never land after a faster later one and overwrite it with
  // stale data.
  useEffect(() => {
    const controller = new AbortController();
    if (activeTab === "MY_CLAIMS") {
      void loadClaims(currentPage, claimFilter, dateWindow, debouncedSearchQuery, timeRange, activeCategories, controller.signal);
    } else if (activeTab === "WATCHLIST") {
      void fetchWatchlistItems(currentPage, ITEMS_PER_PAGE, dateWindow, debouncedSearchQuery, timeRange, activeCategories, controller.signal);
    } else {
      void fetchLostItems(currentPage, ITEMS_PER_PAGE, activeCategories, debouncedSearchQuery, dateWindow, timeRange, controller.signal);
    }
    return () => controller.abort();
  }, [activeTab, fetchLostItems, fetchWatchlistItems, loadClaims, currentPage, activeCategories, claimFilter, debouncedSearchQuery, dateWindow, timeRange, reloadKey]);

  const handleTabChange = (tab: ViewTab) => { setActiveTab(tab); setActiveCategories([]); setSearchQuery(""); setDateWindow({ from: "", to: "" }); setTimeRange("ALL"); setCurrentPage(1); };
  /**
   * Checkbox toggle. "All" clears every specific box; checking a specific
   * box drops "All". Unchecking the last box, or checking every specific
   * one, falls back to "All" (same result, and it also keeps items with no
   * category, which a full category list would leave out).
   */
  const handleCategoryToggle = (cat: ItemCategory) => {
    setActiveCategories(prev => {
      if (cat === "ALL") return [];
      const next = prev.includes(cat) ? prev.filter(value => value !== cat) : [...prev, cat];
      if (next.length === ALL_SPECIFIC_CATEGORIES.length) return [];
      return ALL_SPECIFIC_CATEGORIES.filter(value => next.includes(value));
    });
    setCurrentPage(1);
  };
  const handleClaimFilterChange = (filter: ClaimFilter) => { setClaimFilter(filter); setCurrentPage(1); };
  const handleSearch = (val: string) => { setSearchQuery(val); setCurrentPage(1); };
  // A posted-date window and a posted-within range would AND together into
  // either a redundant or an empty result, so picking one clears the other.
  // The pickers' min/max keep start <= end; the backend rejects it otherwise.
  const handleDateWindowChange = (end: keyof DateWindow, date: string) => {
    setDateWindow(prev => ({ ...prev, [end]: date }));
    if (date) setTimeRange("ALL");
    setCurrentPage(1);
  };
  const clearDateWindow = () => { setDateWindow({ from: "", to: "" }); setCurrentPage(1); };
  const handleTimeRangeChange = (range: TimeRange) => { setTimeRange(range); if (range !== "ALL") setDateWindow({ from: "", to: "" }); setCurrentPage(1); };

  /**
   * Instant search feedback while the debounced server search catches up.
   * Category is NOT filtered here: every tab sends it to the server, so the
   * page and its pagination already match it (filtering a fetched page
   * client-side would leave short pages and wrong page counts).
   */
  const matchesLocalFilters = (item: LostItem): boolean => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const fields = [
        item.itemName,
        item.description,
        item.plateNumber,
        item.driverName,
        item.conductorName,
      ];
      if (!fields.some((field) => field.toLowerCase().includes(q))) return false;
    }
    return true;
  };

  const displayItems: LostItem[] =
    activeTab === "MY_CLAIMS"
      ? Array.from(claims.values())
          .map(claim => claim.item)
          .filter((item): item is LostItem => item !== null)
          .filter(matchesLocalFilters)
      : activeTab === "WATCHLIST"
        ? apiData.items.filter(matchesLocalFilters)
        : apiData.items;

  const displayClaims: ClaimData[] = Array.from(claims.values())
    .filter(claim => claim.item ? matchesLocalFilters(claim.item) : true);

  /**
   * Optimistic watchlist toggle, persisted to the DB. The heart flips
   * immediately; if the API call fails the flip is reverted. On the
   * WATCHLIST tab, removing an item also refetches the tab's list.
   */
  const toggleWatchlist = (id: string) => {
    const wasWatched = watchlist.has(id);
    setWatchlist(prev => { const next = new Set(prev); if (wasWatched) next.delete(id); else next.add(id); return next; });
    void (async () => {
      try {
        if (wasWatched) await apiUnwatch(id);
        else await apiWatch(id);
        if (activeTab === "WATCHLIST") void fetchWatchlistItems(currentPage, ITEMS_PER_PAGE, dateWindow, debouncedSearchQuery, timeRange, activeCategories);
      } catch {
        // Revert the optimistic flip.
        setWatchlist(prev => { const next = new Set(prev); if (wasWatched) next.add(id); else next.delete(id); return next; });
      }
    })();
  };

  const openClaimModal = (item: LostItem) => {
    setItemToClaim(item);
    setProofText("");
    setProofImages([]);
    setClaimError(null);
    setShowClaimModal(true);
  };

  /**
   * Submit the claim to POST /api/v1/lost-found/{id}/claim, then reload the
   * claims map from the DB (server truth — carries the claimId needed for
   * cancel). On 409 → inline "Item already claimed"; 422 → inline validation.
   */
  const submitClaim = async (): Promise<boolean> => {
    if (!itemToClaim || !proofText.trim()) return false;
    setIsSubmittingClaim(true);
    setClaimError(null);
    try {
      await claimItem(itemToClaim.id, { proof: proofText.trim(), images: proofImages });
      setReloadKey((key) => key + 1);
      setShowClaimModal(false);
      return true;
    } catch (err) {
      if (err instanceof LostFoundOperationError) {
        // 409 → "Item already claimed". 422 → a claim rule with its own
        // message (proof validation, "You already have a claim on this item.").
        setClaimError(err.code === "conflict" ? "Item already claimed" : err.message);
        // The item may have changed under this card (e.g. claimed in another tab).
        setReloadKey((key) => key + 1);
      } else {
        setClaimError(err instanceof Error ? err.message : "Unable to submit claim.");
      }
      return false;
    } finally {
      setIsSubmittingClaim(false);
    }
  };

  // Success toast auto-dismisses so it doesn't linger on screen.
  useEffect(() => {
    if (!cancelToast) return;
    const timer = setTimeout(() => setCancelToast(null), 2500);
    return () => clearTimeout(timer);
  }, [cancelToast]);

  /** Open the "Cancel this claim?" confirmation modal for an item. */
  const requestCancelClaim = (itemId: string) => {
    if (isCancellingClaim) return;
    setClaimToCancel(itemId);
  };

  /** Dismiss the confirmation modal without cancelling anything. */
  const closeCancelClaimModal = () => {
    if (isCancellingClaim) return;
    setClaimToCancel(null);
  };

  /**
   * Withdraw a PENDING claim — DELETE /lost-found/claims/{claimId} deletes
   * the row server-side, then the claims map is reloaded from the DB. If the
   * cancel fails (e.g. the admin approved it moments ago), reload anyway so
   * the card shows the real state.
   *
   * Only runs after the confirmation modal's "Yes, Cancel Claim" button.
   * `isCancellingClaim` gates both modal buttons so a rapid double-click
   * can't fire two DELETE requests for one claim.
   */
  const confirmCancelClaim = async () => {
    const itemId = claimToCancel;
    const existing = itemId ? claims.get(itemId) : undefined;
    if (!itemId || !existing || isCancellingClaim) return;
    setIsCancellingClaim(true);
    try {
      await apiCancelClaim(existing.claimId);
    } catch {
      // Fall through — the reload below resyncs to the DB's truth.
    }
    setReloadKey((key) => key + 1);
    setIsCancellingClaim(false);
    setClaimToCancel(null);
    setCancelToast("Claim cancelled successfully.");
  };

  const formatDate = (dateStr: string) => {
    try { return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return dateStr; }
  };
  const getStatusBadge = (status: ClaimStatus) => {
    switch (status) {
      case "PENDING": return "bg-amber-500/20 text-amber-400 border-amber-500/30 light:text-amber-700";
      case "VALIDATED": return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30 light:text-emerald-700";
      case "REJECTED": return "bg-red-500/20 text-red-400 border-red-500/30 light:text-red-700";
      case "RELEASED": return "bg-[#62A0EA]/20 text-[#8CB9F0] border-[#62A0EA]/30 light:text-[#1A5FB4]";
      default: return "";
    }
  };

  return {
    activeTab, handleTabChange, activeCategories, handleCategoryToggle, claimFilter, handleClaimFilterChange, searchQuery, handleSearch,
    dateWindow, handleDateWindowChange, clearDateWindow, timeRange, handleTimeRangeChange,
    currentPage, setCurrentPage, apiData, isLoading, listError,
    watchlist, toggleWatchlist, claims, claimPageData,
    openClaimModal,
    claimToCancel, requestCancelClaim, closeCancelClaimModal, confirmCancelClaim, isCancellingClaim, cancelToast,
    showClaimModal, setShowClaimModal, itemToClaim, proofText, setProofText,
    proofImages, setProofImages,
    submitClaim, claimError, isSubmittingClaim,
    displayItems, displayClaims, formatDate, getStatusBadge,
  };
}

/** Every specific category, in display order ("All" excluded). */
const ALL_SPECIFIC_CATEGORIES = CATEGORY_OPTIONS
  .map(option => option.value)
  .filter((value): value is Exclude<ItemCategory, "ALL"> => value !== "ALL");

/** UI time range → backend `range` param ("ALL" sends nothing). */
function toBackendRange(range: TimeRange): LostFoundTimeRange | undefined {
  return range === "ALL" ? undefined : range;
}

/** Map the shared service's LostFoundItem → the local LostItem view-model. */
function mapServiceItemToViewModel(item: LostFoundItem): LostItem {
  return {
    id: item.id,
    itemName: item.itemName,
    description: item.description,
    imageUrl: item.imageUrl,
    plateNumber: item.plateNumber,
    driverName: item.driverName,
    conductorName: item.conductorName,
    estimatedTimeLost: item.estimatedTimeLost,
    category: (item.category || "OTHER") as LostItem["category"],
    datePosted: item.datePosted,
    photos: item.photos,
    claimableUntil: item.claimableUntil,
    myClaim: item.myClaim,
  };
}

/** Backend claim status → the UI's ClaimStatus union. */
function toUiClaimStatus(backend: string): Exclude<ClaimStatus, "NONE"> {
  if (backend === "APPROVED") return "VALIDATED";
  if (backend === "REJECTED") return "REJECTED";
  if (backend === "RELEASED") return "RELEASED";
  return "PENDING";
}

/**
 * Card claim state for a browse/watchlist page, from each item's `myClaim`.
 * Only the id and status are known here; the detail fields stay empty until
 * the My Claims tab loads the full claim.
 */
function claimsFromItems(items: LostItem[]): Map<string, ClaimData> {
  const next = new Map<string, ClaimData>();
  for (const item of items) {
    if (!item.myClaim) continue;
    next.set(item.id, {
      claimId: item.myClaim.id,
      status: toUiClaimStatus(item.myClaim.status),
      proof: "",
      claimDate: "",
      reviewedAt: null,
      approvedAt: null,
      rejectedAt: null,
      releasedAt: null,
      rejectionReason: null,
      pickupLocation: null,
      pickupAt: null,
      pickupReminder: null,
      noShowAt: null,
      item,
    });
  }
  return next;
}
