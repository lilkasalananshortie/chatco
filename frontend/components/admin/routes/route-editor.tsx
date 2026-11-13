"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, GitBranch, ListPlus, Loader2, LocateFixed, MapPin, Plus, Save, Trash2, WandSparkles } from "lucide-react";
import { MapContainer, Marker, Polyline, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { FarePoint } from "@/lib/admin/services/fare-point.service";
import {
  previewRoadGeometry,
  saveRouteGeometry,
  type AdminRoute,
  type RouteCoordinate,
} from "@/lib/admin/services/route.service";

interface RouteEditorProps {
  route: AdminRoute;
  farePoints: FarePoint[];
  onRouteChanged: () => Promise<void> | void;
  onEditFarePoint?: (pointNumber: number) => void;
}

function numberedIcon(index: number, needsAttention = false) {
  const background = needsAttention ? "#DC2626" : "#1A5FB4";
  const border = needsAttention ? "#FCA5A5" : "#93C5FD";
  return L.divIcon({
    className: "route-editor-marker",
    html: `<div style="width:28px;height:28px;border-radius:999px;background:${background};color:white;border:2px solid ${border};display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;box-shadow:0 3px 12px rgba(0,0,0,.45)">${index + 1}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function RouteMapEvents({ onAdd }: { onAdd: (coordinate: RouteCoordinate) => void }) {
  useMapEvents({
    click(event) {
      onAdd([event.latlng.lat, event.latlng.lng]);
    },
  });
  return null;
}

function FitGeometry({ coordinates, routeId, request }: { coordinates: RouteCoordinate[]; routeId: string; request: number }) {
  const map = useMap();
  const lastFit = useRef<{ routeId: string | null; request: number }>({ routeId: null, request: -1 });

  useEffect(() => {
    const routeChanged = lastFit.current.routeId !== routeId;
    const manuallyRequested = lastFit.current.request !== request;
    if ((routeChanged || manuallyRequested) && coordinates.length >= 2) {
      map.fitBounds(L.latLngBounds(coordinates).pad(0.08), { animate: false });
    }
    if (routeChanged || manuallyRequested) lastFit.current = { routeId, request };
  }, [coordinates, map, request, routeId]);

  return null;
}

function formatSavedDate(value: string | null) {
  if (!value) return "Not saved yet";
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function insertionIndexFor(coordinates: RouteCoordinate[], point: RouteCoordinate) {
  if (coordinates.length < 2) return coordinates.length;

  const latitudeScale = Math.cos((point[0] * Math.PI) / 180);
  const pointX = point[1] * latitudeScale;
  const pointY = point[0];
  let closestIndex = 1;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const startX = coordinates[index][1] * latitudeScale;
    const startY = coordinates[index][0];
    const endX = coordinates[index + 1][1] * latitudeScale;
    const endY = coordinates[index + 1][0];
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const projection = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / lengthSquared));
    const projectedX = startX + projection * deltaX;
    const projectedY = startY + projection * deltaY;
    const distance = (pointX - projectedX) ** 2 + (pointY - projectedY) ** 2;

    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index + 1;
    }
  }

  return closestIndex;
}

// One live line per route: Save replaces it in place (no drafts, versions or
// temporary detours). Fare Point moves never change it; rebuild from Point
// Areas, generate, and save to make the line follow them.
export default function RouteEditor({ route, farePoints, onRouteChanged, onEditFarePoint }: RouteEditorProps) {
  const activeGeometry = route.geometry;
  const [waypoints, setWaypoints] = useState<RouteCoordinate[]>([]);
  const [previewGeometry, setPreviewGeometry] = useState<RouteCoordinate[]>([]);
  const [isRouting, setIsRouting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapClickMode, setMapClickMode] = useState<"insert" | "append">("insert");
  const [waypointSource, setWaypointSource] = useState<"route" | "fare_points" | "manual">("route");
  const [detourWarnings, setDetourWarnings] = useState<Array<{ from_index: number; to_index: number }>>([]);
  const [fitRequest, setFitRequest] = useState(0);

  useEffect(() => {
    setWaypoints(route.waypoints.length >= 2 ? route.waypoints : route.geometry);
    setPreviewGeometry(route.geometry);
    setWaypointSource("route");
    setDetourWarnings([]);
  }, [route]);

  useEffect(() => {
    setMessage(null);
    setError(null);
  }, [route.id]);

  const displayedGeometry = previewGeometry.length >= 2 ? previewGeometry : activeGeometry;
  const mapCenter = useMemo<L.LatLngTuple>(() => {
    const source = displayedGeometry.length ? displayedGeometry : [[14.82, 120.86] as RouteCoordinate];
    const bounds = L.latLngBounds(source);
    return [bounds.getCenter().lat, bounds.getCenter().lng];
  }, [displayedGeometry]);

  const markDirty = (nextWaypoints: RouteCoordinate[]) => {
    setWaypoints(nextWaypoints);
    setPreviewGeometry(nextWaypoints);
    setMessage("Control points changed. Generate the road path, then save the route.");
    setError(null);
    setDetourWarnings([]);
  };

  const addWaypoint = (coordinate: RouteCoordinate) => {
    setWaypointSource("manual");
    if (mapClickMode === "append" || waypoints.length < 2) {
      markDirty([...waypoints, coordinate]);
      return;
    }

    const next = [...waypoints];
    next.splice(insertionIndexFor(waypoints, coordinate), 0, coordinate);
    markDirty(next);
  };

  const moveWaypoint = (index: number, coordinate: RouteCoordinate) => {
    setWaypointSource("manual");
    const next = [...waypoints];
    next[index] = coordinate;
    markDirty(next);
  };

  const removeWaypoint = (index: number) => {
    setWaypointSource("manual");
    markDirty(waypoints.filter((_, waypointIndex) => waypointIndex !== index));
  };

  const moveWaypointOrder = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= waypoints.length) return;
    const next = [...waypoints];
    setWaypointSource("manual");
    [next[index], next[target]] = [next[target], next[index]];
    markDirty(next);
  };

  const useFarePoints = () => {
    const coordinates = farePoints
      .filter((point) => point.latitude !== null && point.longitude !== null)
      .sort((a, b) => a.point_number - b.point_number)
      .map((point) => [Number(point.latitude), Number(point.longitude)] as RouteCoordinate);

    if (coordinates.length < 2) {
      setError("Add coordinates to at least two Fare Points first.");
      return;
    }
    setMapClickMode("insert");
    markDirty(coordinates);
    setWaypointSource("fare_points");
    setMessage("Point Areas loaded. Generate a smart preview; the live route stays safe if any old pin is misplaced.");
  };

  const useActiveRoute = () => {
    if (route.geometry.length < 2) return;
    setWaypoints(route.waypoints.length >= 2 ? route.waypoints : route.geometry);
    setPreviewGeometry(route.geometry);
    setMapClickMode("insert");
    setWaypointSource("route");
    setDetourWarnings([]);
    setMessage("Live route loaded for editing.");
    setError(null);
  };

  const generateRoadPath = async () => {
    if (waypoints.length < 2) {
      setError("Add at least two control points.");
      return;
    }
    setIsRouting(true);
    setError(null);
    try {
      const preview = await previewRoadGeometry(waypoints);
      setWaypoints(preview.snapped_waypoints);
      setDetourWarnings(preview.warnings);
      if (preview.warnings.length > 0 && waypointSource === "fare_points" && activeGeometry.length >= 2) {
        setPreviewGeometry(activeGeometry);
        setMessage(null);
      } else {
        setPreviewGeometry(preview.geometry);
        setMessage(preview.warnings.length > 0
          ? "Preview generated with possible detours highlighted. Review it before saving."
          : `Road preview generated with ${preview.geometry.length} geometry points. Control points were snapped to nearby roads.`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to generate the road path.");
    } finally {
      setIsRouting(false);
    }
  };

  const warningWaypointIndexes = useMemo(() => new Set(
    detourWarnings.flatMap((warning) => [warning.from_index, warning.to_index])
  ), [detourWarnings]);

  const affectedFarePoints = useMemo(() => {
    if (waypointSource !== "fare_points") return [];
    return Array.from(warningWaypointIndexes)
      .map((index) => farePoints[index])
      .filter((point): point is FarePoint => Boolean(point));
  }, [farePoints, warningWaypointIndexes, waypointSource]);

  const saveRoute = async () => {
    if (waypointSource === "fare_points" && detourWarnings.length > 0) {
      setError("Fix the highlighted Point Area locations or keep the current live route before saving.");
      return;
    }
    if (waypoints.length < 2 || previewGeometry.length < 2) {
      setError("Generate a valid route preview before saving.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await saveRouteGeometry(route.id, { geometry: previewGeometry, waypoints });
      await onRouteChanged();
      setMessage("Route saved. Tracking and hailing update within one minute.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save the route.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="min-w-0 space-y-4 rounded-2xl border border-[#62A0EA]/20 admin-light:border-[#1A5FB4]/20 bg-[#071A2E] admin-light:bg-white p-5">
      <div className="flex flex-col gap-3 @[40rem]/fare-matrix:flex-row @[40rem]/fare-matrix:items-start @[40rem]/fare-matrix:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitBranch className="shrink-0 text-[#62A0EA] admin-light:text-[#1A5FB4]" size={20} />
            <h2 className="font-bold text-white admin-light:text-slate-900">Route Editor</h2>
          </div>
          <p className="mt-1 max-w-2xl text-xs text-white/45 admin-light:text-slate-500">
            Use Insert Correction to fix a middle street, or Extend Route to add at the end. Drag numbered points to fine-tune. Saving replaces the live route right away.
          </p>
        </div>
        <div className="shrink-0 rounded-xl border border-white/10 admin-light:border-[#CBD5E1] bg-[#050F1A] admin-light:bg-[#F8FAFC] px-4 py-2 text-xs text-white/60 admin-light:text-slate-600">
          <p>Live route: <span className="font-bold text-white admin-light:text-slate-900">{activeGeometry.length >= 2 ? "Saved" : "None"}</span></p>
          <p className="mt-0.5">Last saved {formatSavedDate(activeGeometry.length >= 2 ? route.updated_at : null)}</p>
        </div>
      </div>

      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 admin-light:text-red-700">{error}</div>}
      {message && <div className="flex items-center gap-2 rounded-xl border border-[#1E2D45] bg-[#1A2540] px-4 py-3 text-sm text-slate-200 admin-light:border-[#E2E8F0] admin-light:bg-[#F8FAFC] admin-light:text-slate-700"><CheckCircle2 size={16} aria-hidden="true" className="shrink-0 text-[#62A0EA] admin-light:text-[#1A5FB4]" />{message}</div>}
      {detourWarnings.length > 0 && (
        <div className="rounded-xl border border-[#1E2D45] bg-[#1A2540] px-4 py-3 admin-light:border-[#E2E8F0] admin-light:bg-[#F8FAFC]">
          <p className="flex items-start gap-2 text-sm font-bold text-white admin-light:text-slate-900">
            <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-slate-400 admin-light:text-slate-500" />
            {waypointSource === "fare_points"
              ? "Some old Point Area pins are misplaced. Your live route was kept unchanged."
              : "The preview contains an unusually long road detour."}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-400 admin-light:text-slate-600">
            {waypointSource === "fare_points"
              ? "You can keep using the safe live route now, then correct these locations through the map picker when convenient."
              : "Check the red control points on the map. If the detour is intentional, you may continue and save the route."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {activeGeometry.length >= 2 && (
              <button type="button" onClick={useActiveRoute} className="rounded-lg bg-[#62A0EA] admin-light:bg-[#1A5FB4] px-3 py-2 text-xs font-bold text-white hover:bg-[#4A8BD4] admin-light:hover:bg-[#164A8F]">
                Keep Current Live Route
              </button>
            )}
            {affectedFarePoints.map((point) => (
              <button
                key={point.id}
                type="button"
                onClick={() => onEditFarePoint?.(point.point_number)}
                className="rounded-lg border border-[#2A3A55] bg-[#131C2E] px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-[#1E2D45] admin-light:border-[#CBD5E1] admin-light:bg-white admin-light:text-slate-700 admin-light:hover:bg-[#F1F5F9]"
              >
                Fix {point.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Stack in the drawer; stretch beside the controls when the page has room. */}
      <div className="grid min-w-0 items-stretch gap-4 @[56rem]/fare-matrix:grid-cols-[minmax(0,1fr)_320px]">
        <div className="relative h-120 min-w-0 overflow-hidden rounded-2xl border border-white/10 admin-light:border-[#CBD5E1] @[56rem]/fare-matrix:h-auto @[56rem]/fare-matrix:min-h-120">
          <div className="absolute inset-0">
            <MapContainer center={mapCenter} zoom={12} className="h-full w-full" attributionControl>
              <TileLayer
                url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              />
              {activeGeometry.length >= 2 && (
                <Polyline positions={activeGeometry} pathOptions={{ color: "#64748B", weight: 6, opacity: 0.45 }} />
              )}
              {previewGeometry.length >= 2 && (
                <Polyline positions={previewGeometry} pathOptions={{ color: "#60A5FA", weight: 5, opacity: 0.95 }} />
              )}
              {waypoints.map((coordinate, index) => (
                <Marker
                  key={`${index}-${coordinate[0]}-${coordinate[1]}`}
                  position={coordinate}
                  icon={numberedIcon(index, warningWaypointIndexes.has(index))}
                  draggable
                  eventHandlers={{
                    dragend(event) {
                      const next = event.target.getLatLng();
                      moveWaypoint(index, [next.lat, next.lng]);
                    },
                  }}
                />
              ))}
              <RouteMapEvents onAdd={addWaypoint} />
              <FitGeometry coordinates={displayedGeometry} routeId={route.id} request={fitRequest} />
            </MapContainer>
          </div>
        </div>

        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 admin-light:border-[#CBD5E1] bg-[#050F1A] admin-light:bg-[#F8FAFC] p-1.5">
            <button
              type="button"
              onClick={() => setMapClickMode("insert")}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-bold transition-colors ${mapClickMode === "insert" ? "bg-[#1A5FB4] text-white" : "text-white/45 admin-light:text-slate-500 hover:bg-white/5 admin-light:hover:bg-slate-100"}`}
            >
              <ListPlus size={13} /> Insert Correction
            </button>
            <button
              type="button"
              onClick={() => setMapClickMode("append")}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[11px] font-bold transition-colors ${mapClickMode === "append" ? "bg-[#1A5FB4] text-white" : "text-white/45 admin-light:text-slate-500 hover:bg-white/5 admin-light:hover:bg-slate-100"}`}
            >
              <Plus size={13} /> Extend Route
            </button>
          </div>
          <p className="px-1 text-[10px] leading-relaxed text-white/35 admin-light:text-slate-500">
            {mapClickMode === "insert"
              ? "Click the intended road near a wrong middle segment. The correction is inserted at the closest part of the route."
              : "Click roads in travel order. Each click is added after the current final point."}
          </p>

          <button type="button" onClick={() => setFitRequest((current) => current + 1)} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 admin-light:border-[#CBD5E1] px-3 py-2.5 text-xs font-semibold text-white/60 admin-light:text-slate-600 hover:bg-white/5 admin-light:hover:bg-slate-100">
            <LocateFixed size={14} /> Fit Entire Route
          </button>

          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={useActiveRoute} disabled={activeGeometry.length < 2} className="rounded-xl bg-white/5 admin-light:bg-slate-100 px-3 py-2.5 text-xs font-semibold text-white/70 admin-light:text-slate-700 hover:bg-white/10 admin-light:hover:bg-slate-200 disabled:opacity-40">
              Edit Live Route
            </button>
            <button type="button" onClick={useFarePoints} className="rounded-xl bg-white/5 admin-light:bg-slate-100 px-3 py-2.5 text-xs font-semibold text-white/70 admin-light:text-slate-700 hover:bg-white/10 admin-light:hover:bg-slate-200">
              Build from Point Areas
            </button>
          </div>

          <button type="button" onClick={() => { setMapClickMode("append"); setWaypointSource("manual"); markDirty([]); }} className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-500/20 px-3 py-2.5 text-xs font-semibold text-red-300 admin-light:text-red-700 hover:bg-red-500/10">
            <Trash2 size={14} /> Clear Control Points
          </button>

          <div className="max-h-44 space-y-1 overflow-y-auto rounded-xl border border-white/10 admin-light:border-[#CBD5E1] bg-[#050F1A] admin-light:bg-[#F8FAFC] p-2">
            {waypoints.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-white/30 admin-light:text-slate-500">Click the map to add points.</p>
            ) : waypoints.map((coordinate, index) => (
              <div key={`${coordinate[0]}-${coordinate[1]}-list`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 admin-light:hover:bg-slate-100">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#1A5FB4] text-[9px] font-bold text-white">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[10px] text-white/50 admin-light:text-slate-600">{coordinate[0].toFixed(6)}, {coordinate[1].toFixed(6)}</span>
                <button type="button" onClick={() => moveWaypointOrder(index, -1)} disabled={index === 0} className="text-white/40 admin-light:text-slate-500 disabled:opacity-20">↑</button>
                <button type="button" onClick={() => moveWaypointOrder(index, 1)} disabled={index === waypoints.length - 1} className="text-white/40 admin-light:text-slate-500 disabled:opacity-20">↓</button>
                <button type="button" onClick={() => removeWaypoint(index)} className="text-red-300/70 admin-light:text-red-600">×</button>
              </div>
            ))}
          </div>

          <button type="button" onClick={generateRoadPath} disabled={isRouting || waypoints.length < 2} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 admin-light:border-[#CBD5E1] bg-[#0E2238] admin-light:bg-white px-4 py-3 text-sm font-bold text-white admin-light:text-slate-800 hover:bg-[#13304D] admin-light:hover:bg-slate-100 disabled:opacity-40">
            {isRouting ? <Loader2 className="animate-spin" size={16} /> : <WandSparkles size={16} />}
            Generate Road Preview
          </button>

          <button type="button" onClick={saveRoute} disabled={isSaving || previewGeometry.length < 2 || waypoints.length < 2 || (waypointSource === "fare_points" && detourWarnings.length > 0)} className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1A5FB4] px-4 py-3 text-sm font-bold text-white hover:bg-[#164A8F] disabled:opacity-40">
            {isSaving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
            Save Route
          </button>
        </div>
      </div>

      <p className="flex items-start gap-1.5 text-[10px] text-white/30 admin-light:text-slate-500">
        <MapPin size={12} className="shrink-0" /> The gray line is live. The blue line is the preview. Saving replaces the live line for tracking and route coverage; the previous line is not kept.
      </p>
    </section>
  );
}
