"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useAnnouncements } from "@/contexts/announcements-context";
import { useLostAndFound } from "./use-lost-and-found";
import { categories } from "./data";
import LostItemCard from "@/components/commuter/lost-and-found/lost-item-card";
import TripLedger, { TripLedgerSkeleton } from "@/components/commuter/lost-and-found/trip-ledger";
import ProofPhotoPicker from "@/components/commuter/lost-and-found/proof-photo-picker";
import RubberSegment from "@/components/ui/rubber-segment";
import { getClaimDeadline } from "./claim-deadline";
import { AdminDatePicker } from "@/components/admin/ui/admin-date-picker";
import { useCommuterTheme } from "@/contexts/commuter-theme-context";
import { ClaimData, ClaimFilter, LostItem, TimeRange, ViewTab } from "./types";
import {
  AlertTriangle,
  Bookmark,
  BookmarkCheck,
  BusFront,
  CalendarDays,
  CalendarX2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock3,
  FileCheck2,
  IdCard,
  PackageSearch,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  UserRound,
  X,
  XCircle,
  ZoomIn,
} from "lucide-react";

export default function LostAndFoundPage() {
  const {
    activeTab, handleTabChange, activeCategories, handleCategoryToggle, claimFilter, handleClaimFilterChange, searchQuery, handleSearch,
    dateWindow, handleDateWindowChange, clearDateWindow, timeRange, handleTimeRangeChange,
    setCurrentPage, apiData, isLoading, listError,
    watchlist, toggleWatchlist, claims, claimPageData, openClaimModal,
    claimToCancel, requestCancelClaim, closeCancelClaimModal, confirmCancelClaim, isCancellingClaim, cancelToast,
    showClaimModal, setShowClaimModal, itemToClaim, proofText, setProofText,
    proofImages, setProofImages,
    submitClaim, claimError, isSubmittingClaim,
    displayItems, displayClaims, formatDate, getStatusBadge
  } = useLostAndFound();
  const { claimUpdatesUnreadCount, markClaimUpdatesRead } = useAnnouncements();
  // RubberSegment takes its colours as props (inline CSS variables), which
  // the `light:` variant can't reach, so they follow the theme here.
  const isLight = useCommuterTheme() === "light";
  // Opening the Claims tab clears the claim-update badge (nav button + tab
  // dot) — new updates stay unread until the commuter actually looks here,
  // regardless of how many times the claim's status has changed since.
  useEffect(() => {
    if (activeTab === "MY_CLAIMS") markClaimUpdatesRead();
  }, [activeTab, markClaimUpdatesRead]);
  const paginationData = activeTab === "MY_CLAIMS" ? claimPageData : apiData;
  const pageNumbers = buildVisiblePages(paginationData.currentPage, paginationData.totalPages);
  const tabs: { key: ViewTab; label: string; icon: typeof PackageSearch }[] = [
    { key: "ALL", label: "All Items", icon: PackageSearch },
    { key: "WATCHLIST", label: "Bookmark", icon: BookmarkCheck },
    { key: "MY_CLAIMS", label: "Claims", icon: ClipboardList },
  ];
  const claimFilterOptions: { value: ClaimFilter; label: string }[] = [
    { value: "ALL", label: "All Statuses" },
    { value: "PENDING", label: "Pending" },
    { value: "VALIDATED", label: "Approved" },
    { value: "RELEASED", label: "Released" },
    { value: "REJECTED", label: "Rejected" },
  ];
  const activeClaimFilterLabel = claimFilterOptions.find((opt) => opt.value === claimFilter)?.label ?? "All Statuses";
  const isClaimsTab = activeTab === "MY_CLAIMS";
  const [filtersOpen, setFiltersOpen] = useState(false);
  // A new tab starts at the top. Without this, a short tab inherits the
  // previous tab's scroll offset and the pinned filter column starts cut off.
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollAreaRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);
  // Paging swaps the list, but the results scroll inside this panel (not the
  // window), so its offset would otherwise stay at the pager at the bottom.
  const changePage = (update: (page: number) => number) => {
    setCurrentPage(update);
    scrollAreaRef.current?.scrollTo({ top: 0 });
  };
  const filtersId = useId();
  const hasDateWindow = Boolean(dateWindow.from || dateWindow.to);
  // Posted dates can't be in the future, so both pickers stop at today.
  const todayIso = toIsoDate(new Date());
  const activeFilterCount = Number(activeCategories.length > 0) + Number(timeRange !== "ALL") + Number(hasDateWindow) + Number(isClaimsTab && claimFilter !== "ALL");
  // Category and time range are included in the collapsed filter count.
  const activeChipCount = Number(Boolean(searchQuery.trim())) + Number(hasDateWindow) + Number(isClaimsTab && claimFilter !== "ALL");
  const dateWindowLabel = dateWindow.from && dateWindow.to
    ? dateWindow.from === dateWindow.to ? formatDate(dateWindow.from) : `${formatDate(dateWindow.from)} to ${formatDate(dateWindow.to)}`
    : dateWindow.from ? `From ${formatDate(dateWindow.from)}` : `Until ${formatDate(dateWindow.to)}`;
  // Only the All Items count is exact: Watchlist and Claims apply the category
  // filter client-side on top of the server total, so they get a fixed line.
  const headerSummary =
    activeTab === "ALL"
      ? isLoading || listError
        ? "Items found on board, posted by staff"
        : `${apiData.totalItems} item${apiData.totalItems === 1 ? "" : "s"} found on board${TIME_RANGE_PHRASES[timeRange]}`
      : activeTab === "WATCHLIST"
        ? "Items you bookmarked"
        : "Track the status of items you claimed";

  // Full-detail view — the card only shows a clamped description and a
  // thumbnail; this surfaces the complete description and a larger photo.
  const [detailItem, setDetailItem] = useState<LostItem | null>(null);
  const [detailPhotoIndex, setDetailPhotoIndex] = useState(0);
  // Full-size photo viewer over the detail view; shares detailPhotoIndex so it
  // opens on the photo being shown and the carousel follows what was viewed.
  const [isPhotoViewerOpen, setIsPhotoViewerOpen] = useState(false);
  const openDetails = (item: LostItem) => {
    setDetailPhotoIndex(0);
    setIsPhotoViewerOpen(false);
    setDetailItem(item);
  };
  // All photos (up to 3); older rows without a photos list fall back to the cover image.
  const detailPhotos = detailItem
    ? detailItem.photos?.length
      ? detailItem.photos
      : detailItem.imageUrl
        ? [{ id: "cover", url: detailItem.imageUrl }]
        : []
    : [];
  const activeDetailPhoto = detailPhotos[detailPhotoIndex] ?? detailPhotos[0] ?? null;
  const detailDeadline = detailItem && (claims.get(detailItem.id)?.status ?? "NONE") === "NONE"
    ? getClaimDeadline(detailItem.claimableUntil)
    : null;
  const stepDetailPhoto = (step: number) =>
    setDetailPhotoIndex((index) => (index + step + detailPhotos.length) % detailPhotos.length);
  // Name of the item whose claim was just sent; drives the success modal.
  const [submittedClaimItem, setSubmittedClaimItem] = useState<string | null>(null);
  useEffect(() => {
    if (!detailItem && !showClaimModal && !claimToCancel && !submittedClaimItem) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Arrow keys page through the photos in the viewer.
      if (isPhotoViewerOpen && detailPhotos.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        stepDetailPhoto(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (event.key !== "Escape") return;
      // Innermost layer first: the photo viewer closes before the detail view.
      if (isPhotoViewerOpen) {
        setIsPhotoViewerOpen(false);
        return;
      }
      if (submittedClaimItem) {
        setSubmittedClaimItem(null);
        return;
      }
      // The cancel confirmation can sit on top of the detail view, so it goes first.
      if (claimToCancel) {
        if (!isCancellingClaim) closeCancelClaimModal();
      } else if (showClaimModal) {
        if (!isSubmittingClaim) setShowClaimModal(false);
      } else {
        setDetailItem(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // stepDetailPhoto only reads detailPhotos.length, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailItem, showClaimModal, claimToCancel, isCancellingClaim, isSubmittingClaim, closeCancelClaimModal, setShowClaimModal, isPhotoViewerOpen, detailPhotos.length, submittedClaimItem]);
  const formatDateTime = (dateStr: string | null) => {
    if (!dateStr) return "Not yet";
    try {
      return new Date(dateStr).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };
  const handleCloseClaimModal = () => {
    setShowClaimModal(false);
  };
  const handleSubmitClaim = async () => {
    // Read before submitting: a successful submit closes the claim modal.
    const itemName = itemToClaim?.itemName ?? null;
    if (await submitClaim()) setSubmittedClaimItem(itemName ?? "this item");
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#050F1A] light:bg-[#F8FAFC]">
      
      {/* --- HEADER --- */}
      {/* Title and the three sections only; finding and narrowing live in
          the left column beside the results. */}
      <div className="z-10 flex-shrink-0 overflow-hidden border-b border-white/10 bg-[#071A2E] light:border-gray-200 light:bg-white [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-[84rem] px-4 pt-5 lg:px-8 lg:pt-7">
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-tight text-white light:text-gray-900 lg:text-2xl">Lost & Found</h1>
            <p className="mt-1 text-xs text-white/55 light:text-gray-500">{headerSummary}</p>
          </div>

          <nav aria-label="Lost and found sections" className="mt-4 grid grid-cols-3 lg:mt-5 lg:flex lg:gap-8">
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => handleTabChange(key)}
                aria-pressed={activeTab === key}
                className={`relative inline-flex h-11 min-w-0 items-center justify-center gap-2 text-sm font-semibold transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-t-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#62A0EA] lg:justify-start ${
                  activeTab === key
                    ? "text-white after:bg-[#62A0EA] light:text-gray-900 light:after:bg-[#1A5FB4]"
                    : "text-white/55 after:bg-transparent hover:text-white light:text-gray-500 light:hover:text-gray-900"
                }`}
              >
                <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span className="truncate">{label}</span>
                {key === "MY_CLAIMS" && claimUpdatesUnreadCount > 0 && (
                  <span
                    aria-label={`${claimUpdatesUnreadCount} claim update${claimUpdatesUnreadCount === 1 ? "" : "s"}`}
                    className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#FF6D3A] px-1 text-[9px] font-bold tabular-nums text-white"
                  >
                    {claimUpdatesUnreadCount > 99 ? "99+" : claimUpdatesUnreadCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* --- FILTERS + RESULTS --- */}
      {/* Gutter is always reserved, so the centered page (wider screens) doesn't
          shift sideways when a tall list adds a scrollbar and a short/empty
          one removes it. The header reserves the same gutter to stay aligned. */}
      <div ref={scrollAreaRef} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
       <div className="mx-auto flex min-h-full w-full max-w-[84rem] flex-col p-4 pb-28 lg:p-8 lg:pb-8 xl:grid xl:grid-cols-[16.5rem_minmax(0,1fr)] xl:gap-10">
        {/* Wide screens (xl): a pinned left column. Phones: search on top with the
            rest folded behind the Filters button. */}
        <aside aria-label="Search and filters" className="mb-5 flex flex-col gap-3 xl:sticky xl:top-8 xl:mb-0 xl:max-h-[calc(100dvh-14rem)] xl:gap-6 xl:self-start xl:overflow-y-auto xl:pb-2 xl:[scrollbar-width:thin]">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45 light:text-gray-400" />
              <input
                type="search"
                placeholder="Item, plate, driver, conductor"
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                aria-label={isClaimsTab ? "Search claims" : "Search lost and found items"}
                className="h-11 w-full rounded-lg border border-white/10 bg-[#0E1628] pl-10 pr-4 text-sm text-white outline-none transition-colors placeholder:text-white/45 focus:border-[#62A0EA] light:border-gray-200 light:bg-white light:text-gray-900 light:placeholder:text-gray-400 light:focus:border-[#1A5FB4] xl:h-10 [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
            <button
              type="button"
              onClick={() => setFiltersOpen(open => !open)}
              aria-expanded={filtersOpen}
              aria-controls={filtersId}
              aria-label={`Filters${activeFilterCount ? `, ${activeFilterCount} active` : ""}`}
              className={`inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] xl:hidden ${filtersOpen || activeFilterCount > 0 ? "border-[#62A0EA]/45 bg-[#1A5FB4]/20 text-white light:border-[#1A5FB4]/40 light:bg-[#1A5FB4]/10 light:text-[#1A5FB4]" : "border-white/10 bg-[#0E1628] text-white/70 hover:bg-white/5 light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-50"}`}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Filters</span>
              {activeFilterCount > 0 && <span aria-hidden="true" className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#1A5FB4] px-1 text-[10px] tabular-nums text-white">{activeFilterCount}</span>}
              <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${filtersOpen ? "rotate-180" : ""}`} />
            </button>
          </div>

          <div id={filtersId} className={`flex-col gap-4 ${filtersOpen ? "flex" : "hidden"} xl:flex xl:gap-6`}>
            <FilterGroup label={isClaimsTab ? "Date and status" : "Posted date"}>
              <div className="grid gap-2">
                {/* Inclusive window: each picker's min/max stops the start
                    from passing the end, so the range is always valid. */}
                <div className="grid grid-cols-2 gap-2 xl:grid-cols-1">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-[10px] font-semibold text-white/45 light:text-gray-500">From</span>
                    <AdminDatePicker
                      popover
                      accent="blue"
                      align="left"
                      ariaLabel="Show items posted from this date"
                      clearLabel="Clear start date"
                      placeholder="Start date"
                      value={dateWindow.from}
                      max={dateWindow.to || todayIso}
                      onChange={(date) => handleDateWindowChange("from", date)}
                      triggerClassName="h-11 w-full xl:h-10"
                      className="w-full"
                    />
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-[10px] font-semibold text-white/45 light:text-gray-500">To</span>
                    <AdminDatePicker
                      popover
                      accent="blue"
                      align="right"
                      ariaLabel="Show items posted up to this date"
                      clearLabel="Clear end date"
                      placeholder="End date"
                      value={dateWindow.to}
                      min={dateWindow.from || undefined}
                      max={todayIso}
                      onChange={(date) => handleDateWindowChange("to", date)}
                      triggerClassName="h-11 w-full xl:h-10"
                      className="w-full"
                    />
                  </div>
                </div>
                {isClaimsTab && <ClaimStatusSelect value={claimFilter} onChange={handleClaimFilterChange} options={claimFilterOptions} />}
              </div>
            </FilterGroup>

            <FilterGroup label="Posted within">
              <RubberSegment<TimeRange>
                items={TIME_RANGE_OPTIONS}
                value={timeRange}
                onChange={handleTimeRangeChange}
                aria-label="Filter by date posted"
                size="md"
                radius={8}
                inset={3}
                trackColor={isLight ? "#FFFFFF" : "#0E1628"}
                thumbColor={isLight ? "#1A5FB4" : "#143A6B"}
                textColor={isLight ? "#4B5563" : "#FFFFFF"}
                activeTextColor="#FFFFFF"
                className="w-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] light:shadow-[inset_0_0_0_1px_#E5E7EB]"
              />
            </FilterGroup>

            <FilterGroup label="Category">
              {/* Checkboxes: any mix of categories. "All" is checked exactly
                  when nothing specific is, and checking it clears the rest.
                  Phones: two columns. Desktop: a vertical list. */}
              <div role="group" aria-label="Filter by category" className="grid grid-cols-2 gap-1 xl:grid-cols-1">
                {categories.map(cat => {
                  const checked = cat.value === "ALL" ? activeCategories.length === 0 : activeCategories.includes(cat.value);
                  return (
                    <label
                      key={cat.value}
                      className={`flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-xs font-semibold transition-colors duration-200 motion-reduce:transition-none ${checked ? "bg-[#1A5FB4]/15 text-white light:bg-[#1A5FB4]/10 light:text-[#1A5FB4]" : "text-white/60 hover:bg-white/[0.04] hover:text-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleCategoryToggle(cat.value)}
                        className="peer sr-only"
                      />
                      <span
                        aria-hidden="true"
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-200 peer-focus-visible:ring-2 peer-focus-visible:ring-[#62A0EA] peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-[#050F1A] light:peer-focus-visible:ring-offset-[#F8FAFC] motion-reduce:transition-none ${checked ? "border-[#1A5FB4] bg-[#1A5FB4] text-white" : "border-white/25 bg-[#0E1628] light:border-gray-300 light:bg-white"}`}
                      >
                        <Check className={`h-3 w-3 transition-[opacity,transform] duration-200 motion-reduce:transition-none ${checked ? "scale-100 opacity-100" : "scale-50 opacity-0"}`} strokeWidth={3} />
                      </span>
                      <span className="truncate">{cat.label}</span>
                    </label>
                  );
                })}
              </div>
            </FilterGroup>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {activeChipCount > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {searchQuery.trim() && (
                <button type="button" onClick={() => handleSearch("")} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/[0.07] hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]">
                  Search
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              {hasDateWindow && (
                <button type="button" onClick={clearDateWindow} aria-label={`Clear posted date filter, ${dateWindowLabel}`} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/[0.07] hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]">
                  {dateWindowLabel}
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              {isClaimsTab && claimFilter !== "ALL" && (
                <button type="button" onClick={() => handleClaimFilterChange("ALL")} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/[0.07] hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]">
                  {activeClaimFilterLabel}
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        {isLoading ? (
          activeTab === "MY_CLAIMS" ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="h-44 rounded-xl border border-white/10 bg-white/[0.04] light:border-gray-200 light:bg-white">
                  <div className="h-full w-full animate-pulse motion-reduce:animate-none rounded-[inherit] bg-gradient-to-r from-white/[0.03] via-white/[0.07] to-white/[0.03] light:from-gray-100 light:via-gray-200 light:to-gray-100" />
                </div>
              ))}
            </div>
          ) : (
            <TripLedgerSkeleton />
          )
        ) : listError ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center px-4">
            <p className="text-red-400 font-medium text-sm mb-3 light:text-red-600">{listError}</p>
            <button onClick={() => handleTabChange(activeTab)} className="px-4 py-2.5 rounded-md text-xs font-semibold bg-[#1A5FB4] text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]">Try again</button>
          </div>
        ) : activeTab === "MY_CLAIMS" && displayClaims.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center px-4">
             <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-xl border border-white/10 bg-white/5 light:border-gray-200 light:bg-white">
               <PackageSearch className="h-7 w-7 text-white/20 light:text-gray-300" />
             </div>
             <h3 className="text-white/70 font-semibold mb-1 light:text-gray-700">No claims found</h3>
             <p className="max-w-xs text-white/60 text-sm light:text-gray-500">Try another status filter or search term.</p>
          </div>
        ) : activeTab !== "MY_CLAIMS" && displayItems.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center text-center px-4">
             <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-xl border border-white/10 bg-white/5 light:border-gray-200 light:bg-white">
               <PackageSearch className="h-7 w-7 text-white/20 light:text-gray-300" />
             </div>
             <h3 className="text-white/70 font-semibold mb-1 light:text-gray-700">No matching items</h3>
             <p className="max-w-xs text-white/60 text-sm light:text-gray-500">Try another keyword or category. New found items appear here as soon as staff reports them.</p>
          </div>
        ) : (
          <>
            {activeTab === "MY_CLAIMS" ? (
              <div className="space-y-3">
                {displayClaims.map(claim => (
                  <ClaimRecordCard
                    key={claim.claimId}
                    claim={claim}
                    formatDateTime={formatDateTime}
                    onCancelClaim={requestCancelClaim}
                    onClaimAgain={openClaimModal}
                    onOpenDetails={openDetails}
                  />
                ))}
              </div>
            ) : (
              <TripLedger
                items={displayItems}
                renderItem={item => (
                  <LostItemCard
                    item={item}
                    isWatched={watchlist.has(item.id)}
                    claimStatus={claims.get(item.id)?.status || "NONE"}
                    onToggleWatchlist={toggleWatchlist}
                    onOpenClaimModal={openClaimModal}
                    onCancelClaim={requestCancelClaim}
                    onOpenDetails={openDetails}
                    getStatusBadge={getStatusBadge}
                  />
                )}
              />
            )}

            {paginationData.totalPages > 1 && (
              <div className="mt-8 mb-4 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => changePage(prev => Math.max(prev - 1, 1))}
                  disabled={paginationData.currentPage === 1}
                  className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] ${
                    paginationData.currentPage === 1
                      ? "cursor-not-allowed border-white/5 bg-white/5 text-white/20 light:border-gray-200 light:bg-gray-100 light:text-gray-300"
                      : "border-white/10 bg-[#0E1628] text-white/65 hover:bg-white/10 hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900"
                  }`}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Prev
                </button>
                {pageNumbers.map((page, index) => (
                  page === "ellipsis" ? (
                    <span key={`ellipsis-${index}`} className="flex h-10 w-9 items-center justify-center text-sm font-semibold text-white/40 light:text-gray-400">...</span>
                  ) : (
                    <button
                      key={page}
                      type="button"
                      onClick={() => { if (page !== paginationData.currentPage) changePage(() => page); }}
                      aria-current={paginationData.currentPage === page ? "page" : undefined}
                      className={`h-10 w-10 rounded-md text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] ${
                        paginationData.currentPage === page
                          ? "bg-[#62A0EA]/15 text-[#62A0EA] light:bg-[#1A5FB4]/10 light:text-[#1A5FB4]"
                          : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white light:bg-gray-100 light:text-gray-600 light:hover:bg-gray-200 light:hover:text-gray-900"
                      }`}
                    >
                      {page}
                    </button>
                  )
                ))}
                <button
                  type="button"
                  onClick={() => changePage(prev => Math.min(prev + 1, paginationData.totalPages))}
                  disabled={paginationData.currentPage === paginationData.totalPages}
                  className={`inline-flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] ${
                    paginationData.currentPage === paginationData.totalPages
                      ? "cursor-not-allowed border-white/5 bg-white/5 text-white/20 light:border-gray-200 light:bg-gray-100 light:text-gray-300"
                      : "border-white/10 bg-[#0E1628] text-white/65 hover:bg-white/10 hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900"
                  }`}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </>
        )}
        </div>
       </div>
      </div>

      {/* --- ITEM DETAIL MODAL --- */}
      {detailItem && (
        <div role="dialog" aria-modal="true" aria-labelledby="lf-detail-title" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setDetailItem(null)}>
          <div className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#071A2E] light:border-gray-200 light:bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* Stacked as a flex column below lg, not a one-column grid: grid
                row sizing doesn't reliably reserve the photo's aspect-ratio
                height (its image is percentage-sized, which counts as zero in
                the row's minimum), so the details row started at the top and
                sat over the photo, swallowing taps on the carousel arrows and
                thumbnails. In a flex column the photo keeps its height
                (flex-shrink-0) and the details take the rest. */}
            <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
              <div className="relative aspect-[4/3] flex-shrink-0 bg-[#0A1E33] light:bg-gray-100 lg:aspect-auto lg:min-h-[520px]">
                {activeDetailPhoto ? (
                  <button
                    type="button"
                    onClick={() => setIsPhotoViewerOpen(true)}
                    className="group/photo relative block h-full w-full cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#62A0EA]"
                    aria-label="View full photo"
                  >
                    <img
                      src={activeDetailPhoto.url}
                      alt={detailPhotos.length > 1 ? `${detailItem.itemName}, photo ${detailPhotoIndex + 1} of ${detailPhotos.length}` : detailItem.itemName}
                      className="h-full w-full object-cover"
                    />
                    <span className="pointer-events-none absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white opacity-0 transition-opacity group-hover/photo:opacity-100 group-focus-visible/photo:opacity-100">
                      <ZoomIn className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </button>
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-white/20 light:text-gray-400">
                    <PackageSearch className="h-12 w-12" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider">No photo yet</span>
                  </div>
                )}
                <div className="pointer-events-none absolute left-0 top-0 p-4">
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-[#1E3A5C] bg-[#0B223A] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
                    <Tag className="h-3 w-3" />
                    {detailItem.category}
                  </span>
                </div>
                {detailPhotos.length > 1 && (
                  <>
                    <button type="button" onClick={() => stepDetailPhoto(-1)} className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white transition-colors hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]" aria-label="Previous photo">
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => stepDetailPhoto(1)} className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white transition-colors hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]" aria-label="Next photo">
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </>
                )}
                {/* Pass-through so a click on the fade still opens the viewer;
                    the thumbnails opt back in. */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 bg-gradient-to-t from-black/85 via-black/35 to-transparent p-4 pt-16">
                  <p className="text-xs font-semibold text-white/75">Posted {formatDate(detailItem.datePosted)}</p>
                  {detailPhotos.length > 1 && (
                    <div className="pointer-events-auto flex flex-shrink-0 gap-1.5">
                      {detailPhotos.map((photo, index) => (
                        <button
                          key={photo.id}
                          type="button"
                          onClick={() => setDetailPhotoIndex(index)}
                          aria-label={`Show photo ${index + 1}`}
                          aria-current={index === detailPhotoIndex ? "true" : undefined}
                          className={`h-11 w-11 overflow-hidden rounded-md border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] ${
                            index === detailPhotoIndex ? "border-[#62A0EA]" : "border-white/25 opacity-70 hover:opacity-100"
                          }`}
                        >
                          <img src={photo.url} alt="" className="h-full w-full object-cover" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Body scrolls independently of the footer, so the action row
                  below stays reachable without hunting through a long
                  description first — same header/body/footer split the
                  claim modal already uses. */}
              <div className="relative flex min-h-0 flex-1 flex-col">
                {/* Close sits on the details side, outside the scrolling body,
                    so it stays put however long the description is. */}
                <button autoFocus onClick={() => setDetailItem(null)} className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/60 transition-colors hover:bg-white/10 hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] lg:right-5 lg:top-5" aria-label="Close item details">
                  <X className="h-4 w-4" />
                </button>
                <div className="min-h-0 flex-1 overflow-y-auto p-5 lg:p-6">
                  <div className="mb-5">
                    <h2 id="lf-detail-title" className="pr-11 text-xl font-bold leading-tight text-white light:text-gray-900">{detailItem.itemName}</h2>
                    {detailDeadline && (
                      <p className={`mt-1.5 flex items-center gap-1.5 text-xs font-semibold ${detailDeadline.isUrgent ? "text-white light:text-gray-900" : "text-white/60 light:text-gray-500"}`}>
                        <CalendarDays className="h-3.5 w-3.5" />
                        Claim by {detailDeadline.dateLabel} &middot; {detailDeadline.label}
                      </p>
                    )}
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white/75 light:text-gray-700">{detailItem.description}</p>
                  </div>

                  <div className="mb-5 grid grid-cols-2 gap-3">
                    <DetailInfo icon={<IdCard className="h-4 w-4" />} label="Plate Number" value={detailItem.plateNumber || "Plate unavailable"} />
                    <DetailInfo icon={<Clock3 className="h-4 w-4" />} label="Estimated Time" value={detailItem.estimatedTimeLost || "Time unavailable"} />
                    <DetailInfo icon={<BusFront className="h-4 w-4" />} label="Driver" value={detailItem.driverName || "Driver unavailable"} />
                    <DetailInfo icon={<UserRound className="h-4 w-4" />} label="Conductor" value={detailItem.conductorName || "Conductor unavailable"} />
                  </div>

                  {/* `claims` holds only this commuter's own claims, so RELEASED
                      means the item was already handed over to them, and a
                      proof/handover reminder no longer applies. */}
                  {claims.get(detailItem.id)?.status !== "RELEASED" && (
                    <div className="rounded-xl border border-[#1E3A5C] bg-[#0B223A] p-3 light:border-gray-200 light:bg-gray-50">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-white/70 light:text-gray-500" />
                        <div>
                          <p className="text-xs font-bold text-white light:text-gray-900">Claim reminder</p>
                          <p className="mt-1 text-xs leading-5 text-white/70 light:text-gray-600">Submit specific proof only if this item is yours. Staff may ask for a valid ID during handover.</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-shrink-0 items-center gap-3 border-t border-white/10 light:border-gray-200 p-5 lg:p-6">
                  {(() => {
                    const status = claims.get(detailItem.id)?.status || "NONE";
                    if (status === "PENDING") {
                      return <button onClick={() => requestCancelClaim(detailItem.id)} className="h-11 flex-1 rounded-xl border border-white/10 bg-white/5 text-sm font-semibold text-white/65 transition-colors hover:bg-white/10 hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900">Cancel Claim</button>;
                    }
                    if (status === "VALIDATED" || status === "RELEASED") {
                      return (
                        <div className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-sm font-semibold text-emerald-300 light:text-emerald-700">
                          <ShieldCheck className="h-4 w-4" />
                          {status === "RELEASED" ? "Released" : "Validated"}
                        </div>
                      );
                    }
                    return (
                      <button
                        onClick={() => { setDetailItem(null); openClaimModal(detailItem); }}
                        className="h-11 flex-1 rounded-xl bg-[#FF6D3A] text-sm font-bold text-white shadow-lg shadow-[#FF6D3A]/25 transition-colors hover:bg-[#e55a2b]"
                      >
                        {status === "REJECTED" ? "Claim Again" : "Claim Item"}
                      </button>
                    );
                  })()}
                  <button onClick={() => toggleWatchlist(detailItem.id)} className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border transition-colors ${watchlist.has(detailItem.id) ? "border-[#62A0EA]/35 bg-[#1A5FB4]/20 text-[#62A0EA] light:bg-[#1A5FB4]/10 light:text-[#1A5FB4]" : "border-white/10 bg-white/5 text-white/50 hover:bg-white/10 hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900"}`} aria-label={watchlist.has(detailItem.id) ? "Remove bookmark" : "Bookmark item"}>
                    <Bookmark className={`h-5 w-5 ${watchlist.has(detailItem.id) ? "fill-current" : ""}`} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- FULL PHOTO VIEWER --- */}
      {/* Above the detail view (z-[110] vs z-[100]); shows the whole photo
          uncropped. Same pattern as the admin ID lightbox, plus paging for
          items with several photos. */}
      {detailItem && isPhotoViewerOpen && activeDetailPhoto && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${detailItem.itemName} photo viewer`}
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/95 p-4 sm:p-12"
          onClick={() => setIsPhotoViewerOpen(false)}
        >
          <button
            type="button"
            autoFocus
            onClick={() => setIsPhotoViewerOpen(false)}
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-white/70 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]"
            aria-label="Close photo viewer"
          >
            <X className="h-5 w-5" />
          </button>

          <img
            src={activeDetailPhoto.url}
            alt={detailPhotos.length > 1 ? `${detailItem.itemName}, photo ${detailPhotoIndex + 1} of ${detailPhotos.length}` : detailItem.itemName}
            className="max-h-full max-w-full rounded-md object-contain"
            onClick={(e) => e.stopPropagation()}
          />

          {detailPhotos.length > 1 && (
            <>
              <button type="button" onClick={(e) => { e.stopPropagation(); stepDetailPhoto(-1); }} className="absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white transition-colors hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] sm:left-5" aria-label="Previous photo">
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button type="button" onClick={(e) => { e.stopPropagation(); stepDetailPhoto(1); }} className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/60 text-white transition-colors hover:bg-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] sm:right-5" aria-label="Next photo">
                <ChevronRight className="h-5 w-5" />
              </button>
              <p aria-live="polite" className="pointer-events-none absolute inset-x-0 bottom-5 text-center text-xs font-semibold tabular-nums text-white/70">
                {detailPhotoIndex + 1} / {detailPhotos.length}
              </p>
            </>
          )}
        </div>
      )}

      {/* --- CLAIM MODAL --- */}
      {showClaimModal && itemToClaim && (
        <div role="dialog" aria-modal="true" aria-labelledby="lf-claim-title" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="flex h-[min(720px,88vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#071A2E] light:border-gray-200 light:bg-white shadow-2xl">
            <div className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-white/10 light:border-gray-200 p-5">
              <div className="min-w-0">
                <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#FFB199] light:text-[#E55A2B]">
                  <FileCheck2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Claim request
                </p>
                <h2 id="lf-claim-title" className="text-lg font-bold text-white light:text-gray-900">Proof of ownership</h2>
                <p className="mt-1 line-clamp-1 text-xs text-white/60 light:text-gray-500">
                  {itemToClaim.itemName} on {itemToClaim.plateNumber || "assigned vehicle"}
                </p>
              </div>
              <button onClick={handleCloseClaimModal} className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/60 transition-colors hover:bg-white/10 hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]" aria-label="Close claim modal">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              <div className="rounded-xl border border-white/8 bg-white/[0.04] p-3 light:border-gray-200 light:bg-gray-50">
                <div className="grid gap-2 sm:grid-cols-2">
                  <DetailInfo icon={<Tag className="h-4 w-4" />} label="Category" value={itemToClaim.category} />
                  <DetailInfo icon={<Clock3 className="h-4 w-4" />} label="Estimated Time" value={itemToClaim.estimatedTimeLost || "Time unavailable"} />
                </div>
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-white/75 light:text-gray-700">Proof of Ownership <span className="text-red-400 light:text-red-600">*</span></label>
                <textarea
                  rows={6}
                  value={proofText}
                  onChange={(e) => setProofText(e.target.value)}
                  placeholder="Describe a specific detail, where you sat, unique marks, contents, or anything staff can verify."
                  className="w-full resize-none rounded-xl border border-white/10 bg-[#0E1628] px-4 py-3 text-sm leading-6 text-white outline-none transition-colors placeholder:text-white/45 focus:border-[#62A0EA] light:border-gray-200 light:bg-white light:text-gray-900 light:placeholder:text-gray-400 light:focus:border-[#1A5FB4]"
                />
                <p className="mt-2 text-[11px] font-medium text-white/55 light:text-gray-500">This proof is visible to the admin reviewer.</p>
              </div>

              <ProofPhotoPicker files={proofImages} onChange={setProofImages} disabled={isSubmittingClaim} />

              {claimError && (
                <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 light:border-red-200 light:bg-red-50">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400 light:text-red-600" />
                  <p className="text-xs font-medium leading-5 text-red-300 light:text-red-700">{claimError}</p>
                </div>
              )}

              <div className="flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 light:border-amber-300 light:bg-amber-50">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300 light:text-amber-600" />
                <div>
                  <p className="text-xs font-bold text-amber-100 light:text-amber-900">Reminder</p>
                  <p className="mt-1 text-xs leading-5 text-amber-100/80 light:text-amber-800">Bring a valid ID during handover. Staff may reject claims that do not match the item details.</p>
                </div>
              </div>
            </div>

            <div className="grid flex-shrink-0 grid-cols-2 gap-3 border-t border-white/10 light:border-gray-200 p-5">
              <button onClick={handleCloseClaimModal} className="h-11 rounded-xl border border-white/10 bg-white/5 text-sm font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900">Cancel</button>
              <button onClick={handleSubmitClaim} disabled={!proofText.trim() || isSubmittingClaim} className={`flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-bold shadow-lg transition-colors ${!proofText.trim() || isSubmittingClaim ? "cursor-not-allowed bg-white/10 text-white/30 shadow-none light:bg-gray-100 light:text-gray-400" : "bg-[#FF6D3A] text-white shadow-[#FF6D3A]/30 hover:bg-[#e55a2b]"}`}>
                {isSubmittingClaim ? (
                  <span className="inline-flex items-center gap-2"><span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> Submitting...</span>
                ) : "Submit Claim"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- CLAIM SUBMITTED --- */}
      {submittedClaimItem && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="lf-claim-sent-title" aria-describedby="lf-claim-sent-body" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-x-hidden overflow-y-auto rounded-xl border border-white/10 bg-[#071A2E] shadow-2xl light:border-[#DAEEFF] light:bg-white animate-fade-in">
            <div className="px-6 pt-7 text-center sm:px-8">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-300 light:text-emerald-600" aria-hidden="true" />
              <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-300 light:text-emerald-700">Request received</p>
              <h2 id="lf-claim-sent-title" className="mt-1 text-xl font-bold text-white light:text-gray-900">Claim request sent</h2>
              <p id="lf-claim-sent-body" className="mx-auto mt-2 max-w-sm text-sm leading-6 text-white/60 light:text-gray-600">
                Your request is with the Lost &amp; Found desk. We&apos;ll notify you when it has been reviewed.
              </p>
            </div>

            <div className="px-6 pb-6 pt-5 sm:px-8">
              <div className="rounded-lg border border-[#1E3A56] bg-[#0B223A] p-4 light:border-[#DAEEFF] light:bg-[#F0F7FF]">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-white/55 light:text-gray-500">Item you claimed</p>
                <p className="mt-1.5 break-words text-sm font-semibold text-white light:text-gray-900">{submittedClaimItem}</p>
              </div>

              {/* Icons sit straight on the surface; only the current step is blue. */}
              <ol aria-label="Claim progress" className="mt-5 space-y-4">
                <li className="flex items-center gap-3">
                  <Check className="h-5 w-5 shrink-0 text-white/75 light:text-gray-600" strokeWidth={2.25} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-white/90 light:text-gray-900">Request sent</span>
                    <span className="mt-0.5 block text-[10px] text-white/55 light:text-gray-500">Your proof has been submitted</span>
                  </span>
                  <span className="text-[10px] font-medium text-white/65 light:text-gray-600">Done</span>
                </li>
                <li aria-current="step" className="flex items-center gap-3">
                  <Clock3 className="h-5 w-5 shrink-0 text-[#99C1F1] light:text-[#1A5FB4]" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-white/90 light:text-gray-900">Desk review</span>
                    <span className="mt-0.5 block text-[10px] text-white/55 light:text-gray-500">Staff will check your claim</span>
                  </span>
                  <span className="text-[10px] font-semibold text-[#99C1F1] light:text-[#1A5FB4]">In progress</span>
                </li>
                <li className="flex items-center gap-3">
                  <IdCard className="h-5 w-5 shrink-0 text-white/45 light:text-gray-400" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-white/70 light:text-gray-700">Pickup details</span>
                    <span className="mt-0.5 block text-[10px] text-white/50 light:text-gray-500">Sent after approval</span>
                  </span>
                  <span className="text-[10px] text-white/50 light:text-gray-500">Next</span>
                </li>
              </ol>

              <p className="mt-5 rounded-md border border-[#1E3A56] bg-[#0B223A] px-3 py-2.5 text-[11px] leading-5 text-white/80 light:border-[#DAEEFF] light:bg-[#F0F7FF] light:text-gray-700">
                Bring a valid ID when collecting the item.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-white/10 p-5 light:border-gray-200 sm:px-8">
              <button
                onClick={() => setSubmittedClaimItem(null)}
                className="h-11 rounded-xl border border-white/10 bg-white/5 text-sm font-semibold text-white/70 transition-colors hover:bg-white/10 hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]"
              >
                Done
              </button>
              <button
                autoFocus
                onClick={() => { setSubmittedClaimItem(null); handleTabChange("MY_CLAIMS"); }}
                className="flex h-11 items-center justify-center gap-2 rounded-xl bg-[#1A5FB4] text-sm font-bold text-white transition-colors hover:bg-[#164A8F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] focus-visible:ring-offset-2 focus-visible:ring-offset-[#071A2E] light:focus-visible:ring-offset-white"
              >
                <ClipboardList className="h-4 w-4" aria-hidden="true" />
                View my claims
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- CANCEL CLAIM CONFIRMATION MODAL --- */}
      {claimToCancel && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="lf-cancel-title" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-xl border border-white/10 bg-[#071A2E] light:border-gray-200 light:bg-white shadow-2xl">
            <div className="flex items-start gap-4 p-5">
              <AlertTriangle className="mt-0.5 h-7 w-7 shrink-0 text-red-400 light:text-red-600" aria-hidden="true" />
              <div className="min-w-0">
                <h2 id="lf-cancel-title" className="text-base font-bold text-white light:text-gray-900">Cancel this claim?</h2>
                <p className="mt-1.5 text-sm leading-5 text-white/70 light:text-gray-600">
                  {claims.get(claimToCancel)?.item?.itemName ? (
                    <>This will cancel your claim on &ldquo;<span className="font-semibold text-white/80 light:text-gray-900">{claims.get(claimToCancel)?.item?.itemName}</span>&rdquo;. </>
                  ) : (
                    "This will cancel your claim. "
                  )}
                  You can submit a new claim later if the item is still available.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-white/10 light:border-gray-200 p-5">
              <button
                autoFocus
                onClick={closeCancelClaimModal}
                disabled={isCancellingClaim}
                className="h-11 rounded-xl border border-[#1E3A56] bg-[#0B223A] text-sm font-semibold text-white transition-colors hover:border-white/30 light:border-gray-200 light:bg-white light:text-gray-700 light:hover:bg-gray-50 light:hover:text-gray-900 disabled:cursor-not-allowed disabled:text-white/60 light:disabled:text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]"
              >
                Keep Claim
              </button>
              {/* Stays solid red with white text while cancelling, so the label stays readable. */}
              <button
                onClick={() => void confirmCancelClaim()}
                disabled={isCancellingClaim}
                className={`flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-bold text-white transition-colors ${isCancellingClaim ? "cursor-not-allowed bg-[#B91C1C]" : "bg-[#DC2626] hover:bg-[#B91C1C]"}`}
              >
                {isCancellingClaim ? (
                  <span className="inline-flex items-center gap-2"><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> Cancelling…</span>
                ) : "Yes, Cancel Claim"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- CANCEL SUCCESS TOAST --- */}
      {cancelToast && (
        <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 z-[120] flex -translate-x-1/2 items-center gap-2 rounded-full bg-[#071A2E] px-4 py-2.5 text-sm font-medium text-white shadow-lg">
          <svg className="h-4 w-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          {cancelToast}
        </div>
      )}
    </div>
  );
}

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

// Spells out the rolling windows the backend applies (LostItemService::applyRangeFilter).
const TIME_RANGE_PHRASES: Record<TimeRange, string> = {
  ALL: "",
  today: " today",
  week: " in the last 7 days",
  month: " in the last 30 days",
  year: " in the last year",
};

function buildVisiblePages(currentPage: number, totalPages: number): (number | "ellipsis")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);
  const sortedPages = Array.from(pages)
    .filter(page => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);

  return sortedPages.reduce<(number | "ellipsis")[]>((result, page) => {
    const previous = result[result.length - 1];
    if (typeof previous === "number" && page - previous > 1) {
      result.push("ellipsis");
    }
    result.push(page);
    return result;
  }, []);
}

/** Local-calendar 'YYYY-MM-DD' (matches AdminDatePicker's values). */
function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-white/45 light:text-gray-500">{label}</p>
      {children}
    </div>
  );
}

function ClaimStatusSelect({ value, onChange, options }: {
  value: ClaimFilter;
  onChange: (value: ClaimFilter) => void;
  options: { value: ClaimFilter; label: string }[];
}) {
  return (
    <div className="relative w-full">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ClaimFilter)}
        className="h-11 w-full appearance-none rounded-lg border border-white/10 bg-[#0E1628] px-3 pr-9 text-sm font-semibold text-white/80 outline-none transition-colors [color-scheme:dark] focus:border-[#62A0EA] light:border-gray-200 light:bg-white light:text-gray-700 light:[color-scheme:light] light:focus:border-[#1A5FB4] xl:h-10"
        aria-label="Filter claims by status"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45 light:text-gray-400" />
    </div>
  );
}

function DetailInfo({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-lg border border-white/8 bg-white/[0.04] p-3 light:border-gray-200 light:bg-gray-50">
      <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-black/20 text-[#62A0EA] light:bg-[#1A5FB4]/10 light:text-[#1A5FB4]">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-white/55 light:text-gray-500">{label}</p>
        <p className="mt-0.5 break-words text-sm font-semibold text-white/85 light:text-gray-900">{value}</p>
      </div>
    </div>
  );
}

function ClaimRecordCard({
  claim,
  formatDateTime,
  onCancelClaim,
  onClaimAgain,
  onOpenDetails,
}: {
  claim: ClaimData;
  formatDateTime: (dateStr: string | null) => string;
  /** Opens the cancel-claim confirmation modal for this claim's item. */
  onCancelClaim: (id: string) => void;
  onClaimAgain: (item: LostItem) => void;
  onOpenDetails: (item: LostItem) => void;
}) {
  const item = claim.item;
  const [isTimelineOpen, setIsTimelineOpen] = useState(false);
  const statusMeta = {
    PENDING: {
      icon: <Clock3 className="h-4 w-4" />,
      title: "Claim Submitted",
      summary: "Waiting for staff review",
      dateValue: formatDateTime(claim.claimDate),
      accentClass: "text-amber-300 light:text-amber-700",
    },
    VALIDATED: {
      icon: <CheckCircle2 className="h-4 w-4" />,
      title: "Ready for Release",
      summary: claim.pickupLocation
        ? "Your claim was approved. Collect the item at the place and time below."
        : "Your claim was approved. Bring a valid ID for handover.",
      dateValue: formatDateTime(claim.approvedAt ?? claim.reviewedAt),
      accentClass: "text-emerald-300 light:text-emerald-700",
    },
    // A no-show isn't a judgement on the claim, so it reads neutral, not red.
    REJECTED: claim.noShowAt
      ? {
          icon: <CalendarX2 className="h-4 w-4" />,
          title: "Not Collected",
          summary: "You didn't collect the item on the pickup date, so this claim was closed. Submit a new claim or visit the office to claim it in person.",
          dateValue: formatDateTime(claim.noShowAt),
          accentClass: "text-slate-300 light:text-slate-600",
        }
      : {
          icon: <XCircle className="h-4 w-4" />,
          title: "Rejected",
          summary: claim.rejectionReason ?? "Staff rejected this claim.",
          dateValue: formatDateTime(claim.rejectedAt ?? claim.reviewedAt),
          accentClass: "text-red-300 light:text-red-700",
        },
    RELEASED: {
      icon: <ShieldCheck className="h-4 w-4" />,
      title: "Released",
      summary: "The item has been released by staff.",
      dateValue: formatDateTime(claim.releasedAt),
      accentClass: "text-[#8CB9F0] light:text-[#1A5FB4]",
    },
  }[claim.status];
  const timelineSteps = buildClaimTimeline(claim, item);

  return (
    <article className="rounded-xl border border-white/10 bg-[#071A2E] light:border-gray-200 light:bg-white p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:gap-5">
        <button
          type="button"
          disabled={!item}
          onClick={() => item && onOpenDetails(item)}
          aria-label={item ? `View details for ${item.itemName}` : undefined}
          className="h-20 w-20 flex-shrink-0 overflow-hidden rounded-lg border border-white/[0.06] bg-[#0A1E33] light:border-gray-200 light:bg-gray-100 text-left disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]"
        >
          {item?.imageUrl ? (
            <img src={item.imageUrl} alt={item.itemName} loading="lazy" decoding="async" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-white/20 light:text-gray-400">
              <PackageSearch className="h-7 w-7" />
            </div>
          )}
        </button>

        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-bold leading-tight text-white light:text-gray-900">{item?.itemName ?? "Deleted item"}</h3>
          <p className="mt-1 text-xs text-white/50 light:text-gray-500">{item ? `${item.category} · ${item.plateNumber}` : "This item record is no longer available"}</p>

          {/* The current state, once: coloured text instead of a badge plus a
              tinted panel that repeated the same word. */}
          <div className="mt-4 border-t border-white/[0.06] light:border-gray-200 pt-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <p className={`flex items-center gap-2 text-sm font-bold ${statusMeta.accentClass}`}>
                {statusMeta.icon}
                {statusMeta.title}
              </p>
              <p className="text-xs tabular-nums text-white/45 light:text-gray-500">{statusMeta.dateValue}</p>
            </div>
            <p className="mt-1.5 max-w-[65ch] text-sm leading-6 text-white/70 light:text-gray-600">{statusMeta.summary}</p>
          </div>

          {/* Where/when to collect, set by staff at approval. Shown only while
              the item is waiting for pickup; after release it's history. */}
          {claim.status === "VALIDATED" && claim.pickupLocation && (
            <section aria-label="Pickup schedule" className="mt-4 border-t border-white/[0.06] light:border-gray-200 pt-4">
              <dl className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-white/45 light:text-gray-500">Pick up at</dt>
                  <dd className="mt-1 break-words text-sm font-semibold text-white light:text-gray-900">{claim.pickupLocation}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-white/45 light:text-gray-500">When</dt>
                  <dd className="mt-1 text-sm font-semibold tabular-nums text-white light:text-gray-900">{formatDateTime(claim.pickupAt)}</dd>
                </div>
              </dl>
              {claim.pickupReminder && (
                <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-amber-200/90 light:text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-300 light:text-amber-600" aria-hidden="true" />
                  {claim.pickupReminder}
                </p>
              )}
            </section>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] light:border-gray-200 pt-3">
            <button
              type="button"
              onClick={() => setIsTimelineOpen((current) => !current)}
              className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-1.5 text-xs font-semibold text-white/65 transition-colors hover:text-white light:text-gray-600 light:hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]"
              aria-expanded={isTimelineOpen}
            >
              Claim history
              <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${isTimelineOpen ? "rotate-180" : ""}`} />
            </button>

            <div className="flex flex-wrap gap-2">
              {item && (
                <button onClick={() => onOpenDetails(item)} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-white/75 transition-colors hover:bg-white/5 hover:text-white light:border-gray-200 light:text-gray-700 light:hover:bg-gray-100 light:hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]">
                  View Details
                </button>
              )}
              {claim.status === "PENDING" && item && (
                <button onClick={() => onCancelClaim(item.id)} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-white/75 transition-colors hover:bg-white/5 hover:text-white light:border-gray-200 light:text-gray-700 light:hover:bg-gray-100 light:hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]">
                  Cancel Claim
                </button>
              )}
              {claim.status === "REJECTED" && item && (
                <button onClick={() => onClaimAgain(item)} className="rounded-lg bg-[#FF6D3A] px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-[#e55a2b] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]">
                  Claim Again
                </button>
              )}
            </div>
          </div>

          {isTimelineOpen && (
            <div className="mt-3">
              <ol>
                {timelineSteps.map((step, index) => {
                  const isLast = index === timelineSteps.length - 1;
                  return (
                    <li key={step.key} className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-3">
                      <div className="flex flex-col items-center" aria-hidden="true">
                        <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${step.dotClass}`} />
                        {!isLast && <span className="mt-1.5 w-px flex-1 bg-white/10 light:bg-gray-200" />}
                      </div>
                      <div className={isLast ? "" : "pb-4"}>
                        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                          <p className="text-sm font-semibold text-white light:text-gray-900">{step.label}</p>
                          <p className="text-xs tabular-nums text-white/45 light:text-gray-500">{formatDateTime(step.date)}</p>
                        </div>
                        <p className="mt-0.5 text-xs leading-5 text-white/60 light:text-gray-500">{step.detail}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-4 border-t border-white/[0.06] light:border-gray-200 pt-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-white/45 light:text-gray-500">Proof of ownership</p>
                <p className="mt-1 whitespace-pre-line break-words text-sm leading-6 text-white/80 light:text-gray-700">{claim.proof || "No proof text"}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

interface ClaimTimelineStep {
  key: string;
  label: string;
  date: string | null;
  detail: string;
  /** Marker colour on the history line, matching the step's status colour. */
  dotClass: string;
}

function buildClaimTimeline(claim: ClaimData, item: LostItem | null): ClaimTimelineStep[] {
  const itemName = item?.itemName ?? "this item";
  const steps: ClaimTimelineStep[] = [
    {
      key: "submitted",
      label: "Claim Submitted",
      date: claim.claimDate,
      detail: `Your proof for ${itemName} was submitted for staff review.`,
      dotClass: "bg-amber-300",
    },
  ];

  // A no-show was approved first, so its history shows that step too.
  if (claim.status === "VALIDATED" || claim.status === "RELEASED" || claim.noShowAt) {
    steps.push({
      key: "approved",
      label: "Approved",
      date: claim.approvedAt ?? claim.reviewedAt,
      detail: "Staff approved the claim. The item is ready for release once identity is verified.",
      dotClass: "bg-emerald-300",
    });
  }

  if (claim.status === "RELEASED") {
    steps.push({
      key: "released",
      label: "Released",
      date: claim.releasedAt,
      detail: "Staff recorded the item handover and completed this claim.",
      dotClass: "bg-[#8CB9F0]",
    });
  }

  if (claim.status === "REJECTED" && claim.noShowAt) {
    steps.push({
      key: "not-collected",
      label: "Not Collected",
      date: claim.noShowAt,
      detail: "The item wasn't collected by the end of the pickup date, so the claim was closed. It can be claimed again online or at the office.",
      dotClass: "bg-slate-300",
    });
  } else if (claim.status === "REJECTED") {
    steps.push({
      key: "rejected",
      label: "Rejected",
      date: claim.rejectedAt ?? claim.reviewedAt,
      detail: claim.rejectionReason ?? "Staff rejected the claim after review.",
      dotClass: "bg-red-300",
    });
  }

  return steps;
}
