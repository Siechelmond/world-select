import type { SpatialEntity } from "@/lib/spatial";

type Elements = {
  name: string;
  a0: number; aRate: number;
  e0: number; eRate: number;
  i0: number; iRate: number;
  l0: number; lRate: number;
  peri0: number; periRate: number;
  node0: number; nodeRate: number;
};

// JPL Solar System Dynamics, Table 2a: approximate planetary positions,
// valid for 3000 BC to 3000 AD.
const ELEMENTS: Elements[] = [
  { name: "Mercury", a0: 0.38709843, aRate: 0, e0: 0.20563661, eRate: 0.00002123, i0: 7.00559432, iRate: -0.00590158, l0: 252.25166724, lRate: 149472.67486623, peri0: 77.45771895, periRate: 0.15940013, node0: 48.33961819, nodeRate: -0.12214182 },
  { name: "Venus", a0: 0.72332102, aRate: -0.00000026, e0: 0.00676399, eRate: -0.00005107, i0: 3.39777545, iRate: 0.00043494, l0: 181.97970850, lRate: 58517.81560260, peri0: 131.76755713, periRate: 0.05679648, node0: 76.67261496, nodeRate: -0.27274174 },
  { name: "Earth", a0: 1.00000018, aRate: -0.00000003, e0: 0.01673163, eRate: -0.00003661, i0: -0.00054346, iRate: -0.01337178, l0: 100.46691572, lRate: 35999.37306329, peri0: 102.93005885, periRate: 0.31795260, node0: -5.11260389, nodeRate: -0.24123856 },
  { name: "Mars", a0: 1.52371243, aRate: 0.00000097, e0: 0.09336511, eRate: 0.00009149, i0: 1.85181869, iRate: -0.00724757, l0: -4.56813164, lRate: 19140.29934243, peri0: -23.91744784, periRate: 0.45223625, node0: 49.71320984, nodeRate: -0.26852431 },
  { name: "Jupiter", a0: 5.20248019, aRate: -0.00002864, e0: 0.04853590, eRate: 0.00018026, i0: 1.29861416, iRate: -0.00322699, l0: 34.33479152, lRate: 3034.90371757, peri0: 14.27495244, periRate: 0.18199196, node0: 100.29282654, nodeRate: 0.13024619 },
  { name: "Saturn", a0: 9.54149883, aRate: -0.00003065, e0: 0.05550825, eRate: -0.00032044, i0: 2.49424102, iRate: 0.00451969, l0: 50.07571329, lRate: 1222.11494724, peri0: 92.86136063, periRate: 0.54179478, node0: 113.63998702, nodeRate: -0.25015002 },
  { name: "Uranus", a0: 19.18797948, aRate: -0.00020455, e0: 0.04685740, eRate: -0.00001550, i0: 0.77298127, iRate: -0.00180155, l0: 314.20276625, lRate: 428.49512595, peri0: 172.43404441, periRate: 0.09266985, node0: 73.96250215, nodeRate: 0.05739699 },
  { name: "Neptune", a0: 30.06952752, aRate: 0.00006447, e0: 0.00895439, eRate: 0.00000818, i0: 1.77005520, iRate: 0.00022400, l0: 304.22289287, lRate: 218.46515314, peri0: 46.68158724, periRate: 0.01009938, node0: 131.78635853, nodeRate: -0.00606302 },
];

const EXTRA: Record<string, [number, number, number, number]> = {
  Jupiter: [-0.00012452, 0.06064060, -0.35635438, 38.35125],
  Saturn: [0.00025899, -0.13434469, 0.87320147, 38.35125],
  Uranus: [0.00058331, -0.97731848, 0.17689245, 7.67025],
  Neptune: [-0.00041348, 0.68346318, -0.10162547, 7.67025],
};

const DEG = Math.PI / 180;
const normalize = (v: number) => ((v + 180) % 360 + 360) % 360 - 180;

function julianDate(date: Date) {
  return date.getTime() / 86400000 + 2440587.5;
}

function solveKepler(meanAnomalyDeg: number, eccentricity: number) {
  const m = meanAnomalyDeg * DEG;
  let e = m + eccentricity * Math.sin(m);
  for (let i = 0; i < 12; i += 1) {
    const delta = (e - eccentricity * Math.sin(e) - m) / (1 - eccentricity * Math.cos(e));
    e -= delta;
    if (Math.abs(delta) < 1e-10) break;
  }
  return e;
}

export type PlanetPosition = {
  entity: SpatialEntity;
  xAu: number;
  yAu: number;
  zAu: number;
  radiusAu: number;
};

