import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const aircraftCore = fs.readFileSync(path.join(root, 'functions/api/aircraft-core.ts'), 'utf8');
const aircraftApi = fs.readFileSync(path.join(root, 'functions/api/aircraft.ts'), 'utf8');
const aircraftClient = fs.readFileSync(path.join(root, 'lib/aircraft.ts'), 'utf8');
const component = fs.readFileSync(path.join(root, 'components/WorldSelectApp.tsx'), 'utf8');
const streetApi = fs.readFileSync(path.join(root, 'functions/api/street.ts'), 'utf8');
const telescopeApi = fs.readFileSync(path.join(root, 'functions/api/telescope.ts'), 'utf8');
const telescopeClient = fs.readFileSync(path.join(root, 'lib/telescope.ts'), 'utf8');
const spaceExplorer = fs.readFileSync(path.join(root, 'components/SpaceExplorer.tsx'), 'utf8');
const celestialBridge = fs.readFileSync(path.join(root, 'runtime/gev/layers/celestial-bridge-renderer.ts'), 'utf8');
const satelliteRenderer = fs.readFileSync(path.join(root, 'runtime/gev/layers/satellites-renderer.ts'), 'utf8');
const radioRenderer = fs.readFileSync(path.join(root, 'runtime/gev/layers/radio-renderer.ts'), 'utf8');
const infrastructureRenderer = fs.readFileSync(path.join(root, 'runtime/gev/layers/infrastructure-renderer.ts'), 'utf8');
const infrastructureLocal = fs.readFileSync(path.join(root, 'lib/infrastructure-local.ts'), 'utf8');
const keyless = fs.readFileSync(path.join(root, 'lib/keyless.ts'), 'utf8');
const viewScale = fs.readFileSync(path.join(root, 'lib/view-scale.ts'), 'utf8');
const viewerLifecycle = fs.readFileSync(path.join(root, 'lib/cesium-viewer.ts'), 'utf8');
const mapController = fs.readFileSync(path.join(root, 'runtime/gev/map-controller.ts'), 'utf8');

