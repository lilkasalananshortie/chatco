"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { MapContainer, Marker, Popup, Polyline, Circle } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { COMMUTER_PIN_SIZE, commuterPinHtml } from "@/components/maps/commuter-pin";
import { busMarkerIcon } from "@/components/maps/bus-marker-icon";
import { tripLabel, unitHeading, type TripDirection } from "@/lib/shared/map/trip-direction";
import { haversineMeters } from "@/lib/utils/geo";
import type { ConductorHailRequest } from "@/lib/conductor/types";
import { useRouteGeometry } from "@/hooks/use-route-geometry";
import DynamicRouteViewport from "@/components/maps/dynamic-route-viewport";
import UnitPopup, { capacityTone } from "@/components/maps/unit-popup";
import { MAP_COLORS } from "@/components/maps/map-theme";
import MapBasemap from "@/components/maps/map-basemap";
import { useCommuterTheme } from "@/contexts/commuter-theme-context";

const RADIUS_M = 1000;
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

interface ConductorMapProps {
  unitNumber?: string;
  hails?: ConductorHailRequest[];
  capacityStatus?: "Available" | "Standing" | "Full";
  isOnBreak?: boolean;
  tripDirection?: TripDirection;
  canOperate?: boolean;
  hailBusyId?: string | null;
  onHailAction?: (hailId: string, action: "accept" | "reject") => void;
}

function getDistanceMeters(a: [number, number], b: [number, number]): number {
  return haversineMeters(a[0], a[1], b[0], b[1]);
}

export default function ConductorMap({
  unitNumber = "—",
  hails = [],
  capacityStatus = "Available",
  isOnBreak = false,
  tripDirection = "FORWARD",
  canOperate = false,
  hailBusyId = null,
  onHailAction,
}: ConductorMapProps) {
  const routeGeometry = useRouteGeometry(ROUTE_COORDS);
  // Conductor app theme (shared context); stays dark on routes not yet light-ready.
  const theme = useCommuterTheme();
  const mapColors = MAP_COLORS[theme];
  const [isDomReady, setIsDomReady] = useState(false);
  const [vehiclePosition, setVehiclePosition] = useState<L.LatLngTuple>(routeGeometry.center);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let raf2: number | undefined;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (!cancelled && typeof document !== "undefined") {
          setIsDomReady(true);
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (raf2 !== undefined) cancelAnimationFrame(raf2);
    };
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setVehiclePosition([position.coords.latitude, position.coords.longitude]);
      },
      () => {
        setVehiclePosition(routeGeometry.center);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [routeGeometry.center]);

  const visibleHails = useMemo(
    () =>
      hails.filter(
        (hail) =>
          getDistanceMeters(
            [vehiclePosition[0], vehiclePosition[1]],
            [hail.latitude, hail.longitude]
          ) <= RADIUS_M
      ),
    [hails, vehiclePosition]
  );

  const markerPresentation = useMemo(() => {
    if (isOnBreak) {
      return { color: "#38BDF8", label: "On Break" };
    }
    if (capacityStatus === "Standing") {
      return { color: "#FBBF24", label: "Standing" };
    }
    if (capacityStatus === "Full") {
      return { color: "#F87171", label: "Full" };
    }
    return { color: "#34D399", label: "Available" };
  }, [capacityStatus, isOnBreak]);

  // Conductor's own unit: bus image + trip arrow along the route. Break state
  // overrides the capacity dot because the unit is temporarily unavailable
  // even though its saved capacity stays.
  const vehicleIcon = useMemo(() => busMarkerIcon({
    heading: unitHeading(routeGeometry.routeCoords, vehiclePosition[0], vehiclePosition[1], tripDirection),
    statusColor: markerPresentation.color,
  }), [routeGeometry.routeCoords, vehiclePosition, tripDirection, markerPresentation]);

  // Hailing Commuter Marker — MDI account icon on Signal Orange
  const hailingIcon = useMemo(() => new L.DivIcon({
    className: "custom-hailing-icon",
    html: commuterPinHtml("#FF6D3A"),
    iconSize: [COMMUTER_PIN_SIZE, COMMUTER_PIN_SIZE],
    iconAnchor: [COMMUTER_PIN_SIZE / 2, COMMUTER_PIN_SIZE / 2],
    popupAnchor: [0, -(COMMUTER_PIN_SIZE / 2 + 4)],
  }), []);

  if (!isDomReady) {
    return <div ref={containerRef} className="absolute inset-0" style={{ background: mapColors.surface }} />;
  }

  return (
    <>
      <MapContainer
        center={routeGeometry.center}
        zoom={12}
        zoomControl={false}
        attributionControl={false}
        className="w-full h-full"
        style={{ background: mapColors.surface }}
        maxBounds={routeGeometry.mapBoundsArray}
        maxBoundsViscosity={1.0}
        minZoom={11}
      >
        <DynamicRouteViewport routeBounds={routeGeometry.routeBounds} mapBounds={routeGeometry.mapBounds} limitZoomOutToRoute />
        <MapBasemap theme={theme} />

        <Polyline positions={routeGeometry.routeCoords} pathOptions={{ color: mapColors.route, weight: 8, opacity: 0.2, lineCap: 'round', lineJoin: 'round' }} />
        <Polyline positions={routeGeometry.routeCoords} pathOptions={{ color: mapColors.route, weight: 4, opacity: 0.9, dashArray: '10 10', lineCap: 'round', lineJoin: 'round' }} />

        {/* 1km Radius Circle — conductor's operational pickup zone */}
        {/* Neutral (white on dark, navy on light) so the zone doesn't compete
            with the marker, which already carries the capacity/break colour. */}
        <Circle center={vehiclePosition} radius={RADIUS_M} pathOptions={{ color: mapColors.neutral, fillColor: mapColors.neutral, fillOpacity: 0.05, weight: 1.5, opacity: 0.3, dashArray: '8 4' }} />

        <Marker position={vehiclePosition} icon={vehicleIcon}>
          <UnitPopup
            title={unitNumber}
            subtitle="Your unit"
            status={{ label: markerPresentation.label, tone: isOnBreak ? "info" : capacityTone(capacityStatus) }}
            details={[
              { label: "Route", value: tripLabel(tripDirection) },
              ...(isOnBreak ? [{ label: "Capacity", value: capacityStatus }] : []),
            ]}
          />
        </Marker>

        {/* Keep waiting commuters above the conductor's vehicle when icons overlap. */}
        {visibleHails.map((hail) => (
          <Marker key={hail.id} position={[hail.latitude, hail.longitude]} icon={hailingIcon} zIndexOffset={1000}>
            <Popup closeButton={false}>
              <div className="min-w-[180px]">
                <div className="font-bold text-[#FF6D3A]">Commuter</div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      <style jsx global>{`
        .custom-bus-icon, .custom-hailing-icon {
          background: transparent !important;
          border: none !important;
        }
        .leaflet-container {
          background: ${mapColors.surface} !important;
          font-family: inherit !important;
        }
        .leaflet-popup-content-wrapper {
          background: white !important;
          border-radius: 12px !important;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15) !important;
          padding: 0 !important;
        }
        .leaflet-popup-content {
          margin: 12px 16px !important;
          color: #071A2E !important;
          line-height: 1.4 !important;
        }
        .leaflet-popup-tip {
          background: white !important;
        }
        .leaflet-popup-close-button {
          color: #071A2E !important;
        }
      `}</style>
    </>
  );
}
