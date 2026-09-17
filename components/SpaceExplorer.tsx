"use client";

import { useMemo, useRef, useState, type WheelEvent } from "react";
import type { SpatialEntity } from "@/lib/spatial";
import {
  getPlanetMoons,
  moonEntity,
  OUTER_BODIES,
  outerBodyEntity,
  type PlanetPosition,
} from "@/lib/space";

type SpaceLevel = "planet" | "solar" | "outer" | "galaxy";

type Props = {
  planets: PlanetPosition[];
  sun: SpatialEntity;
  time: Date;
  onSelect: (entity: SpatialEntity) => void;
};

const LEVELS: SpaceLevel[] = ["planet", "solar", "outer", "galaxy"];
const LEVEL_LABELS: Record<SpaceLevel, string> = {
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

export default function SpaceExplorer({ planets, sun, time, onSelect }: Props) {
  const [level, setLevel] = useState<SpaceLevel>("solar");
  const [focusedPlanet, setFocusedPlanet] = useState<string>("Earth");
  const lastWheelAt = useRef(0);
  const planet = planets.find((item) => item.entity.name === focusedPlanet) ?? planets[2] ?? planets[0];

  const changeLevel = (next: SpaceLevel) => {
    if (next === "planet" && !planet) return;
    setLevel(next);
  };

  const zoomBy = (direction: -1 | 1) => {
    const index = LEVELS.indexOf(level);
    const nextIndex = Math.max(0, Math.min(LEVELS.length - 1, index + direction));
    setLevel(LEVELS[nextIndex]);
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const now = Date.now();
    if (now - lastWheelAt.current < 320 || Math.abs(event.deltaY) < 18) return;
    event.preventDefault();
    lastWheelAt.current = now;
    zoomBy(event.deltaY > 0 ? 1 : -1);
  };

  const openPlanet = (item: PlanetPosition) => {
    setFocusedPlanet(item.entity.name);
    setLevel("planet");
    onSelect(item.entity);
  };

  return (
    <div className="spaceScene spaceExplorer" onWheel={onWheel}>
      <div className="spaceTitle">
        <span>{LEVEL_LABELS[level]}</span>
        <small>
          {level === "planet" && `${focusedPlanet} system · moon sizes and distances expanded for visibility`}
          {level === "solar" && "JPL approximate heliocentric positions · logarithmic display scale"}
          {level === "outer" && "Named dwarf-planet orbit scales · Kuiper density illustrative"}
          {level === "galaxy" && "Milky Way context · Solar System marker is schematic"}
        </small>
      </div>

      <div className="spaceScaleControls glass" role="group" aria-label="Space scale">
        {LEVELS.map((item) => (
          <button
            key={item}
            className={level === item ? "active" : ""}
            disabled={item === "planet" && !planet}
            onClick={() => changeLevel(item)}
          >
            {item === "planet" ? focusedPlanet.toUpperCase() : LEVEL_LABELS[item]}
          </button>
        ))}
      </div>

      <div className="spaceZoomHint">scroll to travel scale · + / − changes spatial frame</div>
      <div className="spaceZoomButtons glass" aria-label="Space zoom">
        <button onClick={() => zoomBy(-1)} disabled={level === "planet"}>+</button>
        <button onClick={() => zoomBy(1)} disabled={level === "galaxy"}>−</button>
      </div>

      {level === "planet" && planet && (
        <PlanetSystemView planet={planet} time={time} onSelect={onSelect} onBack={() => setLevel("solar")} />
      )}
      {level === "solar" && (
        <SolarSystemView planets={planets} sun={sun} onSelect={onSelect} onOpenPlanet={openPlanet} />
      )}
      {level === "outer" && <OuterSystemView time={time} onSelect={onSelect} onSolar={() => setLevel("solar")} />}
      {level === "galaxy" && <GalaxyView onSolar={() => setLevel("solar")} />}
    </div>
  );
}

function SolarSystemView({
  planets,
  sun,
  onSelect,
  onOpenPlanet,
}: {
  planets: PlanetPosition[];
  sun: SpatialEntity;
  onSelect: (entity: SpatialEntity) => void;
  onOpenPlanet: (planet: PlanetPosition) => void;
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
      {[0.39, 0.72, 1, 1.52, 5.2, 9.54, 19.2, 30.1].map((au) => <circle key={au} cx={center} cy={center} r={radiusForAu(au)} className="orbitRing" />)}
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
      <div className="planetSystemInfo">
        <strong>{planet.entity.name}</strong>
        <span>{moons.length ? `${moons.length} featured moon${moons.length === 1 ? "" : "s"}` : "No natural moons"}</span>
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
        {!moons.length && <text x={cx} y={cy + 135} className="moonLabel" textAnchor="middle">No natural satellites</text>}
      </svg>
      <div className="spaceScaleDisclosure">CALCULATED planet position · SIMULATED circular moon display orbits · sizes/distances expanded for exploration</div>
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

function GalaxyView({ onSolar }: { onSolar: () => void }) {
  return (
    <div className="galaxyScene">
      <button className="spaceBackButton" onClick={onSolar}>← Solar System</button>
      <div className="milkyWayVisual" role="img" aria-label="Schematic Milky Way with the Solar System marked in the Orion Spur">
        <div className="galacticCore" />
        <div className="galaxyArm armA" />
        <div className="galaxyArm armB" />
        <div className="galaxyArm armC" />
        <div className="galaxyArm armD" />
        <div className="solarHere"><i /><span>YOU ARE HERE<br/><small>Solar System · Orion Spur</small></span></div>
      </div>
      <div className="galaxyFacts glass">
        <strong>MILKY WAY</strong>
        <span>~100,000 light-years across</span>
        <span>Solar System ≈ 26,000 light-years from the Galactic Center</span>
        <small>Schematic context view — not a literal photograph or star-by-star map.</small>
      </div>
    </div>
  );
}