const checks = [
  ['adsb.lol uses documented lat/lon/dist route', aircraftCore.includes('/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${radius}')],
  ['legacy adsb.lol /v2/point route removed', !aircraftCore.includes('/v2/point/') && !aircraftApi.includes('/v2/point/')],
  ['aircraft API has only OpenSky + adsb.lol provider contract', aircraftApi.includes('["opensky", "adsb.lol"]') && !aircraftApi.includes('airplanes.live') && !aircraftApi.includes('adsb.fi')],
  ['aircraft API can return stale/degraded cache', aircraftApi.includes('degraded: true') && aircraftApi.includes('cached: true')],
  ['client consumes aircraft feed metadata', aircraftClient.includes('AircraftFeedMeta') && component.includes('setAircraftMeta(meta)')],
  ['stale aircraft are not projected as fresh motion', component.includes('spatial.dataState !== "STALE"')],
  ['KartaView search stays within documented 500 m radius', streetApi.includes('const searchRadiusM = 500')],
  ['UI still exposes explicit Degraded state', component.includes('effectiveState === "degraded"')],
  ['keyless Telescope retains NASA Image and Video Library API', telescopeApi.includes('https://images-api.nasa.gov/search') && telescopeClient.includes('/api/telescope')],
  ['Telescope rejects hardware servicing and launch imagery', telescopeApi.includes('HARDWARE_REJECT') && telescopeApi.includes('servicing') && telescopeApi.includes('astronaut') && telescopeApi.includes('observatory building')],
  ['Telescope adds official ESA/Webb observation archive', telescopeApi.includes('https://esawebb.org/images') && telescopeApi.includes('providerId: "esa-webb"') && telescopeApi.includes('type.toLowerCase() !== "observation"')],
  ['Telescope adds NASA Hubble science gallery', telescopeApi.includes('https://science.nasa.gov/gallery/hubble-images/') && telescopeApi.includes('providerId: "hubble-science"')],
  ['Telescope model preserves provider provenance full credit and high resolution', telescopeClient.includes('sourceOrganizations: string[]') && telescopeClient.includes('credit: string') && telescopeClient.includes('highResUrl: string | null')],
  ['Telescope navigation exposes mission and science-object categories', spaceExplorer.includes('OTHER SPACE TELESCOPES') && spaceExplorer.includes('SOLAR SYSTEM') && spaceExplorer.includes('GALAXIES') && spaceExplorer.includes('NEBULAE') && spaceExplorer.includes('STARS / CLUSTERS')],
  ['Telescope is isolated inside Space Explorer', spaceExplorer.includes('TELESCOPE') && spaceExplorer.includes('if (!telescopeOpen) return')],
  ['Earth planet bodies remain independent of orbit-line toggle', celestialBridge.includes('syncBody({') && celestialBridge.includes('if (args.showOrbits)') && component.includes('showOrbits: planetOrbits')],
  ['celestial bridge uses fixed compressed heliocentric geometry', celestialBridge.includes('SOLAR_DISPLAY_ONE_AU_M = 95_000_000') && celestialBridge.includes('compressedHeliocentricPosition') && !celestialBridge.includes('displayRadius(distanceAu, cameraHeight)')],
  ['compressed Sun is explicit bridge reference', celestialBridge.includes('const SUN_ID = "bridge:solar:sun"') && celestialBridge.includes('setNativeSunVisible(false)') && celestialBridge.includes('SUN · REF')],
  ['planet orbit paths share the compressed heliocentric transform', celestialBridge.includes('const sampleDisplay = compressedHeliocentricPosition') && celestialBridge.includes('earthDisplay')],
  ['Earth orbit is rendered while exact Earth-origin samples stay filtered', !celestialBridge.includes('if (planet.entity.name === "Earth") continue;') && celestialBridge.includes('Cesium.Cartesian3.magnitude(position) > 1')],
  ['native Earth is the only Earth across Earth and solar tiers', !celestialBridge.includes('EARTH_PROXY_ID') && !component.includes('viewer.scene.globe.show = globeVisible')],
  ['map controller exclusively owns globe versus Google 3D surface', mapController.includes('viewer.scene.globe.show = !in3d') && !component.includes('viewer.scene?.globe.show')],
  ['planet display sizes preserve radius ordering on a compressed visual scale', celestialBridge.includes('BODY_RADIUS_KM') && celestialBridge.includes('Math.pow(radiusKm / earthRadiusKm, 0.25)')],
  ['three-tier contract uses one solar boundary', viewScale.includes('"ground" | "earth" | "solar"') && viewScale.includes('GROUND_TIER_MAX_HEIGHT_M = 120_000') && viewScale.includes('SOLAR_CONTEXT_HEIGHT_M = 36_000_000') && viewScale.includes('resolveEarthSceneState') && !viewScale.includes('SOLAR_GLOBE_HANDOFF_HEIGHT_M')],
  ['React has one camera-scale owner', component.includes('const [earthCamera, setEarthCamera]') && component.includes('const earthScene = useMemo') && !component.includes('setScaleTier(') && !component.includes('setCameraHeight(')],
  ['camera tier crossings publish through the same view callback before moveEnd', viewerLifecycle.includes('scene.preRender.addEventListener') && viewerLifecycle.includes('lastPublishedScaleTier') && viewerLifecycle.includes('updateView();') && !viewerLifecycle.includes('onScaleTierChange')],
  ['Solar renderer toggle and status share one scene contract', component.includes('const solarContextVisible = viewMode === "earth" && earthScene.solarContextVisible') && component.includes('const planetOrbitsAvailable = viewMode === "earth" && earthScene.planetOrbitsAvailable') && component.includes('visible: solarContextVisible') && component.includes('disabled={!planetOrbitsAvailable}') && component.includes('earthScene.statusLabel')],
  ['leaving Solar clears orbit UI intent', component.includes('if (!planetOrbitsAvailable && planetOrbits)') && component.includes('setPlanetOrbits(false)')],
  ['orbit cache is invalidated by the exact selected-time epoch', celestialBridge.includes('const key = `${epoch.getTime()}:${name}`') && celestialBridge.includes('orbitEpochKey !== epochKey')],
  ['compressed Sun uses a glow while Cesium lighting remains separate', celestialBridge.includes('SUN_GLOW_IMAGE') && celestialBridge.includes('setNativeSunVisible(false)')],
  ['satellites and aircraft render only in the Earth/orbit tier', component.includes('visible: earthOrbitVisible && satelliteLayer') && component.includes('visible: earthOrbitVisible && (aircraftLayer || militaryLayer)')],
  ['surface layers leave the scene in solar tier', component.includes('earthVisible: earthSurfaceVisible') && component.includes('earthSurfaceVisible && earthquakeLayer')],
  ['deep solar context retains renderer-level satellite fallback cutoff', satelliteRenderer.includes('SOLAR_CONTEXT_SATELLITE_CUTOFF_M = 120_000_000') && satelliteRenderer.includes('deepSolarContext')],
  ['radio markers stay donor-sized, earth-anchored and horizon-occluded', radioRenderer.includes('NORMAL_PIXEL_SIZE = 13') && radioRenderer.includes('RADIO_COLOR = "#34d399"') && radioRenderer.includes('Number.POSITIVE_INFINITY') && radioRenderer.includes('SELECTED_PIXEL_SIZE = 16') && radioRenderer.includes('EllipsoidalOccluder') && radioRenderer.includes('preRender') && component.includes('createRadioRenderer')],
  ['infrastructure preserves cable source colors and operator-based point colors', keyless.includes('visualColor?: string') && infrastructureLocal.includes('visualColor: sourceColor') && infrastructureRenderer.includes('OPERATOR_PALETTE') && infrastructureRenderer.includes("item.visualColor ?? '#64748b'") && infrastructureRenderer.includes('stableOperatorColor(item.operator)')],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}
if (failed) {
  console.error(`\n${failed} runtime contract check(s) failed.`);
  process.exit(1);
}
console.log(`\n${checks.length}/${checks.length} runtime contract checks passed.`);
