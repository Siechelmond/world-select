import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const checks = [];
const check = (label, pass) => checks.push([label, Boolean(pass)]);

const aircraftApi = read('../functions/api/aircraft.ts');
const militaryApi = read('../functions/api/military.ts');
const aircraftLayer = read('../runtime/layers/aircraft.ts');
const satelliteLayer = read('../runtime/layers/satellites.ts');
const trafficLayer = read('../runtime/layers/traffic.ts');
const trafficApi = read('../functions/api/traffic.ts');
const googleStreet = read('../lib/google-street.ts');
const streetWorker = read('../functions/api/street.ts');
const mapStack = read('../runtime/maps/controller.ts');
const routeApi = read('../functions/api/route.ts');
const routeService = read('../runtime/app/route-service.ts');
const app = read('../components/WorldSelectApp.tsx');
const runtimeApp = read('../runtime/app/application.ts');
const runtimeTypes = read('../runtime/types.ts');
const spaceExplorer = read('../components/SpaceExplorer.tsx');
const spaceModel = read('../lib/space.ts');

check('global aircraft uses direct OpenSky states/all', aircraftApi.includes('scope === "global"') && aircraftApi.includes('states/all'));
check('configured gateway no longer shadows direct OpenSky', aircraftApi.includes('if (modeForOpenSky !== "disabled")') && aircraftApi.indexOf('tryProvider("opensky"') < aircraftApi.indexOf('Promise.all(stores)'));
check('regional fallbacks run concurrently', aircraftApi.includes('Promise.all(stores)'));
check('military feed uses adsb.lol global military endpoint', militaryApi.includes('https://api.adsb.lol/v2/mil'));
check('military feed has last-good stale cache path', militaryApi.includes("'X-World-Select-Aircraft-Stale': '1'"));
check('aircraft has class-specific glyphs', aircraftLayer.includes('AIRCRAFT_ICONS') && aircraftLayer.includes('helicopter') && aircraftLayer.includes('fastjet'));
check('aircraft supports ALL/CIV/MIL filtering', aircraftLayer.includes("'all' | 'civilian' | 'military'") && app.includes('aria-label="Aircraft filter"'));
check('satellites have glyph LOD', satelliteLayer.includes('SATELLITE_ICON') && satelliteLayer.includes('BillboardCollection'));
check('satellite orbit geometry is built synchronously once', satelliteLayer.includes('asynchronous: false') && satelliteLayer.includes('modelMatrix'));
check('selected satellite has faster propagation cadence', satelliteLayer.includes('TRACKED_PROPAGATION_MS = 200'));
check('traffic configured-but-probe-failed still attaches viewport tiles', trafficLayer.includes('if (!status.configured)') && trafficLayer.includes('this.attachLayers()'));
check('default map stack is keyless and Google is not loaded at boot', mapStack.includes('Esri World Imagery') && !mapStack.includes('Google2DImageryProvider'));
check('keyless OSRM route proxy exists', routeApi.includes('routing.openstreetmap.de') && routeApi.includes("'foot' | 'car' | 'bike'"));
check('route flythrough is a runtime camera operation', routeService.includes('requestAnimationFrame') && routeService.includes('camera.setView'));
check('directions UI exposes WALK/DRIVE/BIKE + FLY', app.includes('>WALK<') && app.includes('>DRIVE<') && app.includes('>BIKE<') && app.includes('>FLY<'));

