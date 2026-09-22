"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type WheelEvent } from "react";
import type { SpatialEntity } from "@/lib/spatial";
import type { SpaceLaunch } from "@/lib/launches";
import { fetchTelescopeAsset, fetchTelescopeImages, type TelescopeFilter, type TelescopeImage } from "@/lib/telescope";
import { SATELLITE_CLASSES, satelliteClassForEntity } from "@/lib/satellite-style";
import {
  getPlanetMoons,
  moonEntity,
  OUTER_BODIES,
  outerBodyEntity,
  type PlanetPosition,
} from "@/lib/space";

export type SpaceLevel = "orbit" | "planet" | "solar" | "outer" | "galaxy";

type Props = {
  planets: PlanetPosition[];
  satellites: SpatialEntity[];
  sun: SpatialEntity;
  time: Date;
  launches: SpaceLaunch[];
  launchState: "idle" | "loading" | "ready" | "degraded" | "error";
  onSelect: (entity: SpatialEntity) => void;
  onReturnEarth: () => void;
  earthHandoff: { latitude: number; longitude: number; height: number } | null;
  initialLevel: SpaceLevel;
};

const LEVELS: SpaceLevel[] = ["orbit", "planet", "solar", "outer", "galaxy"];
const LEVEL_LABELS: Record<SpaceLevel, string> = {
  orbit: "EARTH ORBIT",
  planet: "PLANET SYSTEM",
  solar: "SOLAR SYSTEM",
  outer: "KUIPER BELT",
  galaxy: "MILKY WAY",
};


const PLANET_PALETTE: Record<string, [string, string, string]> = {
  Mercury: ["#e7e5e4", "#a8a29e", "#57534e"],
  Venus: ["#fef3c7", "#f59e0b", "#92400e"],
  Earth: ["#cffafe", "#0ea5e9", "#164e63"],
  Mars: ["#fed7aa", "#ea580c", "#7c2d12"],
  Jupiter: ["#fef3c7", "#d6b38a", "#92400e"],
  Saturn: ["#fff7ed", "#fcd34d", "#a16207"],
  Uranus: ["#ecfeff", "#67e8f9", "#155e75"],
  Neptune: ["#dbeafe", "#3b82f6", "#312e81"],
};

const PLANET_RADII: Record<string, number> = {
  Mercury: 28,
  Venus: 38,
  Earth: 39,
  Mars: 33,
  Jupiter: 78,
  Saturn: 70,
  Uranus: 55,
  Neptune: 54,
};

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function phaseFor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 33 + name.charCodeAt(i)) >>> 0;
  return hash % 360;
}

function deterministicBeltPoints(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const a = ((index * 137.50776405) % 360) * Math.PI / 180;
    const band = 300 + ((index * 47) % 116);
    const wobble = Math.sin(index * 1.73) * 13;
    return {
      x: 500 + Math.cos(a) * (band + wobble),
      y: 500 + Math.sin(a) * (band * 0.55 + wobble * 0.35),
      r: 1 + (index % 4) * 0.32,
      opacity: 0.18 + (index % 7) * 0.06,
    };
  });
}

