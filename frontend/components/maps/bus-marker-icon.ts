// Live unit marker shared by the commuter, admin and conductor maps: one of
// the 8 angled bus images, turned the way the unit travels along its route,
// plus a small arrow just outside the image that follows the route line
// toward the end of the trip (see lib/shared/map/trip-direction.ts).
import L from "leaflet";
import busN from "@/assets/map/bus-iso-n.svg";
import busNE from "@/assets/map/bus-iso-ne.svg";
import busE from "@/assets/map/bus-iso-e.svg";
import busSE from "@/assets/map/bus-iso-se.svg";
import busS from "@/assets/map/bus-iso-s.svg";
import busSW from "@/assets/map/bus-iso-sw.svg";
import busW from "@/assets/map/bus-iso-w.svg";
import busNW from "@/assets/map/bus-iso-nw.svg";
import type { BusFacing, UnitHeading } from "@/lib/shared/map/trip-direction";

type StaticAsset = { src: string } | string;
const src = (asset: StaticAsset) => (typeof asset === "string" ? asset : asset.src);

const BUS_SRC: Record<BusFacing, string> = {
  n: src(busN), ne: src(busNE), e: src(busE), se: src(busSE),
  s: src(busS), sw: src(busSW), w: src(busW), nw: src(busNW),
};

// Source art is 96×84; shown at 52×46 so it sits close to the old 44px pin.
const W = 52;
const H = 46;
const ARROW = 18;
// Ring the arrow travels on: just outside the bus image on every side.
const ORBIT_X = W / 2 + 8;
const ORBIT_Y = H / 2 + 8;

export interface BusMarkerOptions {
  /** Null when there's no usable route line: bus faces down, no arrow. */
  heading: UnitHeading | null;
  /** The marker's existing status colour (capacity, break, stale). */
  statusColor: string;
  /** Admin map: GPS is stale, so the marker is faded. */
  dimmed?: boolean;
}

// Few distinct combinations (8 facings × 24 arrow steps × a handful of
// states), so caching keeps each marker's icon reference stable and Leaflet
// skips setIcon() for units whose look didn't change.
const cache = new Map<string, L.DivIcon>();

export function busMarkerIcon({ heading, statusColor, dimmed = false }: BusMarkerOptions): L.DivIcon {
  const facing = heading?.facing ?? "s";
  const arrow = heading?.arrow ?? null;
  const key = `${facing}|${arrow ?? "-"}|${statusColor}|${dimmed}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // The status dot keeps what the old ring colour showed (capacity, break,
  // stale), now that the marker itself is a picture. It sits on the top corner
  // behind the bus (top-right when facing left, else top-left) so it stays off the front.
  const dotSide = facing === "w" || facing === "nw" || facing === "sw" ? "right:2px" : "left:2px";
  const statusDot = `<span style="position:absolute;${dotSide};top:2px;width:12px;height:12px;border-radius:50%;background:${statusColor};border:2px solid #071A2E;"></span>`;
  // Up-pointing arrow rotated to the trip bearing, sitting on a ring around
  // the bus at that same bearing: heading south-east puts it bottom-right,
  // north-west puts it top-left. White edge reads on light and dark maps.
  const arrowPos = arrow === null ? null : {
    left: W / 2 + ORBIT_X * Math.sin((arrow * Math.PI) / 180) - ARROW / 2,
    top: H / 2 - ORBIT_Y * Math.cos((arrow * Math.PI) / 180) - ARROW / 2,
  };
  const arrowEl = arrowPos === null
    ? ""
    : `<svg width="${ARROW}" height="${ARROW}" viewBox="0 0 24 24" aria-hidden="true" style="position:absolute;left:${arrowPos.left.toFixed(1)}px;top:${arrowPos.top.toFixed(1)}px;transform:rotate(${arrow}deg);">
         <path d="M12 2.5 20 20 12 15.5 4 20Z" fill="#1A5FB4" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
       </svg>`;

  const icon = new L.DivIcon({
    className: "custom-bus-icon",
    html: `<div style="position:relative;width:${W}px;height:${H}px;opacity:${dimmed ? 0.55 : 1};">
             <img src="${BUS_SRC[facing]}" width="${W}" height="${H}" alt="" draggable="false" style="display:block;width:${W}px;height:${H}px;pointer-events:none;" />
             ${statusDot}${arrowEl}
           </div>`,
    iconSize: [W, H],
    iconAnchor: [W / 2, H / 2],
    popupAnchor: [0, -H / 2 - 2],
  });
  cache.set(key, icon);
  return icon;
}
