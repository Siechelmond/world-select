export type DataState =
  | "OBSERVED"
  | "CALCULATED"
  | "ESTIMATED"
  | "SIMULATED"
  | "STALE"
  | "UNAVAILABLE";

export type SpatialEntityKind =
  | "earthquake"
  | "aircraft"
  | "ship"
  | "satellite"
  | "traffic-event"
  | "celestial-body"
  | "spacecraft"
  | "natural-event"
  | "aurora"
  | "weather-observation"
  | "radio-station";

export interface SpatialEntity {
  id: string;
  kind: SpatialEntityKind;
  name: string;
  position: {
    longitude: number;
    latitude: number;
    altitudeMeters: number;
  };
  observedAt: string;
  dataState: DataState;
  source: {
    id: string;
    label: string;
    url?: string;
  };
  properties: Record<string, string | number | boolean | null>;
}
