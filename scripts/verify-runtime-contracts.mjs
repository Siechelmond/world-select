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
const spaceModel = fs.readFileSync(path.join(root, 'lib/space.ts'), 'utf8');
const celestialBridge = fs.readFileSync(path.join(root, 'runtime/gev/layers/celestial-bridge-renderer.ts'), 'utf8');
const satelliteRenderer = fs.readFileSync(path.join(root, 'runtime/gev/layers/satellites-renderer.ts'), 'utf8');
const radioRenderer = fs.readFileSync(path.join(root, 'runtime/gev/layers/radio-renderer.ts'), 'utf8');
const infrastructureRenderer = fs.readFileSync(path.join(root, 'runtime/gev/layers/infrastructure-renderer.ts'), 'utf8');
const infrastructureLocal = fs.readFileSync(path.join(root, 'lib/infrastructure-local.ts'), 'utf8');
const keyless = fs.readFileSync(path.join(root, 'lib/keyless.ts'), 'utf8');
const viewScale = fs.readFileSync(path.join(root, 'lib/view-scale.ts'), 'utf8');
const viewerLifecycle = fs.readFileSync(path.join(root, 'lib/cesium-viewer.ts'), 'utf8');
const geocodeApi = fs.readFileSync(path.join(root, 'functions/api/geocode.ts'), 'utf8');
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
  ['orbit toggle changes only persistent orbit visibility, never body positions', celestialBridge.includes('if (args.showOrbits && args.showSolarBodies)') && celestialBridge.includes('if (args.showOrbits)') && celestialBridge.includes('if (orbit) orbit.show = false') && celestialBridge.includes('existing.show = true') && component.includes('showOrbits: planetOrbits')],
  ['cislunar Moon guide fades into Full Solar while Solar Moon orbit still obeys the orbit toggle', celestialBridge.includes('bridge-guide:earth-moon') && celestialBridge.includes('args.cislunarGuideAlpha') && celestialBridge.includes('guideAlpha > 0.005') && celestialBridge.includes('bridge-orbit:earth-moon') && celestialBridge.includes('if (args.showOrbits && args.showSolarBodies)')],
  ['Earth camera, satellite shells and Moon share one declared display transform', viewScale.includes('logicalToDisplayDistanceM') && viewScale.includes('displayToLogicalDistanceM') && viewScale.includes('CELESTIAL_COMPRESSION_START_M = 2_000_000') && viewScale.includes('MOON_DISPLAY_DISTANCE_M = 120_000_000') && celestialBridge.includes('logicalToDisplayDistanceM') && satelliteRenderer.includes('logicalToDisplayDistanceM(spatial.position.altitudeMeters)')],
  ['Solar bodies are compressed around the Sun before Earth-frame translation', viewScale.includes('heliocentricToSolarDisplayDistanceM') && celestialBridge.includes('heliocentricDisplayPosition') && celestialBridge.includes('const bodyPosition = heliocentricDisplayPosition') && celestialBridge.includes('const earthPosition = heliocentricDisplayPosition') && celestialBridge.includes('Cartesian3.subtract')],
  ['compressed Sun is explicit bridge reference', celestialBridge.includes('const SUN_ID = "bridge:solar:sun"') && celestialBridge.includes('setNativeSunVisible(false)') && celestialBridge.includes('SUN · REF')],
  ['planet orbit paths use the same Earth-relative display transform as bodies', celestialBridge.includes('const position = earthRelativeDisplayPosition') && celestialBridge.includes('current Earth remains origin')],
  ['Earth orbit is rendered while exact Earth-origin samples stay filtered', !celestialBridge.includes('if (planet.entity.name === "Earth") continue;') && celestialBridge.includes('Cesium.Cartesian3.magnitude(position) > 1')],
  ['native Earth is the only Earth across Earth and solar tiers', !celestialBridge.includes('EARTH_PROXY_ID') && !component.includes('viewer.scene.globe.show = globeVisible')],
  ['map controller exclusively owns globe versus Google 3D surface', mapController.includes('viewer.scene.globe.show = !in3d') && !component.includes('viewer.scene?.globe.show')],
  ['planet display sizes preserve radius ordering on a compressed visual scale', celestialBridge.includes('BODY_RADIUS_KM') && celestialBridge.includes('Math.pow(radiusKm / earthRadiusKm, 0.25)')],
  ['four-tier contract sequences Earth orbit, cislunar and Solar from one owner', viewScale.includes('"ground" | "earth" | "cislunar" | "solar"') && viewScale.includes('EARTH_LAYER_CONTEXT_MAX_HEIGHT_M = 36_000_000') && viewScale.includes('CISLUNAR_CONTEXT_HEIGHT_M = 80_000_000') && viewScale.includes('SATELLITE_LIVE_PROPAGATION_MAX_HEIGHT_M = 120_000_000') && viewScale.includes('SOLAR_CONTEXT_HEIGHT_M = 1_200_000_000') && viewScale.includes('resolveEarthSceneState')],
  ['React has one camera-scale owner', component.includes('const [earthCamera, setEarthCamera]') && component.includes('const earthScene = useMemo') && !component.includes('setScaleTier(') && !component.includes('setCameraHeight(')],
  ['camera tier crossings publish logical distance through the same view callback before moveEnd', viewerLifecycle.includes('scene.preRender.addEventListener') && viewerLifecycle.includes('displayToLogicalDistanceM(displayHeight)') && viewerLifecycle.includes('lastPublishedScaleTier') && viewerLifecycle.includes('updateView();') && !viewerLifecycle.includes('onScaleTierChange')],
  ['Cislunar and Solar renderer visibility share one scene contract', component.includes('const cislunarContextVisible = viewMode === "earth" && earthScene.cislunarContextVisible') && component.includes('const celestialContextVisible = viewMode === "earth" && earthScene.celestialContextVisible') && component.includes('const solarContextVisible = viewMode === "earth" && earthScene.solarContextVisible') && component.includes('visible: celestialContextVisible') && component.includes('showSolarBodies: solarContextVisible') && component.includes('disabled={!planetOrbitsAvailable}') && component.includes('earthScene.statusLabel')],
  ['leaving Solar clears orbit UI intent', component.includes('if (!planetOrbitsAvailable && planetOrbits)') && component.includes('setPlanetOrbits(false)')],
  ['Earth Moon keeps true 384400 km data while cislunar rendering remains readable', spaceModel.includes('{ name: "Moon", radiusKm: 1737.4, orbitalRadiusKm: 384400') && celestialBridge.includes('EARTH_MOON_DISPLAY_ORBIT_M = 120_000_000') && celestialBridge.includes('moonDisplayOrbitRadiusM(') && celestialBridge.includes('trueOrbitalRadiusKm: moon.orbitalRadiusKm')],
  ['featured planetary moons render around their parent bodies', celestialBridge.includes('for (const moon of getPlanetMoons(planet.entity.name))') && celestialBridge.includes('moonEntity(parentName, moon, epoch)') && celestialBridge.includes('moonLocalOffset')],
  ['Earth and Solar scale telemetry derive from the existing camera owner', component.includes('function formatEarthDistance') && component.includes('const distanceLabel = useMemo(() => formatEarthDistance(cameraHeight)') && component.includes('earthCamera.solarFrame ? "SCALE" : "DIST"')],
  ['distance ladder exposes truthful logical scale references beside compressed display', component.includes('DISTANCE_SCALE_REFERENCES') && component.includes('EARTH ALT') && component.includes('TRUE / LOGICAL · DISPLAY COMPRESSED') && component.includes('HELIOPAUSE') && component.includes('1 LIGHT-YEAR')],
  ['Earth reference stays a screen-space marker while native Earth remains the only physical Earth', celestialBridge.includes('EARTH_REFERENCE_ID = "bridge:earth:reference"') && celestialBridge.includes('screen-space Earth reference; native Cesium globe is the physical Earth') && !celestialBridge.includes('EARTH_PROXY_ID')],
  ['Earth reference waits until the native globe is visually small', viewScale.includes('EARTH_REFERENCE_MIN_DISTANCE_M = 0.1 * AU_METERS') && component.includes('showEarthReference: earthScene.earthReferenceVisible') && celestialBridge.includes('if (args.showEarthReference)')],
  ['distance ladder shares the exact cislunar threshold contract', component.includes('distanceM: CISLUNAR_CONTEXT_HEIGHT_M') && component.includes('value: "80,000 km+"')],
  ['Solar reveal at one AU frames every current JPL body bound', viewScale.includes('SOLAR_HANDOFF_DISTANCE_M = AU_METERS') && viewScale.includes('FULL_SOLAR_CONTEXT_DISTANCE_M = SOLAR_HANDOFF_DISTANCE_M') && celestialBridge.includes('Cesium.BoundingSphere.fromPoints(solarFramePoints)') && celestialBridge.includes('getSolarFrame()') && viewerLifecycle.includes('navigationLogicalHeight = FULL_SOLAR_CONTEXT_DISTANCE_M') && viewerLifecycle.includes('applySolarFrame(solarZoomStep)')],
  ['Orbit and Solar navigation use one settled gesture per visible snap', viewerLifecycle.includes('ORBIT_GESTURE_SETTLE_MS = 180') && viewerLifecycle.includes('const beginOrbitGesture') && viewerLifecycle.includes('if (!beginOrbitGesture()) return') && viewerLifecycle.includes('solarZoomStep + 1') && viewerLifecycle.includes('solarZoomStep -= 1') && component.includes('· SNAP')],
  ['Solar reverse handoff returns exactly to the Moon checkpoint', viewScale.includes('FULL_SOLAR_EXIT_DISTANCE_M = MOON_ORBIT_DISTANCE_M') && viewerLifecycle.includes('applyEarthRadialFrame(FULL_SOLAR_EXIT_DISTANCE_M)')],
  ['Solar bodies and labels retain a readable far-distance floor', celestialBridge.includes('50_000_000_000,\n    0.82') && celestialBridge.includes('50_000_000_000,\n    0.9')],
  ['Solar milestones reserve compact frame steps through interstellar handoff', viewScale.includes('CELESTIAL_NAVIGATION_MILESTONES_M') && viewScale.includes('5.2 * AU_METERS') && viewScale.includes('9.5 * AU_METERS') && viewScale.includes('19.2 * AU_METERS') && viewScale.includes('30.1 * AU_METERS') && viewScale.includes('0.1 * LIGHT_YEAR_METERS')],
  ['planetary moons use parent-local Solar LOD without expanding the Solar frame', celestialBridge.includes('SOLAR_MOON_SYSTEM_MAX_RADIUS_M') && celestialBridge.includes('args.solarFrameActive') && celestialBridge.includes('largestOrbitKm') && !celestialBridge.includes('solarFramePoints.push(Cesium.Cartesian3.clone(position));\n\n        for (const moon')],
  ['Solar distance ladder includes Saturn and Uranus milestones', component.includes('SATURN ORBIT') && component.includes('9.5 * AU_METERS') && component.includes('URANUS ORBIT') && component.includes('19.2 * AU_METERS') && component.includes('SOLAR SCALE')],
  ['Earth camera no longer stops at 100 AU and reaches the interstellar reference scale', viewScale.includes('LIGHT_YEAR_METERS = 9_460_730_472_580_800') && viewScale.includes('EARTH_VIEW_MAX_LOGICAL_DISTANCE_M = LIGHT_YEAR_METERS')],
  ['high-orbit wheel advances one logical snap while camera moves in shared display distance', viewerLifecycle.includes('ORBIT_WHEEL_DAMPING_HEIGHT_M = 20_000_000') && viewerLifecycle.includes('ORBIT_GESTURE_LOG_STEP = Math.log(1.22)') && viewerLifecycle.includes('displayToLogicalDistanceM(currentDisplayHeight)') && viewerLifecycle.includes('wheelDirection * ORBIT_GESTURE_LOG_STEP') && viewerLifecycle.includes('logicalToDisplayDistanceM(nextLogicalHeight)') && viewerLifecycle.includes("removeEventListener('wheel', onOrbitScaleWheel, true)")],
  ['orbit cache is invalidated by the exact selected-time epoch', celestialBridge.includes('const key = `${epoch.getTime()}:${name}`') && celestialBridge.includes('orbitEpochKey !== epochKey')],
  ['compressed Sun uses a glow while Cesium lighting remains separate', celestialBridge.includes('SUN_GLOW_IMAGE') && celestialBridge.includes('setNativeSunVisible(false)')],
  ['satellites bridge through GEO into early Solar while aircraft stay Earth/orbit', component.includes('const satelliteContextVisible = viewMode === "earth" && earthScene.satelliteContextVisible') && component.includes('visible: satelliteContextVisible && satelliteLayer') && component.includes('visible: earthOrbitVisible && (aircraftLayer || militaryLayer)')],
  ['surface layers leave the scene in solar tier', component.includes('earthVisible: earthSurfaceVisible') && component.includes('earthSurfaceVisible && earthquakeLayer')],
  ['satellites freeze after live propagation but persist as fading spatial context', viewScale.includes('SATELLITE_LIVE_PROPAGATION_MAX_HEIGHT_M = 120_000_000') && satelliteRenderer.includes('SATELLITE_LIVE_PROPAGATION_MAX_HEIGHT_M') && satelliteRenderer.includes('const livePropagation =') && satelliteRenderer.includes('pointCollection.show = visible') && satelliteRenderer.includes('5_000_000_000, 0.04') && !satelliteRenderer.includes('deepSolarContext')],
  ['search navigation has no redundant Cesium target marker', !component.includes('search-target') && !component.includes('markerId = "search-target"')],
  ['search arrival is closer for addresses villages towns and cities', geocodeApi.includes('return 2_500') && geocodeApi.includes('return 8_000') && geocodeApi.includes('return 12_000') && geocodeApi.includes('return 20_000') && viewerLifecycle.includes('Math.max(2_000, point.height ?? 55_000)')],
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