function galaxySpiralPath(arm: number, radiusOffset = 0) {
  const points = Array.from({ length: 92 }, (_, index) => {
    const t = index / 91;
    const radius = 48 + radiusOffset + t * 355;
    const angle = arm * Math.PI / 2 + 0.22 + t * 5.15;
    const x = 500 + Math.cos(angle) * radius;
    const y = 500 + Math.sin(angle) * radius * 0.53;
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return points.join(' ');
}

function deterministicGalaxyStars() {
  const stars: Array<{ x: number; y: number; r: number; opacity: number; warm: boolean }> = [];
  for (let arm = 0; arm < 4; arm += 1) {
    for (let index = 0; index < 105; index += 1) {
      const t = (index + 4) / 109;
      const jitter = Math.sin(index * 12.9898 + arm * 78.233) * 19 + Math.sin(index * 2.17 + arm) * 8;
      const angleJitter = Math.sin(index * 5.37 + arm * 11.1) * 0.055;
      const radius = 42 + t * 365 + jitter;
      const angle = arm * Math.PI / 2 + 0.22 + t * 5.15 + angleJitter;
      stars.push({
        x: 500 + Math.cos(angle) * radius,
        y: 500 + Math.sin(angle) * radius * 0.53,
        r: 0.8 + ((index * 7 + arm * 3) % 5) * 0.34,
        opacity: 0.28 + ((index * 13 + arm) % 7) * 0.085,
        warm: (index + arm * 2) % 11 === 0,
      });
    }
  }
  for (let index = 0; index < 170; index += 1) {
    const angle = ((index * 137.50776405) % 360) * Math.PI / 180;
    const radial = 62 + ((index * 53) % 350);
    stars.push({
      x: 500 + Math.cos(angle) * radial,
      y: 500 + Math.sin(angle) * radial * 0.53,
      r: 0.55 + (index % 3) * 0.25,
      opacity: 0.12 + (index % 5) * 0.045,
      warm: false,
    });
  }
  return stars;
}

function deterministicGalaxyClouds() {
  const clouds: Array<{ x: number; y: number; rx: number; ry: number; rotate: number; opacity: number; warm: boolean }> = [];
  for (let arm = 0; arm < 4; arm += 1) {
    for (let index = 0; index < 20; index += 1) {
      const t = (index + 2) / 23;
      const radius = 58 + t * 338 + Math.sin(index * 3.1 + arm) * 10;
      const angle = arm * Math.PI / 2 + 0.22 + t * 5.15 + Math.sin(index * 1.7 + arm) * 0.04;
      clouds.push({
        x: 500 + Math.cos(angle) * radius,
        y: 500 + Math.sin(angle) * radius * 0.53,
        rx: 25 + ((index * 7 + arm) % 5) * 8,
        ry: 7 + ((index * 5 + arm) % 4) * 3,
        rotate: angle * 180 / Math.PI + 90,
        opacity: 0.055 + ((index + arm) % 5) * 0.014,
        warm: index < 5,
      });
    }
  }
  return clouds;
}

export default function SpaceExplorer({ planets, satellites, sun, time, launches, launchState, onSelect, onReturnEarth, earthHandoff, initialLevel }: Props) {
  const [level, setLevel] = useState<SpaceLevel>(initialLevel);
  const [focusedPlanet, setFocusedPlanet] = useState<string>("Earth");
  const lastWheelAt = useRef(0);
  const planet = planets.find((item) => item.entity.name === focusedPlanet) ?? planets[2] ?? planets[0];
  const [telescopeOpen, setTelescopeOpen] = useState(false);
  const [telescopeFilter, setTelescopeFilter] = useState<TelescopeFilter>("jwst");
  const [telescopeDraft, setTelescopeDraft] = useState("");
  const [telescopeQuery, setTelescopeQuery] = useState("");
  const [telescopeItems, setTelescopeItems] = useState<TelescopeImage[]>([]);
  const [telescopeState, setTelescopeState] = useState<"idle" | "loading" | "ready" | "degraded" | "error">("idle");
  const [telescopeError, setTelescopeError] = useState<string | null>(null);
  const [telescopeSelected, setTelescopeSelected] = useState<TelescopeImage | null>(null);
  const [telescopeAssetUrl, setTelescopeAssetUrl] = useState<string | null>(null);
  const [telescopeAssetState, setTelescopeAssetState] = useState<"idle" | "loading" | "ready" | "degraded">("idle");

  useEffect(() => {
    if (!telescopeOpen) return;
    const controller = new AbortController();
    setTelescopeState("loading");
    setTelescopeError(null);

    fetchTelescopeImages(telescopeFilter, telescopeQuery, controller.signal)
      .then((feed) => {
        if (controller.signal.aborted) return;
        setTelescopeItems(feed.items);
        setTelescopeState(feed.degraded || !feed.items.length ? "degraded" : "ready");
        setTelescopeSelected((current) =>
          current && feed.items.some((item) => item.id === current.id) ? current : null
        );
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setTelescopeItems([]);
        setTelescopeState("error");
        setTelescopeError(reason instanceof Error ? reason.message : "Telescope image source unavailable");
      });

    return () => controller.abort();
  }, [telescopeOpen, telescopeFilter, telescopeQuery]);

  useEffect(() => {
    if (!telescopeOpen || !telescopeSelected) {
      setTelescopeAssetUrl(null);
      setTelescopeAssetState("idle");
      return;
    }

    const controller = new AbortController();
    setTelescopeAssetUrl(telescopeSelected.thumbnailUrl);
    setTelescopeAssetState("loading");
    fetchTelescopeAsset(telescopeSelected, controller.signal)
      .then((imageUrl) => {
        if (controller.signal.aborted) return;
        setTelescopeAssetUrl(imageUrl ?? telescopeSelected.thumbnailUrl);
        setTelescopeAssetState(imageUrl ? "ready" : "degraded");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setTelescopeAssetUrl(telescopeSelected.thumbnailUrl);
        setTelescopeAssetState("degraded");
      });

    return () => controller.abort();
  }, [telescopeOpen, telescopeSelected]);

  const changeLevel = (next: SpaceLevel) => {
    if (next === "planet" && !planet) return;
    setTelescopeOpen(false);
    setLevel(next);
  };

  const zoomBy = (direction: -1 | 1) => {
    if (telescopeOpen) return;
    if (level === "orbit" && direction < 0) {
      onReturnEarth();
      return;
    }
    const index = LEVELS.indexOf(level);
    const nextIndex = Math.max(0, Math.min(LEVELS.length - 1, index + direction));
    setLevel(LEVELS[nextIndex]);
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (telescopeOpen) return;
    const now = Date.now();
    if (now - lastWheelAt.current < 320 || Math.abs(event.deltaY) < 18) return;
    event.preventDefault();
    lastWheelAt.current = now;
    zoomBy(event.deltaY > 0 ? 1 : -1);
  };

  const openPlanet = (item: PlanetPosition) => {
    setTelescopeOpen(false);
    setFocusedPlanet(item.entity.name);
    setLevel("planet");
    onSelect(item.entity);
  };

  return (
    <div className="spaceScene spaceExplorer" onWheel={onWheel}>
      <div className="spaceEarthHandoff glass">
        <button type="button" onClick={onReturnEarth}>← EARTH</button>
        <span>ORBIT HANDOFF</span>
        <small>{earthHandoff
          ? `${earthHandoff.latitude.toFixed(2)}°, ${earthHandoff.longitude.toFixed(2)}° · Earth camera preserved`
          : "Earth camera preserved for return"}</small>
      </div>
      <div className="spaceTitle">
        <span>{telescopeOpen ? "TELESCOPE VIEW" : LEVEL_LABELS[level]}</span>
        <small>
          {telescopeOpen
            ? "Official telescope observations · NASA Images + ESA/Webb + Hubble Science · archive/release content"
            : <>
              {level === "orbit" && `Earth orbital frame · ${satellites.length} propagated CelesTrak objects available`}
              {level === "planet" && `${focusedPlanet} system · moon sizes and distances expanded for visibility`}
              {level === "solar" && "JPL approximate heliocentric positions · logarithmic display scale"}
              {level === "outer" && "Named dwarf-planet orbit scales · Kuiper density illustrative"}
              {level === "galaxy" && "Milky Way context · Solar System marker is schematic"}
            </>}
        </small>
      </div>

      <div className="spaceScaleControls glass" role="group" aria-label="Space scale">
        {LEVELS.map((item) => (
          <button
            key={item}
            className={!telescopeOpen && level === item ? "active" : ""}
            disabled={item === "planet" && !planet}
            onClick={() => changeLevel(item)}
          >
            {item === "planet" ? focusedPlanet.toUpperCase() : LEVEL_LABELS[item]}
          </button>
        ))}
        <button
          className={telescopeOpen ? "active telescopeControl" : "telescopeControl"}
          onClick={() => setTelescopeOpen((open) => !open)}
        >
          TELESCOPE
        </button>
      </div>

      {!telescopeOpen && <div className="spaceZoomHint">scroll to travel scale · + / − changes spatial frame</div>}
      {!telescopeOpen && <div className="spaceZoomButtons glass" aria-label="Space zoom">
        <button onClick={() => zoomBy(-1)}>+</button>
        <button onClick={() => zoomBy(1)} disabled={level === "galaxy"}>−</button>
      </div>}

      {telescopeOpen ? (
        <TelescopeView
          items={telescopeItems}
          state={telescopeState}
          error={telescopeError}
          filter={telescopeFilter}
          draft={telescopeDraft}
          selected={telescopeSelected}
          assetUrl={telescopeAssetUrl}
          assetState={telescopeAssetState}
          onFilter={(filter) => {
            setTelescopeFilter(filter);
            setTelescopeSelected(null);
          }}
          onDraft={setTelescopeDraft}
          onSearch={(event) => {
            event.preventDefault();
            setTelescopeQuery(telescopeDraft.trim());
            setTelescopeSelected(null);
          }}
          onSelect={setTelescopeSelected}
          onClose={() => setTelescopeOpen(false)}
        />
      ) : (
        <>
          {level === "orbit" && (
            <>
              <OrbitView satellites={satellites} onSelect={onSelect} onReturnEarth={onReturnEarth} />
              <KeylessLaunchPanel launches={launches} state={launchState} />
            </>
          )}
          {level === "planet" && planet && (
            <PlanetSystemView planet={planet} time={time} onSelect={onSelect} onBack={() => setLevel("solar")} />
          )}
          {level === "solar" && (
            <>
              <SolarSystemView planets={planets} sun={sun} onSelect={onSelect} onOpenPlanet={openPlanet} />
              <KeylessLaunchPanel launches={launches} state={launchState} />
              <div className="spaceMissionFacts glass"><strong>SPACECRAFT</strong><span><b>JWST</b> — Sun–Earth L2 region, about 1.5 million km from Earth. Context position, not live telemetry.</span></div>
            </>
          )}
          {level === "outer" && <>
            <OuterSystemView time={time} onSelect={onSelect} onSolar={() => setLevel("solar")} />
            <div className="spaceMissionFacts outerFacts glass"><strong>DEEP-SPACE PROBES</strong><span><b>New Horizons</b> — ~9.5 billion km from Earth in June 2026, beyond Pluto and the classical Kuiper Belt.</span><span><b>Voyager 1 / 2</b> — both in interstellar space; Voyager 1 is the most distant human-made object.</span></div>
          </>}
          {level === "galaxy" && <GalaxyView onSolar={() => setLevel("solar")} />}
        </>
      )}
    </div>
  );
}


function TelescopeView({
  items,
  state,
  error,
  filter,
  draft,
  selected,
  assetUrl,
  assetState,
  onFilter,
  onDraft,
  onSearch,
  onSelect,
  onClose,
}: {
  items: TelescopeImage[];
  state: "idle" | "loading" | "ready" | "degraded" | "error";
  error: string | null;
  filter: TelescopeFilter;
  draft: string;
  selected: TelescopeImage | null;
  assetUrl: string | null;
  assetState: "idle" | "loading" | "ready" | "degraded";
  onFilter: (filter: TelescopeFilter) => void;
  onDraft: (value: string) => void;
  onSearch: (event: FormEvent<HTMLFormElement>) => void;
  onSelect: (item: TelescopeImage | null) => void;
  onClose: () => void;
}) {
  const filters: Array<{ id: TelescopeFilter; label: string }> = [
    { id: "jwst", label: "JWST" },
    { id: "hubble", label: "HUBBLE" },
    { id: "other", label: "OTHER SPACE TELESCOPES" },
    { id: "solar-system", label: "SOLAR SYSTEM" },
    { id: "galaxies", label: "GALAXIES" },
    { id: "nebulae", label: "NEBULAE" },
    { id: "stars-clusters", label: "STARS / CLUSTERS" },
  ];

  return (
    <section className="telescopeView" aria-label="Telescope astronomy imagery">
      <div className="telescopeToolbar glass">
        <div className="telescopeFilterRow" role="group" aria-label="Telescope source filter">
          {filters.map((item) => (
            <button
              key={item.id}
              className={filter === item.id ? "active" : ""}
              onClick={() => onFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <form className="telescopeSearch" onSubmit={onSearch}>
          <input
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            placeholder="Search nebula, galaxy, planet…"
            aria-label="Search telescope observations"
          />
          <button type="submit">SEARCH</button>
        </form>
        <button className="telescopeClose" type="button" onClick={onClose}>BACK TO SPACE</button>
      </div>

      {selected ? (
        <div className="telescopeDetail">
          <div className="telescopeImageStage glass">
            <button className="telescopeGalleryBack" type="button" onClick={() => onSelect(null)}>← GALLERY</button>
            {assetUrl
              ? <img src={assetUrl} alt={selected.title} />
              : <div className="telescopeEmpty">Image unavailable</div>}
            {assetState === "loading" && <span className="telescopeAssetState">Loading higher-resolution asset…</span>}
            {assetState === "degraded" && <span className="telescopeAssetState">Archive preview shown · higher-resolution asset unavailable</span>}
          </div>
          <aside className="telescopeMeta glass">
            <span className="telescopeMission">{selected.telescope}{selected.instrument ? " · " + selected.instrument : ""}</span>
            <h2>{selected.title}</h2>
            <dl>
              <div><dt>RELEASE / OBSERVATION DATE</dt><dd>{selected.dateCreated ? new Date(selected.dateCreated).toLocaleDateString() : "Not provided"}</dd></div>
              <div><dt>TELESCOPE</dt><dd>{selected.telescope}</dd></div>
              {selected.instrument && <div><dt>INSTRUMENT</dt><dd>{selected.instrument}</dd></div>}
              <div><dt>PROVIDER</dt><dd>{selected.provider}</dd></div>
              <div><dt>SOURCE ORGANIZATIONS</dt><dd>{selected.sourceOrganizations.length ? selected.sourceOrganizations.join(" · ") : "Not provided"}</dd></div>
              <div><dt>FULL CREDIT</dt><dd>{selected.credit}</dd></div>
              <div><dt>SOURCE ID</dt><dd>{selected.sourceId}</dd></div>
              {selected.observationType && <div><dt>CONTENT TYPE</dt><dd>{selected.observationType}</dd></div>}
              {selected.rights && <div><dt>USAGE / RIGHTS</dt><dd>{selected.rights}</dd></div>}
            </dl>
            {selected.description && <p>{selected.description}</p>}
            <a href={selected.sourceUrl} target="_blank" rel="noreferrer">OPEN {selected.provider.toUpperCase()} SOURCE ↗</a>{assetState === "ready" && assetUrl && <a href={assetUrl} target="_blank" rel="noreferrer">VIEW HIGH RESOLUTION ↗</a>}
            <small>Astronomical observation/release imagery · not live telescope telemetry. Full source credit is preserved above.</small>
          </aside>
        </div>
      ) : (
        <div className="telescopeGallery">
          {state === "loading" && !items.length && <div className="telescopeEmpty">Loading official telescope observations…</div>}
          {state === "error" && <div className="telescopeEmpty">Telescope imagery unavailable{error ? ` · ${error}` : ""}</div>}
          {state === "degraded" && <div className="telescopeNotice">One or more telescope sources are partial or temporarily degraded; available observations remain usable.</div>}
          {items.map((item) => (
            <button className="telescopeCard glass" key={item.id} onClick={() => onSelect(item)}>
              <img loading="lazy" src={item.thumbnailUrl} alt="" />
              <span className="telescopeCardBody">
                <b>{item.title}</b>
                <small>{item.telescope}{item.instrument ? " · " + item.instrument : ""}{item.dateCreated ? " · " + new Date(item.dateCreated).getFullYear() : ""}</small>
              </span>
            </button>
          ))}
          {state !== "loading" && state !== "error" && !items.length && <div className="telescopeEmpty">No telescope observations matched this view.</div>}
        </div>
      )}
    </section>
  );
}

function KeylessLaunchPanel({ launches, state }: {
  launches: SpaceLaunch[];
  state: "idle" | "loading" | "ready" | "degraded" | "error";
}) {
  const recent = [...launches]
    .filter((item) => item.net)
    .sort((a, b) => Date.parse(b.net ?? "") - Date.parse(a.net ?? ""))
    .slice(0, 6);

  return (
    <div className="spaceMissionFacts keylessLaunches glass">
      <strong>KEYLESS SPACE · LAUNCH LIBRARY 2</strong>
      {state === "loading" && <span>Loading recent launches…</span>}
      {state === "error" && <span>Launch feed unavailable · satellite and planetary views remain active</span>}
      {state === "degraded" && !recent.length && <span>No recent launch records returned</span>}
      {recent.map((launch) => (
        <span key={launch.id}>
          <b>{launch.name}</b>
          {" · "}{launch.provider ?? "provider unknown"}
          {launch.location ? ` · ${launch.location}` : ""}
          {launch.net ? ` · ${new Date(launch.net).toLocaleString()}` : ""}
        </span>
      ))}
    </div>
  );
}

function OrbitView({ satellites, onSelect, onReturnEarth }: {
  satellites: SpatialEntity[];
  onSelect: (entity: SpatialEntity) => void;
  onReturnEarth: () => void;
}) {
  const size = 1000;
  const cx = 500;
  const cy = 430;
  const visible = satellites
    .filter((item) => item.kind === "satellite")
    .slice()
    .sort((a, b) => a.position.altitudeMeters - b.position.altitudeMeters)
    .slice(0, 160);

  const maxAltitude = Math.max(42_164_000, ...visible.map((item) => item.position.altitudeMeters));
  const radiusForAltitude = (altitudeMeters: number) => {
    const clamped = Math.max(160_000, altitudeMeters);
    const normalized = Math.log10(clamped / 160_000 + 1) / Math.log10(maxAltitude / 160_000 + 1);
    return 92 + normalized * 315;
  };

  return (
    <div className="orbitFrame">
      <button className="spaceBackButton orbitReturn" onClick={onReturnEarth}>← Earth</button>
      <svg viewBox={`0 0 ${size} 760`} className="orbitSvg" role="img" aria-label="Earth orbit with propagated satellite positions">
        <defs>
          <radialGradient id="orbit-earth-gradient" cx="35%" cy="30%">
            <stop offset="0%" stopColor="#ecfeff"/>
            <stop offset="34%" stopColor="#38bdf8"/>
            <stop offset="78%" stopColor="#0369a1"/>
            <stop offset="100%" stopColor="#082f49"/>
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r="72" fill="url(#orbit-earth-gradient)" className="orbitEarth" onClick={onReturnEarth} />
        <circle cx={cx} cy={cy} r={radiusForAltitude(420_000)} className="orbitGuide leoGuide" />
        <circle cx={cx} cy={cy} r={radiusForAltitude(20_200_000)} className="orbitGuide meoGuide" />
        <circle cx={cx} cy={cy} r={radiusForAltitude(35_786_000)} className="orbitGuide geoGuide" />
        <text x={cx} y={cy + 98} className="planetDetailLabel" textAnchor="middle">Earth</text>
        <text x={cx + radiusForAltitude(420_000) + 8} y={cy - 4} className="orbitGuideLabel">LEO</text>
        <text x={cx + radiusForAltitude(20_200_000) + 8} y={cy - 4} className="orbitGuideLabel">MEO</text>
        <text x={cx + radiusForAltitude(35_786_000) + 8} y={cy - 4} className="orbitGuideLabel">GEO</text>
        {visible.map((item, index) => {
          const angle = ((item.position.longitude + 180) / 360) * Math.PI * 2 + (index % 7) * 0.004;
          const orbitRadius = radiusForAltitude(item.position.altitudeMeters);
          const x = cx + Math.cos(angle) * orbitRadius;
          const y = cy + Math.sin(angle) * orbitRadius * 0.62;
          const isIss = /ISS/i.test(item.name);
          const klass = satelliteClassForEntity(item);
          const spec = SATELLITE_CLASSES[klass];
          const markerRadius = isIss ? 5.5 : klass === "station" ? 4.5 : klass === "geo" ? 3.4 : klass === "nav" ? 3 : 2.4;
          return <g key={item.id} className="orbitObject" onClick={() => onSelect(item)}>
            <circle cx={x} cy={y} r={markerRadius} fill={spec.color} className={isIss ? "orbitSatellite iss" : "orbitSatellite"} />
            {isIss && <text x={x + 9} y={y - 8} className="orbitIssLabel">ISS</text>}
          </g>;
        })}
      </svg>
      <div className="orbitFrameLegend glass">
        <strong>LIVE ORBIT FRAME</strong>
        <span>{visible.length} of {satellites.length} propagated objects rendered</span>
        <small>STATION warm white · NAV cyan · GEO violet · STARLINK green · ONEWEB pink · IRIDIUM orange</small>
        <small>CelesTrak TLE + SGP4 · display projection compressed for readability</small>
      </div>
    </div>
  );
}

export function SolarSystemView({
  planets,
  sun,
  onSelect,
  onOpenPlanet,
  showOrbits = true,
}: {
  planets: PlanetPosition[];
  sun: SpatialEntity;
  onSelect: (entity: SpatialEntity) => void;
  onOpenPlanet: (planet: PlanetPosition) => void;
  showOrbits?: boolean;
}) {
  const size = 1000;
  const center = size / 2;
  const maxRadius = 420;
  const radiusForAu = (au: number) => au <= 0 ? 0 : 42 + (Math.log10(au + 0.28) / Math.log10(30.5 + 0.28)) * (maxRadius - 42);
  const points = planets.map((planet) => {
    const orbitRadius = radiusForAu(planet.radiusAu);
    const angle = Math.atan2(planet.yAu, planet.xAu);
    return { ...planet, px: center + Math.cos(angle) * orbitRadius, py: center + Math.sin(angle) * orbitRadius };
  });

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="solarSvg" role="img" aria-label="Calculated solar system positions">
      <defs>
        <radialGradient id="sunGlow"><stop offset="0%" stopColor="#fef08a"/><stop offset="45%" stopColor="#f59e0b"/><stop offset="100%" stopColor="#f59e0b" stopOpacity="0"/></radialGradient>
      </defs>
      {showOrbits && [0.39, 0.72, 1, 1.52, 5.2, 9.54, 19.2, 30.1].map((au) => <circle key={au} cx={center} cy={center} r={radiusForAu(au)} className="orbitRing" />)}
      <circle cx={center} cy={center} r="36" fill="url(#sunGlow)" className="spaceObject" onClick={() => onSelect(sun)} />
      <circle cx={center} cy={center} r="13" fill="#fde68a" pointerEvents="none"/>
      <text x={center} y={center + 54} className="planetLabel" textAnchor="middle">Sun</text>
      {points.map((item) => (
        <g key={item.entity.id} className="planetGroup" onClick={() => onOpenPlanet(item)}>
          <circle cx={item.px} cy={item.py} r={item.entity.name === "Earth" ? 9 : item.entity.name === "Jupiter" ? 12 : 7} className={`planetDot planet-${item.entity.name.toLowerCase()}`} />
          <text x={item.px + 13} y={item.py - 10} className="planetLabel">{item.entity.name}</text>
        </g>
      ))}
    </svg>
  );
}

function PlanetSystemView({
  planet,
  time,
  onSelect,
  onBack,
}: {
  planet: PlanetPosition;
  time: Date;
  onSelect: (entity: SpatialEntity) => void;
  onBack: () => void;
}) {
  const moons = getPlanetMoons(planet.entity.name);
  const size = 1000;
  const cx = 500;
  const cy = 480;
  const planetRadius = PLANET_RADII[planet.entity.name] ?? 48;
  const palette = PLANET_PALETTE[planet.entity.name] ?? ["#f8fafc", "#94a3b8", "#334155"];
  const maxOrbit = moons.reduce((max, moon) => Math.max(max, moon.orbitalRadiusKm), 1);
  const moonRender = moons.map((moon, index) => {
    const normalized = Math.log10(1 + moon.orbitalRadiusKm) / Math.log10(1 + maxOrbit);
    const orbit = 118 + normalized * 285;
    const phase = ((time.getTime() / 86_400_000) / moon.orbitalPeriodDays * 360 + phaseFor(moon.name)) * Math.PI / 180;
    const x = cx + Math.cos(phase) * orbit;
    const y = cy + Math.sin(phase) * orbit * 0.45;
    const radius = Math.max(5, Math.min(13, 4 + Math.sqrt(moon.radiusKm) / 6));
    return { moon, index, orbit, x, y, radius, entity: moonEntity(planet.entity.name, moon, time) };
  });

  return (
    <div className="planetSystemScene">
      <button className="spaceBackButton" onClick={onBack}>← Solar System</button>
      {planet.entity.name === "Earth" && <div className="cislunarBadge glass"><strong>CISLUNAR</strong><span>Earth → Moon → L2 → Solar System</span></div>}
      <div className="planetSystemInfo">
        <strong>{planet.entity.name}</strong>
        <span>{planet.entity.name === "Earth"
          ? "Earth–Moon / cislunar context"
          : moons.length
            ? `${moons.length} featured moon${moons.length === 1 ? "" : "s"}`
            : "No natural moons"}</span>
      </div>
      <svg viewBox={`0 0 ${size} 760`} className="planetSystemSvg" role="img" aria-label={`${planet.entity.name} and featured moons`}>
        <defs>
          <radialGradient id={`planet-${slug(planet.entity.name)}-gradient`} cx="35%" cy="28%">
            <stop offset="0%" stopColor="rgba(255,255,255,.72)"/>
            <stop offset="24%" stopColor={palette[0]}/>
            <stop offset="72%" stopColor={palette[1]}/>
            <stop offset="100%" stopColor={palette[2]}/>
          </radialGradient>
        </defs>
        {planet.entity.name === "Earth" && <>
          <ellipse cx={cx} cy={cy} rx="205" ry="92" className="cislunarGuide moonDistanceGuide" />
          <ellipse cx={cx} cy={cy} rx="330" ry="150" className="cislunarGuide l1l2Guide" />
          <text x={cx + 214} y={cy - 6} className="cislunarGuideLabel">MOON DISTANCE</text>
          <text x={cx + 340} y={cy - 6} className="cislunarGuideLabel">L1 / L2 CONTEXT</text>
        </>}
        {moonRender.map(({ moon, orbit }) => (
          <ellipse key={`orbit-${moon.name}`} cx={cx} cy={cy} rx={orbit} ry={orbit * 0.45} className="moonOrbit" />
        ))}
        {planet.entity.name === "Saturn" && <ellipse cx={cx} cy={cy} rx={planetRadius * 1.9} ry={planetRadius * .55} className="saturnRing" />}
        <g className={`planetPortrait planetPortrait-${slug(planet.entity.name)}`} onClick={() => onSelect(planet.entity)}>
          <circle cx={cx} cy={cy} r={planetRadius} fill={`url(#planet-${slug(planet.entity.name)}-gradient)`} />
          {planet.entity.name === "Jupiter" && <ellipse cx={cx + 30} cy={cy + 18} rx="16" ry="7" className="jupiterSpot" />}
        </g>
        <text x={cx} y={cy + planetRadius + 34} className="planetDetailLabel" textAnchor="middle">{planet.entity.name}</text>
        {moonRender.map(({ moon, entity, x, y, radius }) => (
          <g key={moon.name} className="moonGroup" onClick={() => onSelect(entity)}>
            <circle cx={x} cy={y} r={radius} fill={moon.color} className="moonDot" />
            <text x={x + radius + 7} y={y - 7} className="moonLabel">{moon.name}</text>
          </g>
        ))}
        {planet.entity.name === "Earth" && <>
          <g className="jwstContextMarker">
            <line x1={cx + 330} y1={cy} x2={cx + 382} y2={cy - 48} className="jwstLeader" />
            <circle cx={cx + 330} cy={cy} r="7" className="jwstDot" />
            <circle cx={cx + 330} cy={cy} r="15" className="jwstRing" />
            <text x={cx + 390} y={cy - 54} className="jwstLabel">JWST</text>
            <text x={cx + 390} y={cy - 36} className="jwstSubLabel">Sun–Earth L2 region · context only</text>
          </g>
        </>}
        {!moons.length && <text x={cx} y={cy + 135} className="moonLabel" textAnchor="middle">No natural satellites</text>}
      </svg>
      <div className="spaceScaleDisclosure">
        {planet.entity.name === "Earth"
          ? "MOON: NASA fact distance + simulated circular display orbit · JWST/L1/L2: spatial context only, not live telemetry"
          : "CALCULATED planet position · SIMULATED circular moon display orbits · sizes/distances expanded for exploration"}
      </div>
    </div>
  );
}

function OuterSystemView({ time, onSelect, onSolar }: { time: Date; onSelect: (entity: SpatialEntity) => void; onSolar: () => void }) {
  const points = useMemo(() => deterministicBeltPoints(220), []);
  const bodyPoints = OUTER_BODIES.map((spec, index) => {
    const angle = ((index * 83 + 28) % 360) * Math.PI / 180;
    const radius = 300 + Math.min(125, (spec.distanceAu - 30) * 3.2);
    return {
      spec,
      x: 500 + Math.cos(angle) * radius,
      y: 500 + Math.sin(angle) * radius * 0.55,
      entity: outerBodyEntity(spec, time),
    };
  });

  return (
    <div className="outerSystemScene">
      <button className="spaceBackButton" onClick={onSolar}>← Inner Solar System</button>
      <svg viewBox="0 0 1000 1000" className="outerSystemSvg" role="img" aria-label="Illustrative Kuiper Belt and dwarf planets">
        <ellipse cx="500" cy="500" rx="300" ry="165" className="kuiperInner" />
        <ellipse cx="500" cy="500" rx="420" ry="230" className="kuiperOuter" />
        {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={point.r} fill="#94a3b8" opacity={point.opacity} />)}
        <circle cx="500" cy="500" r="12" fill="#fde68a" />
        <text x="500" y="530" className="planetLabel" textAnchor="middle">Sun / inner planets</text>
        {bodyPoints.map(({ spec, x, y, entity }) => (
          <g key={spec.name} className="planetGroup" onClick={() => onSelect(entity)}>
            <circle cx={x} cy={y} r="9" fill={spec.color} className="moonDot" />
            <text x={x + 14} y={y - 9} className="planetLabel">{spec.name}</text>
          </g>
        ))}
      </svg>
      <div className="spaceScaleDisclosure">Kuiper Belt particle density is illustrative · named-body orbital scales are representative, not current ephemerides</div>
    </div>
  );
}

export function GalaxyView({ onSolar }: { onSolar: () => void }) {
  const stars = useMemo(() => deterministicGalaxyStars(), []);
  const clouds = useMemo(() => deterministicGalaxyClouds(), []);
  const solarAngle = 0.22 + 0.63 * 5.15 + 0.48;
  const solarRadius = 48 + 0.63 * 355;
  const solarX = 500 + Math.cos(solarAngle) * solarRadius;
  const solarY = 500 + Math.sin(solarAngle) * solarRadius * 0.53;

  return (
    <div className="galaxyScene">
      <button className="spaceBackButton" onClick={onSolar}>← Solar System</button>
      <svg viewBox="0 0 1000 760" className="milkyWaySvg" role="img" aria-label="Milky Way context model with spiral arms, dust lanes and the Solar System marked in the Orion Spur">
        <defs>
          <radialGradient id="galaxy-core-glow">
            <stop offset="0%" stopColor="#fff7c2" stopOpacity="1"/>
            <stop offset="24%" stopColor="#fbbf24" stopOpacity=".78"/>
            <stop offset="58%" stopColor="#c084fc" stopOpacity=".18"/>
            <stop offset="100%" stopColor="#0f172a" stopOpacity="0"/>
          </radialGradient>
          <radialGradient id="galaxy-disk-glow">
            <stop offset="0%" stopColor="#dbeafe" stopOpacity=".18"/>
            <stop offset="58%" stopColor="#60a5fa" stopOpacity=".08"/>
            <stop offset="100%" stopColor="#020617" stopOpacity="0"/>
          </radialGradient>
          <linearGradient id="galaxy-cloud-cool" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#dbeafe" stopOpacity="0"/><stop offset="50%" stopColor="#bfdbfe" stopOpacity="1"/><stop offset="100%" stopColor="#dbeafe" stopOpacity="0"/></linearGradient>
          <linearGradient id="galaxy-cloud-warm" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#fde68a" stopOpacity="0"/><stop offset="50%" stopColor="#fef3c7" stopOpacity="1"/><stop offset="100%" stopColor="#fde68a" stopOpacity="0"/></linearGradient>
          <filter id="galaxy-soft"><feGaussianBlur stdDeviation="5"/></filter>
          <filter id="galaxy-cloud-soft"><feGaussianBlur stdDeviation="10"/></filter>
          <filter id="galaxy-core-soft"><feGaussianBlur stdDeviation="12"/></filter>
        </defs>
        <g transform="translate(0 -120)">
          <ellipse cx="500" cy="500" rx="450" ry="238" fill="url(#galaxy-disk-glow)" />
          <ellipse cx="500" cy="500" rx="170" ry="70" className="galaxyBulgeHalo" />
          {clouds.map((cloud, index) => <ellipse key={`cloud-${index}`} cx={cloud.x} cy={cloud.y} rx={cloud.rx} ry={cloud.ry} transform={`rotate(${cloud.rotate.toFixed(1)} ${cloud.x.toFixed(1)} ${cloud.y.toFixed(1)})`} fill={cloud.warm ? 'url(#galaxy-cloud-warm)' : 'url(#galaxy-cloud-cool)'} opacity={cloud.opacity} filter="url(#galaxy-cloud-soft)" />)}
          {[0, 1, 2, 3].map((arm) => <path key={`glow-${arm}`} d={galaxySpiralPath(arm)} className="galaxySpiralGlow" />)}
          {[0, 1, 2, 3].map((arm) => <path key={`arm-${arm}`} d={galaxySpiralPath(arm)} className="galaxySpiralArm" />)}
          {[0, 1, 2, 3].map((arm) => <path key={`dust-${arm}`} d={galaxySpiralPath(arm, -13)} className="galaxyDustLane" />)}
          <path d="M565 510 C625 485 690 484 748 522" className="orionSpur" />
          {stars.map((star, index) => <circle key={index} cx={star.x} cy={star.y} r={star.r} fill={star.warm ? '#fde68a' : '#dbeafe'} opacity={star.opacity} />)}
          <ellipse cx="500" cy="500" rx="96" ry="54" fill="url(#galaxy-core-glow)" filter="url(#galaxy-core-soft)" />
          <ellipse cx="500" cy="500" rx="44" ry="25" fill="#fde68a" opacity=".92" />
          <circle cx={solarX} cy={solarY} r="7" className="solarMarkerDot" />
          <circle cx={solarX} cy={solarY} r="16" className="solarMarkerRing" />
          <line x1={solarX + 14} y1={solarY - 8} x2={solarX + 62} y2={solarY - 48} className="solarMarkerLeader" />
          <text x={solarX + 70} y={solarY - 52} className="solarMarkerText">YOU ARE HERE</text>
          <text x={solarX + 70} y={solarY - 34} className="solarMarkerSubtext">Solar System · Orion Spur</text>
          <text x="500" y="575" textAnchor="middle" className="galacticCenterLabel">GALACTIC CENTER</text>
          <text x="705" y="476" className="orionSpurLabel">ORION SPUR</text>
        </g>
      </svg>
      <div className="galaxyFacts glass">
        <strong>MILKY WAY</strong>
        <span>~100,000 light-years across</span>
        <span>Solar System ≈ 26,000 light-years from the Galactic Center</span>
        <span>Diffuse disk + dust lanes + stellar-density context model</span>
        <small>Scientific orientation view, deliberately subdued; not a literal photograph or star-by-star reconstruction.</small>
      </div>
    </div>
  );
}
