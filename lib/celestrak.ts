import * as satellite from "satellite.js";
import type { SpatialEntity } from "@/lib/spatial";
import { satelliteClassForName } from "@/lib/satellite-style";

export type TleRecord = { name: string; line1: string; line2: string };

export type SatelliteCatalog = "core" | "dense";

export type SatelliteFeedMeta = {
  catalog: SatelliteCatalog;
  totalCount: number;
  groups: string[];
  failedGroups: string[];
  groupCounts: Record<string, number>;
};

export type SatelliteSnapshot = {
  records: TleRecord[];
  meta: SatelliteFeedMeta;
};

type Satrec = ReturnType<typeof satellite.twoline2satrec>;
const SATREC_CACHE = new WeakMap<TleRecord, Satrec>();

function satrecFor(record: TleRecord): Satrec {
  const cached = SATREC_CACHE.get(record);
  if (cached) return cached;
  const satrec = satellite.twoline2satrec(record.line1, record.line2);
  SATREC_CACHE.set(record, satrec);
  return satrec;
}

function parseTle(text: string): TleRecord[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out: TleRecord[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    if (!lines[i + 1].startsWith("1 ") || !lines[i + 2].startsWith("2 ")) continue;
    out.push({ name: lines[i], line1: lines[i + 1], line2: lines[i + 2] });
  }
  return out;
}

function parseList(value: string | null) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseCounts(value: string | null) {
  const counts: Record<string, number> = {};
  for (const token of String(value || "").split(";")) {
    const [key, raw] = token.split("=");
    const count = Number(raw);
    if (key && Number.isFinite(count)) counts[key] = count;
  }
  return counts;
}

export async function fetchStationTles(
  signal?: AbortSignal,
  catalog: SatelliteCatalog = "core",
): Promise<SatelliteSnapshot> {
  const response = await fetch(`/api/satellites?catalog=${catalog}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Satellite proxy returned HTTP ${response.status}`);
  const records = parseTle(await response.text());
  const responseCatalog = response.headers.get("X-World-Select-Satellite-Catalog") === "dense" ? "dense" : "core";
  return {
    records,
    meta: {
      catalog: responseCatalog,
      totalCount: Number(response.headers.get("X-World-Select-Satellite-Count") || records.length),
      groups: parseList(response.headers.get("X-World-Select-Satellite-Groups")),
      failedGroups: parseList(response.headers.get("X-World-Select-Satellite-Failed-Groups")),
      groupCounts: parseCounts(response.headers.get("X-World-Select-Satellite-Group-Counts")),
    },
  };
}

export function propagateTles(records: TleRecord[], at: Date): SpatialEntity[] {
  const gmst = satellite.gstime(at);
  return records.flatMap((record) => {
    try {
      const satrec = satrecFor(record);
      const propagated = satellite.propagate(satrec, at);
      if (!propagated || !propagated.position || typeof propagated.position === "boolean") return [];
      const gd = satellite.eciToGeodetic(propagated.position, gmst);
      const longitude = satellite.degreesLong(gd.longitude);
      const latitude = satellite.degreesLat(gd.latitude);
      const altitudeMeters = gd.height * 1000;
      if (![longitude, latitude, altitudeMeters].every(Number.isFinite)) return [];
      const norad = record.line1.slice(2, 7).trim();
      const satelliteClass = satelliteClassForName(record.name, altitudeMeters);
      return [{
        id: `celestrak:${norad}`,
        kind: "satellite" as const,
        name: record.name,
        position: { longitude, latitude, altitudeMeters },
        observedAt: at.toISOString(),
        dataState: "CALCULATED" as const,
        source: { id: "celestrak-gp", label: "CelesTrak GP / NORAD", url: "https://celestrak.org/NORAD/elements/" },
        properties: {
          noradCatalogNumber: norad,
          altitudeKm: Number((altitudeMeters / 1000).toFixed(1)),
          satelliteClass,
          propagation: "SGP4 from cached current GP/TLE",
        },
      } satisfies SpatialEntity];
    } catch {
      return [];
    }
  });
}

export function propagateTleOrbit(record: TleRecord, at: Date, samples = 160): Array<{ longitude: number; latitude: number; altitudeMeters: number }> {
  try {
    const satrec = satrecFor(record);
    const meanMotion = Number(record.line2.slice(52, 63).trim());
    const periodMinutes = Number.isFinite(meanMotion) && meanMotion > 0 ? Math.max(60, Math.min(1600, 1440 / meanMotion)) : 96;
    const periodMs = periodMinutes * 60_000;
    const points: Array<{ longitude: number; latitude: number; altitudeMeters: number }> = [];
    for (let index = 0; index <= samples; index += 1) {
      const time = new Date(at.getTime() + (index / samples - 0.5) * periodMs);
      const propagated = satellite.propagate(satrec, time);
      if (!propagated?.position || typeof propagated.position === "boolean") continue;
      const gd = satellite.eciToGeodetic(propagated.position, satellite.gstime(time));
      const longitude = satellite.degreesLong(gd.longitude);
      const latitude = satellite.degreesLat(gd.latitude);
      const altitudeMeters = gd.height * 1000;
      if ([longitude, latitude, altitudeMeters].every(Number.isFinite)) points.push({ longitude, latitude, altitudeMeters });
    }
    return points;
  } catch {
    return [];
  }
}

export function propagateTleOrbitEcf(record: TleRecord, at: Date, samples = 180): Array<{ x: number; y: number; z: number }> {
  try {
    const satrec = satrecFor(record);
    const meanMotion = Number(record.line2.slice(52, 63).trim());
    const periodMinutes = Number.isFinite(meanMotion) && meanMotion > 0 ? Math.max(60, Math.min(1600, 1440 / meanMotion)) : 96;
    const periodMs = periodMinutes * 60_000;
    const gmstAtBake = satellite.gstime(at);
    const points: Array<{ x: number; y: number; z: number }> = [];
    for (let index = 0; index <= samples; index += 1) {
      const time = new Date(at.getTime() + (index / samples - 0.5) * periodMs);
      const propagated = satellite.propagate(satrec, time);
      if (!propagated?.position || typeof propagated.position === "boolean") continue;
      const ecf = satellite.eciToEcf(propagated.position, gmstAtBake);
      if ([ecf.x, ecf.y, ecf.z].every(Number.isFinite)) {
        points.push({ x: ecf.x * 1000, y: ecf.y * 1000, z: ecf.z * 1000 });
      }
    }
    return points;
  } catch {
    return [];
  }
}
