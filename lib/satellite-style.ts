import type { SpatialEntity } from "@/lib/spatial";
import type { TleRecord } from "@/lib/celestrak";

export type SatelliteClassKey =
  | "station"
  | "nav"
  | "geo"
  | "starlink"
  | "oneweb"
  | "iridium"
  | "visual";

export type SatelliteFilter = "all" | SatelliteClassKey;

export const SATELLITE_CLASSES: Record<SatelliteClassKey, {
  label: string;
  color: string;
  blurb: string;
  pixelSize: number;
}> = {
  station: {
    label: "STATION",
    color: "#fff6e5",
    blurb: "Crewed stations and visiting vehicles",
    pixelSize: 8,
  },
  nav: {
    label: "NAV",
    color: "#4fd8ff",
    blurb: "GNSS navigation satellites",
    pixelSize: 5.8,
  },
  geo: {
    label: "GEO",
    color: "#c89bff",
    blurb: "Geostationary communications and weather belt",
    pixelSize: 6,
  },
  starlink: {
    label: "STARLINK",
    color: "#86efac",
    blurb: "SpaceX Starlink LEO constellation",
    pixelSize: 4.8,
  },
  oneweb: {
    label: "ONEWEB",
    color: "#f9a8d4",
    blurb: "OneWeb LEO constellation",
    pixelSize: 4.8,
  },
  iridium: {
    label: "IRIDIUM",
    color: "#fdba74",
    blurb: "Iridium NEXT constellation",
    pixelSize: 5,
  },
  visual: {
    label: "VISUAL",
    color: "#9fb3c4",
    blurb: "Other propagated catalog objects",
    pixelSize: 5,
  },
};

export const SATELLITE_FILTERS: SatelliteFilter[] = [
  "all",
  "station",
  "starlink",
  "oneweb",
  "iridium",
  "nav",
  "geo",
  "visual",
];

export function satelliteClassForName(name: string, altitudeMeters = 0): SatelliteClassKey {
  const upper = String(name || "").toUpperCase();
  if (/ISS|TIANHE|TIANGONG|CREW DRAGON|CYGNUS|PROGRESS|SOYUZ/.test(upper)) return "station";
  if (/STARLINK/.test(upper)) return "starlink";
  if (/ONEWEB/.test(upper)) return "oneweb";
  if (/IRIDIUM/.test(upper)) return "iridium";
  if (/GPS|NAVSTAR|GLONASS|GALILEO/.test(upper)) return "nav";
  if (altitudeMeters >= 30_000_000 && altitudeMeters <= 45_000_000) return "geo";
  return "visual";
}

export function satelliteClassForRecord(record: TleRecord): SatelliteClassKey {
  return satelliteClassForName(record.name);
}

export function satelliteClassForEntity(entity: SpatialEntity): SatelliteClassKey {
  const explicit = String(entity.properties.satelliteClass ?? "") as SatelliteClassKey;
  if (explicit && explicit in SATELLITE_CLASSES) return explicit;
  return satelliteClassForName(entity.name, entity.position.altitudeMeters);
}

export function satelliteMatchesFilter(entity: SpatialEntity, filter: SatelliteFilter) {
  return filter === "all" || satelliteClassForEntity(entity) === filter;
}

export function tallySatelliteClasses(entities: SpatialEntity[]) {
  const counts: Record<SatelliteClassKey, number> = {
    station: 0,
    nav: 0,
    geo: 0,
    starlink: 0,
    oneweb: 0,
    iridium: 0,
    visual: 0,
  };
  for (const entity of entities) counts[satelliteClassForEntity(entity)] += 1;
  return counts;
}
