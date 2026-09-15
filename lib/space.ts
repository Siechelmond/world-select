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