export function computePlanetPositions(date: Date): PlanetPosition[] {
  const t = (julianDate(date) - 2451545.0) / 36525;

  return ELEMENTS.map((p) => {
    const a = p.a0 + p.aRate * t;
    const e = p.e0 + p.eRate * t;
    const inc = (p.i0 + p.iRate * t) * DEG;
    const l = p.l0 + p.lRate * t;
    const peri = p.peri0 + p.periRate * t;
    const node = (p.node0 + p.nodeRate * t) * DEG;
    const omega = (peri - (p.node0 + p.nodeRate * t)) * DEG;
    const extra = EXTRA[p.name];
    const extraM = extra ? extra[0] * t * t + extra[1] * Math.cos(extra[3] * t * DEG) + extra[2] * Math.sin(extra[3] * t * DEG) : 0;
    const mDeg = normalize(l - peri + extraM);
    const ecc = solveKepler(mDeg, e);
    const xp = a * (Math.cos(ecc) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(ecc);

    const cosO = Math.cos(omega); const sinO = Math.sin(omega);
    const cosN = Math.cos(node); const sinN = Math.sin(node);
    const cosI = Math.cos(inc); const sinI = Math.sin(inc);

    const x = (cosO * cosN - sinO * sinN * cosI) * xp + (-sinO * cosN - cosO * sinN * cosI) * yp;
    const y = (cosO * sinN + sinO * cosN * cosI) * xp + (-sinO * sinN + cosO * cosN * cosI) * yp;
    const z = sinO * sinI * xp + cosO * sinI * yp;
    const radius = Math.sqrt(x * x + y * y + z * z);

    return {
      xAu: x,
      yAu: y,
      zAu: z,
      radiusAu: radius,
      entity: {
        id: `jpl:${p.name.toLowerCase()}`,
        kind: "celestial-body",
        name: p.name,
        position: { longitude: Math.atan2(y, x) / DEG, latitude: Math.atan2(z, Math.hypot(x, y)) / DEG, altitudeMeters: radius * 149_597_870_700 },
        observedAt: date.toISOString(),
        dataState: "CALCULATED",
        source: { id: "jpl-approx", label: "NASA/JPL Solar System Dynamics", url: "https://ssd.jpl.nasa.gov/planets/approx_pos.html" },
        properties: {
          heliocentricDistanceAu: Number(radius.toFixed(4)),
          xAu: Number(x.toFixed(4)), yAu: Number(y.toFixed(4)), zAu: Number(z.toFixed(4)),
          model: "JPL approximate Keplerian elements (3000 BC–3000 AD)",
        },
      },
    };
  });
}

export function sunEntity(date: Date): SpatialEntity {
  return {
    id: "solar:sun",
    kind: "celestial-body",
    name: "Sun",
    position: { longitude: 0, latitude: 0, altitudeMeters: 0 },
    observedAt: date.toISOString(),
    dataState: "CALCULATED",
    source: { id: "jpl-approx", label: "NASA/JPL Solar System Dynamics", url: "https://ssd.jpl.nasa.gov/planets/orbits.html" },
    properties: { frame: "heliocentric origin", heliocentricDistanceAu: 0 },
  };
}

export type MoonSpec = {
  name: string;
  radiusKm: number;
  orbitalRadiusKm: number;
  orbitalPeriodDays: number;
  color: string;
};

const PLANET_MOONS: Record<string, MoonSpec[]> = {
  Earth: [
    { name: "Moon", radiusKm: 1737.4, orbitalRadiusKm: 384400, orbitalPeriodDays: 27.3217, color: "#d6d3d1" },
  ],
  Mars: [
    { name: "Phobos", radiusKm: 11.3, orbitalRadiusKm: 9376, orbitalPeriodDays: 0.3189, color: "#a8a29e" },
    { name: "Deimos", radiusKm: 6.2, orbitalRadiusKm: 23463, orbitalPeriodDays: 1.2624, color: "#78716c" },
  ],
  Jupiter: [
    { name: "Io", radiusKm: 1821.6, orbitalRadiusKm: 421700, orbitalPeriodDays: 1.769, color: "#facc15" },
    { name: "Europa", radiusKm: 1560.8, orbitalRadiusKm: 671100, orbitalPeriodDays: 3.551, color: "#e7e5e4" },
    { name: "Ganymede", radiusKm: 2634.1, orbitalRadiusKm: 1070400, orbitalPeriodDays: 7.155, color: "#a8a29e" },
    { name: "Callisto", radiusKm: 2410.3, orbitalRadiusKm: 1882700, orbitalPeriodDays: 16.689, color: "#78716c" },
  ],
  Saturn: [
    { name: "Mimas", radiusKm: 198.2, orbitalRadiusKm: 185539, orbitalPeriodDays: 0.942, color: "#d6d3d1" },
    { name: "Enceladus", radiusKm: 252.1, orbitalRadiusKm: 238042, orbitalPeriodDays: 1.37, color: "#f8fafc" },
    { name: "Tethys", radiusKm: 531.1, orbitalRadiusKm: 294672, orbitalPeriodDays: 1.888, color: "#d6d3d1" },
    { name: "Dione", radiusKm: 561.4, orbitalRadiusKm: 377415, orbitalPeriodDays: 2.737, color: "#cbd5e1" },
    { name: "Rhea", radiusKm: 763.8, orbitalRadiusKm: 527068, orbitalPeriodDays: 4.518, color: "#d6d3d1" },
    { name: "Titan", radiusKm: 2574.7, orbitalRadiusKm: 1221870, orbitalPeriodDays: 15.945, color: "#f59e0b" },
    { name: "Iapetus", radiusKm: 734.5, orbitalRadiusKm: 3560820, orbitalPeriodDays: 79.3215, color: "#a8a29e" },
  ],
  Uranus: [
    { name: "Miranda", radiusKm: 235.8, orbitalRadiusKm: 129390, orbitalPeriodDays: 1.413, color: "#e2e8f0" },
    { name: "Ariel", radiusKm: 578.9, orbitalRadiusKm: 191020, orbitalPeriodDays: 2.52, color: "#cbd5e1" },
    { name: "Umbriel", radiusKm: 584.7, orbitalRadiusKm: 266300, orbitalPeriodDays: 4.144, color: "#64748b" },
    { name: "Titania", radiusKm: 788.9, orbitalRadiusKm: 435910, orbitalPeriodDays: 8.706, color: "#d6d3d1" },
    { name: "Oberon", radiusKm: 761.4, orbitalRadiusKm: 583520, orbitalPeriodDays: 13.463, color: "#94a3b8" },
  ],
  Neptune: [
    { name: "Triton", radiusKm: 1353.4, orbitalRadiusKm: 354759, orbitalPeriodDays: 5.877, color: "#cbd5e1" },
    { name: "Nereid", radiusKm: 170, orbitalRadiusKm: 5513818, orbitalPeriodDays: 360.14, color: "#94a3b8" },
  ],
};

export function getPlanetMoons(planetName: string): MoonSpec[] {
  return PLANET_MOONS[planetName] ?? [];
}

export function moonEntity(parentName: string, moon: MoonSpec, date: Date): SpatialEntity {
  return {
    id: `moon:${parentName.toLowerCase()}:${moon.name.toLowerCase()}`,
    kind: "celestial-body",
    name: moon.name,
    position: { longitude: 0, latitude: 0, altitudeMeters: moon.orbitalRadiusKm * 1000 },
    observedAt: date.toISOString(),
    dataState: "SIMULATED",
    source: {
      id: "world-select-moon-model",
      label: "NASA fact data + World Select circular orbit visualization",
    },
    properties: {
      category: "moon",
      parentBody: parentName,
      radiusKm: moon.radiusKm,
      orbitalRadiusKm: moon.orbitalRadiusKm,
      orbitalPeriodDays: moon.orbitalPeriodDays,
      model: "Circular display orbit for spatial exploration; not a precision ephemeris",
      visualScale: "Moon distances and sizes expanded for visibility",
    },
  };
}

export type OuterBodySpec = {
  name: string;
  distanceAu: number;
  category: string;
  color: string;
};

export const OUTER_BODIES: OuterBodySpec[] = [
  { name: "Pluto", distanceAu: 39.48, category: "dwarf planet / Kuiper Belt", color: "#d6d3d1" },
  { name: "Haumea", distanceAu: 43.13, category: "dwarf planet / Kuiper Belt", color: "#e2e8f0" },
  { name: "Makemake", distanceAu: 45.79, category: "dwarf planet / Kuiper Belt", color: "#f59e0b" },
  { name: "Eris", distanceAu: 67.67, category: "dwarf planet / scattered disc", color: "#cbd5e1" },
];

export function outerBodyEntity(spec: OuterBodySpec, date: Date): SpatialEntity {
  return {
    id: `outer:${spec.name.toLowerCase()}`,
    kind: "celestial-body",
    name: spec.name,
    position: { longitude: 0, latitude: 0, altitudeMeters: spec.distanceAu * 149_597_870_700 },
    observedAt: date.toISOString(),
    dataState: "ESTIMATED",
    source: { id: "outer-system-reference", label: "NASA/JPL reference orbit scale" },
    properties: {
      category: spec.category,
      heliocentricDistanceAu: spec.distanceAu,
      model: "Representative orbital scale; current true anomaly is not shown in this view",
      visualScale: "Kuiper Belt density is illustrative",
    },
  };
}
