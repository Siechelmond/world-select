import * as satellite from "satellite.js";
import type { SpatialEntity } from "@/lib/spatial";

const STATIONS_TLE = "https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=TLE";

type TleRecord = { name: string; line1: string; line2: string };

function parseTle(text: string): TleRecord[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out: TleRecord[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    if (!lines[i + 1].startsWith("1 ") || !lines[i + 2].startsWith("2 ")) continue;
    out.push({ name: lines[i], line1: lines[i + 1], line2: lines[i + 2] });
  }
  return out;
}

export async function fetchStationSatellites(at: Date, signal?: AbortSignal): Promise<SpatialEntity[]> {
  const response = await fetch(STATIONS_TLE, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`CelesTrak returned HTTP ${response.status}`);
  const records = parseTle(await response.text());
  const gmst = satellite.gstime(at);

  return records.flatMap((record) => {
    try {
      const satrec = satellite.twoline2satrec(record.line1, record.line2);
      const propagated = satellite.propagate(satrec, at);
      if (!propagated || !propagated.position || typeof propagated.position === "boolean") return [];
      const gd = satellite.eciToGeodetic(propagated.position, gmst);
      const longitude = satellite.degreesLong(gd.longitude);
      const latitude = satellite.degreesLat(gd.latitude);
      const altitudeMeters = gd.height * 1000;
      const norad = record.line1.slice(2, 7).trim();
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
          propagation: "SGP4 from current GP/TLE",
        },
      } satisfies SpatialEntity];
    } catch {
      return [];
    }
  });
}
