"use client";

import { useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { MapContainer, Marker, Popup, Polyline, useMap, useMapEvents, Circle, Tooltip } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { COMMUTER_PIN_SIZE, commuterPinHtml } from "@/components/maps/commuter-pin";
import { busMarkerIcon } from "@/components/maps/bus-marker-icon";
import { tripLabel, unitHeading, type TripDirection } from "@/lib/shared/map/trip-direction";
import { formatElapsedMinutes } from "@/lib/utils/display";
import { useRouteGeometry } from "@/hooks/use-route-geometry";
import DynamicRouteViewport from "@/components/maps/dynamic-route-viewport";
import UnitPopup, { capacityTone } from "@/components/maps/unit-popup";
import { MAP_COLORS } from "@/components/maps/map-theme";
import MapBasemap from "@/components/maps/map-basemap";
import { useAdminTheme } from "@/contexts/admin-theme-context";

// --- 1. TYPES (kept — these define the API contract) ---
type VehicleCapacity = "AVAILABLE" | "STANDING" | "FULL";

export interface ActiveVehicle {
  id: string;
  plateNumber: string;
  driverName: string;
  conductorName: string;
  routeIndex: number;
  capacity: VehicleCapacity;
}

// Live vehicle from GET /api/admin/monitoring — uses real GPS coordinates
// instead of route-index-based positions, and includes a stale flag.
export interface LiveVehicleMarker {
  id: string;
  unit_number: string;
  plate_number: string;
  lat: number;
  lng: number;
  speed: number | null;
  capacity: VehicleCapacity;
  route_name: string | null;
  driver_name: string | null;
  conductor_name: string | null;
  is_on_break: boolean;
  break_duration_minutes: number | null;
  is_stale: boolean;
  minutes_since_update: number | null;
  trip_direction: TripDirection;
}

export interface CommuterData {
  id: number;
  name: string;
  latlng: [number, number];
  locationDetail: string;
}

export interface DemandZone {
  id: string;
  coords: [number, number];
  radiusMeters: number;
  commuterCount: number;
  intensity: 'LOW' | 'MEDIUM' | 'HIGH';
}

// --- 2. ROUTE DATA (static geometry — stays) ---
const ROUTE_COORDS: [number, number][] = [
  [14.925460996033356, 120.76512235423647], [14.92420402124189, 120.76528787872712],
  [14.920152600670095, 120.76571706129354], [14.915220582966443, 120.76619717003261],
  [14.901323759501945, 120.7719224852731], [14.886458903875173, 120.78596796657541],
  [14.874990764897628, 120.79618423260841], [14.87207763773181, 120.79878589058617],
  [14.865745283697539, 120.80435407290116], [14.860501402001871, 120.80901802051571],
  [14.85778433148678, 120.81163478600241], [14.855388331987022, 120.81368996254061],
  [14.852693386081329, 120.81600207219617], [14.851497406805521, 120.81765988586791],
  [14.849417900874624, 120.8235248577769], [14.845945790029823, 120.83422329239757],
  [14.844320234352493, 120.83905948176812], [14.842383282603786, 120.84506982184078],
  [14.841893283760905, 120.84698408093634], [14.840375174197046, 120.85413496987503],
  [14.839623777400517, 120.85750998638694], [14.838634008132473, 120.86201040680506],
  [14.8371385749864, 120.86297382674883], [14.83612807323988, 120.86333412418747],
  [14.835254069547146, 120.86366551171416], [14.833295288398967, 120.8661891975047],
  [14.8324975199314, 120.86740282879738], [14.831810284552892, 120.86868877790535],
  [14.83035944532852, 120.87094580599025], [14.828506904517909, 120.87400904071411],
  [14.828161518510791, 120.87659402671414], [14.828232464378223, 120.88095495481001],
  [14.828293590064265, 120.88426507598852], [14.828333307002257, 120.886565917288],
  [14.827864597760719, 120.89053477186802], [14.827464358080183, 120.89241460779954],
  [14.826703652032982, 120.89503763480697], [14.826129391774803, 120.89676317509107],
  [14.824720294651351, 120.89902058487867], [14.822990488146456, 120.90083394930517],
  [14.820845909007058, 120.90316146076532], [14.819825636767673, 120.90421208848784],
  [14.818163498638592, 120.90600984388941], [14.81713926187142, 120.90792339416925],
  [14.817003259236085, 120.90825980129833], [14.815860883789151, 120.90986972578348],
  [14.815234108397684, 120.91047524129526], [14.81440037604567, 120.91144161960287],
  [14.813099510668458, 120.91283614016609], [14.811588723108294, 120.91413585780512],
  [14.809543338082284, 120.9159455873501], [14.806525108118892, 120.91850689602882],
  [14.801946360221512, 120.92201682737273], [14.800215165075755, 120.9231979150914],
  [14.798804712598924, 120.92456195413324], [14.798451222604799, 120.92693781063585],
  [14.797677687963592, 120.92897276863408], [14.79630282892156, 120.92974647714638],
  [14.794082971006238, 120.9309174591896], [14.792193992873402, 120.9319309517239],
  [14.789984757130886, 120.93194351724061], [14.786542900321203, 120.93179853039794],
  [14.782758056853037, 120.93416554556896], [14.78116722012781, 120.93525425025881],
  [14.778139275650638, 120.93709526206992], [14.773104742636574, 120.93960422042926],
  [14.766525006702839, 120.94320546363049], [14.765525492192376, 120.94401383576125],
  [14.76072862621141, 120.94974045073359], [14.757057921030993, 120.95282600874056],
  [14.754092913022339, 120.95430633290394], [14.749614776242218, 120.95648776807238],
  [14.743004859115217, 120.95912082860627], [14.738243986091819, 120.96064278809952],
  [14.73118850798765, 120.96137476925526], [14.729202256905156, 120.96135109408412],
  [14.725646764905104, 120.9604838112117]
];

// --- 3. HELPER FUNCTIONS ---
function getBearing(start: [number, number], end: [number, number]): number {
  const startLat = start[0] * Math.PI / 180;
  const endLat = end[0] * Math.PI / 180;
  const dLng = (end[1] - start[1]) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(endLat);
  const x = Math.cos(startLat) * Math.sin(endLat) - Math.sin(startLat) * Math.cos(endLat) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const getCapacityConfig = (capacity: VehicleCapacity) => {
  switch (capacity) {
    case "AVAILABLE": return { color: "#22c55e", label: "Available" };
    case "STANDING": return { color: "#eab308", label: "Standing" };
    case "FULL": return { color: "#ef4444", label: "Full" };
  }
};

function LocationFinder({
  userLocationRef, setUserActualLocation, setShowMapPin, setArrowPos, routeBounds, mapBounds
}: {
  userLocationRef: React.MutableRefObject<[number, number] | null>;
  setUserActualLocation: (loc: [number, number] | null) => void;
  setShowMapPin: (val: boolean) => void;
  setArrowPos: (pos: { x: number; y: number; angle: number } | null) => void;
  routeBounds: L.LatLngBounds;
  mapBounds: L.LatLngBounds;
}) {
  const map = useMap();

  // locate({ watch: true }) fires locationfound on EVERY GPS tick. Without
  // these guards each tick re-ran flyTo/setView with a hard-coded zoom, so the
  // admin's own zoom level was yanked back (out to 13, or down to 16) every few
  // seconds while watching live units. Auto-center is a one-time courtesy on
  // the first fix, and it defers to any manual navigation — matching the
  // commuter map's LocationFinder, which already worked this way.
  const hasInitialCenteredRef = useRef(false);
  const userInteractedRef = useRef(false);

  useMapEvents({
    locationfound(e) {
      const { lat, lng } = e.latlng;
      const userCoords: [number, number] = [lat, lng];
      setUserActualLocation(userCoords);
      userLocationRef.current = userCoords;

      const userLatLng = L.latLng(lat, lng);
      setShowMapPin(true);

      // Marker position always updates above; only the camera is guarded.
      if (hasInitialCenteredRef.current || userInteractedRef.current) return;

      if (routeBounds.contains(userLatLng)) {
        setArrowPos(null);
        map.flyTo([lat, lng], 16, { duration: 1.5 });
      } else if (mapBounds.contains(userLatLng)) {
        setArrowPos(null);
        map.setView([lat, lng], 13, { animate: true });
      }
      hasInitialCenteredRef.current = true;
    },
    locationerror(e) {
      console.error("Location access denied:", e.message);
    },
    move() {
      const userCoords = userLocationRef.current;
      if (!userCoords) return;

      const userLatLng = L.latLng(userCoords[0], userCoords[1]);
      const bounds = map.getBounds();

      if (bounds.contains(userLatLng)) {
        setArrowPos(null);
        return;
      }

      const center = map.getCenter();
      const angle = getBearing([center.lat, center.lng], userCoords);

      const dx = Math.sin(angle * Math.PI / 180);
      const dy = -Math.cos(angle * Math.PI / 180);

      const safeMinX = 5; const safeMaxX = 95;
      const safeMinY = 15; const safeMaxY = 75;

      let tX = Infinity; let tY = Infinity;

      if (dx > 0) tX = (safeMaxX - 50) / dx;
      else if (dx < 0) tX = (safeMinX - 50) / dx;
      if (dy > 0) tY = (safeMaxY - 50) / dy;
      else if (dy < 0) tY = (safeMinY - 50) / dy;

      const t = Math.min(tX, tY);

      setArrowPos({ x: 50 + (t * dx), y: 50 + (t * dy), angle: angle });
    },
    dragstart() {
      map.closePopup();
      userInteractedRef.current = true;
    },
    zoomstart() {
      userInteractedRef.current = true;
    },
  });

  useEffect(() => {
    map.locate({ setView: false, maxZoom: 16, enableHighAccuracy: true, timeout: 10000, watch: true });
    // Without stopLocate the geolocation watch outlives the component, so a
    // remount stacks a second watcher on the same map and locationfound fires
    // multiple times per tick.
    return () => {
      map.stopLocate();
    };
  }, [map]);

  return null;
}

// --- 4. MAIN COMPONENT ---
/**
 * Pans/zooms the map to `target` whenever it changes. Purely a camera move —
 * every marker stays mounted, so focusing one unit never hides the others.
 * `nonce` lets the caller re-trigger a fly-to for a target already focused
 * (clicking the same row twice).
 */
function MapFocuser({ target, nonce }: { target?: [number, number] | null; nonce?: number }) {
  const map = useMap();

  useEffect(() => {
    if (!target) return;
    map.flyTo(target, 16, { duration: 1.2 });
  }, [map, target, nonce]);

  return null;
}

const VEHICLE_ANIMATION_MS = 4_800;
const VEHICLE_SNAP_DISTANCE_M = 1_500;

/**
 * Leaflet normally teleports a marker whenever its `position` prop changes.
 * Keep that prop stable and move the underlying marker between GPS samples so
 * the admin sees continuous motion during the five-second polling interval.
 */
function SmoothVehicleMarker({
  position,
  icon,
  zIndexOffset,
  children,
}: {
  position: [number, number];
  icon: L.DivIcon;
  zIndexOffset: number;
  children?: ReactNode;
}) {
  const markerRef = useRef<L.Marker | null>(null);
  const [initialPosition] = useState<[number, number]>(() => position);
  const animationFrameRef = useRef<number | null>(null);
  const [targetLat, targetLng] = position;

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;

    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    const start = marker.getLatLng();
    const target = L.latLng(targetLat, targetLng);
    const distance = start.distanceTo(target);

    if (distance < 0.5) return;

    // A very large change is normally a corrected/bad GPS sample. Snapping is
    // safer than visibly driving the marker across unrelated roads.
    if (distance > VEHICLE_SNAP_DISTANCE_M) {
      marker.setLatLng(target);
      return;
    }

    const startedAt = performance.now();
    const startLat = start.lat;
    const startLng = start.lng;
    const latDelta = target.lat - startLat;
    const lngDelta = target.lng - startLng;

    const animate = (now: number) => {
      const progress = Math.min((now - startedAt) / VEHICLE_ANIMATION_MS, 1);
      const eased = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;

      marker.setLatLng([
        startLat + latDelta * eased,
        startLng + lngDelta * eased,
      ]);

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        animationFrameRef.current = null;
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [targetLat, targetLng]);

  return (
    <Marker
      ref={markerRef}
      position={initialPosition}
      icon={icon}
      zIndexOffset={zIndexOffset}
    >
      {children}
    </Marker>
  );
}

export default function AdminCommuterMap({
  isDesktop = false,
  vehicles = [],
  liveVehicles = [],
  commuters = [],
  demandZones = [],
  focusPosition,
  focusNonce,
  showOwnLocation = false,
}: {
  isDesktop?: boolean;
  vehicles?: ActiveVehicle[];
  liveVehicles?: LiveVehicleMarker[];
  commuters?: CommuterData[];
  demandZones?: DemandZone[];
  /** Camera target — pans here without filtering any markers out. */
  focusPosition?: [number, number] | null;
  /** Bump to re-focus the same coordinates again. */
  focusNonce?: number;
  /** Track and pin the viewer's own GPS location. Off for admins, who don't ride. */
  showOwnLocation?: boolean;
}) {
  const routeGeometry = useRouteGeometry(ROUTE_COORDS);
  // Dark outside the admin app (the public share page renders this map too).
  const [theme] = useAdminTheme();
  const mapColors = MAP_COLORS[theme];
  const [isDomReady, setIsDomReady] = useState(false);
  const [userActualLocation, setUserActualLocation] = useState<[number, number] | null>(null);
  const [showMapPin, setShowMapPin] = useState(false);
  const [, setArrowPos] = useState<{ x: number; y: number; angle: number } | null>(null);
  const userLocationRef = useRef<[number, number] | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setIsDomReady(true), 200);
    return () => clearTimeout(timer);
  }, []);

  const commuterIcon = useMemo(() => new L.DivIcon({
    className: "custom-commuter-icon",
    html: commuterPinHtml("#1A5FB4"),
    iconSize: [COMMUTER_PIN_SIZE, COMMUTER_PIN_SIZE],
    iconAnchor: [COMMUTER_PIN_SIZE / 2, COMMUTER_PIN_SIZE / 2],
  }), []);

  // Bus image + trip arrow (bus-marker-icon.ts). The status dot keeps the old
  // ring's meaning: break wins, then stale (grey, faded, GPS may be
  // outdated after 10 min), then capacity.
  const getBusIcon = (
    lat: number,
    lng: number,
    direction: TripDirection,
    capacity: VehicleCapacity,
    isStale = false,
    isOnBreak = false,
  ) => busMarkerIcon({
    heading: unitHeading(routeGeometry.routeCoords, lat, lng, direction),
    statusColor: isOnBreak ? '#38BDF8' : isStale ? '#94a3b8' : getCapacityConfig(capacity).color,
    dimmed: isStale && !isOnBreak,
  });

  const hailingCommuterIcon = useMemo(() => new L.DivIcon({
    className: "custom-hailing-icon",
    html: commuterPinHtml("#FF6D3A"),
    iconSize: [COMMUTER_PIN_SIZE, COMMUTER_PIN_SIZE],
    iconAnchor: [COMMUTER_PIN_SIZE / 2, COMMUTER_PIN_SIZE / 2],
    popupAnchor: [0, -(COMMUTER_PIN_SIZE / 2 + 4)],
  }), []);

  if (!isDomReady) return <div className="w-full h-full rounded-xl" style={{ background: mapColors.surface }} />;

  return (
    <div className="admin-map-wrapper w-full h-full rounded-xl overflow-hidden">
      <MapContainer
        center={routeGeometry.center}
        zoom={12}
        zoomControl={false}
        attributionControl={false}
        className="admin-map-container"
        style={{ background: mapColors.surface }}
        maxBounds={routeGeometry.mapBoundsArray}
        maxBoundsViscosity={1.0}
        minZoom={11}
        maxZoom={18}
        zoomSnap={1}
      >
        <DynamicRouteViewport routeBounds={routeGeometry.routeBounds} mapBounds={routeGeometry.mapBounds} />
        {showOwnLocation && <LocationFinder userLocationRef={userLocationRef} setUserActualLocation={setUserActualLocation} setShowMapPin={setShowMapPin} setArrowPos={setArrowPos} routeBounds={routeGeometry.routeBounds} mapBounds={routeGeometry.mapBounds} />}
        <MapFocuser target={focusPosition} nonce={focusNonce} />
        <MapBasemap theme={theme} />

        <Polyline positions={routeGeometry.routeCoords} pathOptions={{ color: mapColors.route, weight: 8, opacity: 0.2, lineCap: 'round', lineJoin: 'round' }} />
        <Polyline positions={routeGeometry.routeCoords} pathOptions={{ color: mapColors.route, weight: 4, opacity: 0.9, dashArray: '10 10', lineCap: 'round', lineJoin: 'round' }} />

        {/* --- DEMAND HEATMAP CIRCLES --- */}
        {demandZones.map((zone) => {
          const colorMap = {
            LOW: { fill: '#22c55e', border: '#16a34a' },
            MEDIUM: { fill: '#eab308', border: '#ca8a04' },
            HIGH: { fill: '#ef4444', border: '#dc2626' }
          };
          const colors = colorMap[zone.intensity];

          return (
            <Circle
              key={zone.id}
              center={zone.coords}
              radius={zone.radiusMeters}
              pathOptions={{
                color: colors.border,
                fillColor: colors.fill,
                fillOpacity: 0.2,
                weight: 1,
                opacity: 0.5
              }}
            >
              {isDesktop ? (
                <Tooltip direction="center" permanent>
                  <div className="text-center font-semibold text-xs whitespace-nowrap">
                    <p>{zone.commuterCount}</p>
                  </div>
                </Tooltip>
              ) : (
                <Tooltip direction="top" offset={[0, -5]}>
                  <div className="text-center font-semibold text-xs whitespace-nowrap">
                    <p>{zone.commuterCount} Commuters</p>
                    <p className="font-normal text-[10px] opacity-80">{zone.intensity}</p>
                  </div>
                </Tooltip>
              )}
            </Circle>
          );
        })}

        {showMapPin && userActualLocation && (
          <Marker position={userActualLocation} icon={commuterIcon} zIndexOffset={1000}>
            <Popup>
              <div className="font-bold text-[#071A2E]">You are here</div>
              <div className="text-xs text-gray-500">Live GPS Location</div>
            </Popup>
          </Marker>
        )}

        {/* --- WAITING COMMUTERS --- */}
        {commuters.map((commuter) => (
          <Marker key={commuter.id} position={commuter.latlng} icon={hailingCommuterIcon} zIndexOffset={500}>
            <Popup>
              <div className="font-bold text-[#FF6D3A]">Passenger Waiting ({commuter.name})</div>
              <div className="text-xs text-gray-500">{commuter.locationDetail}</div>
            </Popup>
          </Marker>
        ))}

        {/* --- ACTIVE VEHICLES (route-index based — legacy) --- */}
        {vehicles.map((vehicle) => {
          const config = getCapacityConfig(vehicle.capacity);
          const position = routeGeometry.routeCoords[Math.min(vehicle.routeIndex, routeGeometry.routeCoords.length - 1)];
          return (
            <Marker key={vehicle.id} position={position} icon={getBusIcon(position[0], position[1], "FORWARD", vehicle.capacity)} zIndexOffset={800}>
              <UnitPopup
                title={vehicle.plateNumber}
                status={{ label: config.label, tone: capacityTone(vehicle.capacity) }}
                details={[
                  { label: "Driver", value: vehicle.driverName },
                  { label: "Conductor", value: vehicle.conductorName },
                ]}
                notes={vehicle.capacity === "FULL" ? [{ message: "Not accepting passengers", tone: "danger" }] : []}
              />
            </Marker>
          );
        })}

        {/* --- LIVE VEHICLES (real GPS from /admin/monitoring) --- */}
        {liveVehicles.map((vehicle) => {
          // Skip vehicles without valid coordinates.
          if (vehicle.lat === null || vehicle.lng === null) return null;
          const capacityConfig = getCapacityConfig(vehicle.capacity);
          const statusLabel = vehicle.is_on_break ? 'On break' : capacityConfig.label;
          return (
            <SmoothVehicleMarker
              key={`live-${vehicle.id}`}
              position={[vehicle.lat, vehicle.lng]}
              icon={getBusIcon(vehicle.lat, vehicle.lng, vehicle.trip_direction, vehicle.capacity, vehicle.is_stale, vehicle.is_on_break)}
              zIndexOffset={vehicle.is_stale ? 700 : 800}
            >
              <UnitPopup
                title={vehicle.plate_number}
                status={{ label: statusLabel, tone: vehicle.is_on_break ? "info" : capacityTone(vehicle.capacity) }}
                details={[
                  { label: "Unit", value: vehicle.unit_number },
                  { label: "Driver", value: vehicle.driver_name ?? "—" },
                  { label: "Conductor", value: vehicle.conductor_name ?? "—" },
                  { label: "Route", value: tripLabel(vehicle.trip_direction) },
                  ...(vehicle.is_on_break ? [{ label: "Time on break", value: formatElapsedMinutes(vehicle.break_duration_minutes) }] : []),
                  ...(vehicle.is_on_break ? [{ label: "Capacity", value: capacityConfig.label }] : []),
                  ...(vehicle.speed !== null ? [{ label: "Speed", value: `${vehicle.speed} km/h` }] : []),
                ]}
                notes={[
                  ...(vehicle.capacity === "FULL" && !vehicle.is_on_break ? [{ message: "Not accepting passengers", tone: "danger" as const }] : []),
                  ...(vehicle.is_stale ? [{ message: `GPS delayed — last update ${formatElapsedMinutes(vehicle.minutes_since_update)} ago`, tone: "warning" as const }] : []),
                ]}
              />
            </SmoothVehicleMarker>
          );
        })}
      </MapContainer>

      <style jsx global>{`
        /* 
         * SCOPED WRAPPER FIX
         * Prevents Leaflet from escaping its bounds and hijacking parent scroll 
         */
        .admin-map-wrapper {
          position: relative;
          touch-action: none; /* Forces Leaflet to handle touch, not iOS Safari */
        }

        .admin-map-container {
          width: 100% !important;
          height: 100% !important;
          position: absolute !important;
          inset: 0 !important;
          z-index: 0 !important;
          isolation: isolate !important; /* Traps Leaflet's internal z-indexes */
        }

        .leaflet-container {
          background: ${mapColors.surface} !important;
          font-family: inherit !important;
        }

        .custom-commuter-icon,
        .custom-bus-icon,
        .custom-hailing-icon {
          background: transparent !important;
          border: none !important;
        }

        .leaflet-popup-content-wrapper {
          background: white !important;
          border-radius: 10px !important;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15) !important;
          padding: 0 !important;
          overflow: hidden;
        }

        .leaflet-popup-content {
          margin: 10px 12px !important;
          color: #071A2E !important;
          line-height: 1.4 !important;
        }

        .leaflet-popup-tip {
          background: white !important;
        }

        .leaflet-popup-close-button {
          color: #071A2E !important;
          font-size: 18px !important;
          padding: 6px 8px 0 0 !important;
        }

        .leaflet-tooltip {
          background: #071A2E !important;
          color: white !important;
          border: 1px solid rgba(255,255,255,0.2) !important;
          border-radius: 4px !important;
          padding: 3px 6px !important;
          box-shadow: 0 4px 6px rgba(0,0,0,0.3) !important;
          font-size: 11px !important;
        }

        .leaflet-tooltip-top:before { border-top-color: #071A2E !important; }
        .leaflet-tooltip-bottom:before { border-bottom-color: #071A2E !important; }
        .leaflet-tooltip-left:before { border-left-color: #071A2E !important; }
        .leaflet-tooltip-right:before { border-right-color: #071A2E !important; }
      `}</style>
    </div>
  );
}