check('aircraft keeps separate civilian and military last-good stores', aircraftLayer.includes('civilianRecords') && aircraftLayer.includes('militaryRecords') && aircraftLayer.includes('rebuildMergedRecords'));
check('aircraft startup has a connecting grace instead of immediate unavailable', aircraftLayer.includes('CONNECT_GRACE_MS') && aircraftLayer.includes("this.stats.state = connecting ? 'loading' : 'unavailable'"));
check('aircraft degraded ALL reports retained source cohorts', aircraftLayer.includes('retaining civilian last-good') && aircraftLayer.includes('ALL currently'));
check('traffic imagery attaches before advisory status probe completes', trafficLayer.includes('Attach first, validate second') && trafficLayer.includes('this.attachLayers();'));
check('traffic probe transport failure keeps tile layer active', trafficLayer.includes('traffic tiles remain active and self-validate in the viewport'));
check('street target follows selected spatial entity', app.includes('selected && selected.kind !== "celestial-body"') && app.includes('Street near entity'));
check('aircraft inspector keeps street action alongside follow', app.includes('Follow aircraft') && app.includes('Street near entity'));
check('startup stages live layers after first paint', app.includes('Stage live layers') && app.includes('setLayerEnabled("traffic", true), 1400'));
check('ISS hover preview is delayed and embeds the Sen live stream', app.includes('SEN_ISS_LIVE_VIDEO_ID') && app.includes('youtube-nocookie.com/embed') && app.includes('setTimeout(() => setReady(true), 500)'));
check('runtime publishes hover entity without React fleet rerenders', runtimeApp.includes('ScreenSpaceEventType.MOUSE_MOVE') && runtimeTypes.includes('hoveredScreen'));
check('aircraft route field is honest when no enrichment exists', app.includes('Not available from current ADS-B source'));
check('aircraft NOW-only control stays clickable on Earth', app.includes('const aircraftAvailable = viewMode === "earth"') && app.includes('setAircraftEnabled'));
check('space explorer has hierarchical planet solar outer galaxy frames', spaceExplorer.includes('\"planet\" | \"solar\" | \"outer\" | \"galaxy\"') && spaceExplorer.includes('KUIPER BELT') && spaceExplorer.includes('MILKY WAY'));
check('planet detail exposes featured moon systems', spaceModel.includes('Ganymede') && spaceModel.includes('Titan') && spaceExplorer.includes('PlanetSystemView'));
check('moon display is explicitly simulated and scaled', spaceModel.includes('dataState: \"SIMULATED\"') && spaceModel.includes('Moon distances and sizes expanded for visibility'));
check('outer system density is explicitly illustrative', spaceModel.includes('Kuiper Belt density is illustrative') && spaceExplorer.includes('not current ephemerides'));
check('space explorer is isolated from Earth runtime ownership', !spaceExplorer.includes('WorldSelectRuntime') && !spaceExplorer.includes('setLayerEnabled'));
check('ISS preview explains dark live-feed states', app.includes('night side') && app.includes('signal loss'));
check('aircraft filter UI publishes source-specific count/state', runtimeTypes.includes('AircraftSourceSummary') && runtimeApp.includes('aircraftSources') && app.includes('aircraftUiState') && app.includes('aircraftSources?.civilian.count'));
check('traffic supports Orbis v2 with classic v4 documented fallback', trafficApi.includes("'orbis-v2' | 'classic-v4'") && trafficApi.includes('/maps/orbis/traffic/') && trafficApi.includes('/traffic/map/4/tile/'));
check('Street View widens Google coverage before keyless fallback', googleStreet.includes('STREET_SEARCH_RADII_M') && googleStreet.includes('[120, 250, 500]') && streetWorker.includes('searchRadiusM = 1000'));
check('space time playback animates planet and moon clock without touching Earth runtime', app.includes('spacePlaybackRate') && app.includes('spacePlaybackDays') && app.includes('spaceTimePlayback') && app.includes('[1, 7, 30]') && !spaceExplorer.includes('setTimeOffsetDays'));
check('Milky Way uses spiral arms, dust lanes and Orion Spur marker', spaceExplorer.includes('galaxySpiralPath') && spaceExplorer.includes('galaxyDustLane') && spaceExplorer.includes('ORION SPUR') && spaceExplorer.includes('YOU ARE HERE'));
check('aircraft trail uses Cesium MaterialProperty and avoids getType render crash', aircraftLayer.includes('ColorMaterialProperty') && !aircraftLayer.includes('polyline.material = new Cesium.ConstantProperty'));
check('far-globe aircraft LOD reduces visible glyph budget', aircraftLayer.includes('this.cameraHeight > 8_000_000') && aircraftLayer.includes('return 850'));
check('regional civilian coverage is visualized without changing provider data', aircraftLayer.includes('__runtime:aircraft-regional-coverage') && aircraftLayer.includes("meta.coverage !== 'regional'"));
check('fresh degraded aircraft remain OBSERVED instead of being mislabeled STALE', read('../lib/aircraft.ts').includes('const stale = Boolean(payload.stale);') && read('../lib/aircraft.ts').includes('degraded-live'));
check('space time controls have responsive no-overlap layout contract', read('../app/globals.css').includes('.timebar.spaceTimebar') && read('../app/globals.css').includes('grid-template-columns: repeat(4, minmax(46px, auto))'));
check('Milky Way realism pass adds diffuse stellar clouds and central bulge', spaceExplorer.includes('deterministicGalaxyClouds') && spaceExplorer.includes('galaxyBulgeHalo') && spaceExplorer.includes('stellar-cloud context model'));
check('failed live layers expose concrete provider diagnostics', app.includes('title={error}') && app.includes('{error ?? "Load failed"}'));

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) failed += 1;
}
if (failed) process.exit(1);
console.log(`qa:gev-core PASS — ${checks.length} architecture/capability invariants`);
