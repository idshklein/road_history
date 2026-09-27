import * as duckdb from '@duckdb/duckdb-wasm';
import duckdbWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdbWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import { fromUrl } from 'geotiff';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import proj4 from 'proj4';
import './style.css';

type Scene = { id: string; properties: Record<string, unknown>; assets: Record<string, { href: string; [key: string]: unknown }> };
type RecordRow = { scene_id: string; date: string; cloud_cover: number; ndvi_mean: number; texture: number; road_signal: number; valid_fraction: number };
type Detection = { column: number; row: number; score: number };
type WindowSelection = { pixels: [number, number, number, number]; bounds: L.LatLngBounds };

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const credentialScreen = $('#credential-screen') as HTMLElement;
const app = $('#app') as HTMLElement;
const credentialForm = $('#credential-form') as HTMLFormElement;
const locationForm = $('#location-form') as HTMLFormElement;
const locationQuery = $('#location-query') as HTMLInputElement;
const startDate = $('#start-date') as HTMLInputElement;
const endDate = $('#end-date') as HTMLInputElement;
const cloudCover = $('#cloud-cover') as HTMLInputElement;
const cloudValue = $('#cloud-value') as HTMLElement;
const analyzeButton = $('#analyze-button') as HTMLButtonElement;
const exportButton = $('#export-button') as HTMLButtonElement;
const boundsReadout = $('#bounds-readout') as HTMLElement;
const status = $('#analysis-status') as HTMLElement;
const summary = $('#result-summary') as HTMLElement;
const resultBody = $('#results-body') as HTMLTableSectionElement;
const detectionLegend = $('#detection-legend') as HTMLElement;
let map: L.Map;
let sessionActive = false;
let results: RecordRow[] = [];
let database: duckdb.AsyncDuckDB | undefined;
let detectionLayer: L.LayerGroup;

credentialForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const values = new FormData(credentialForm);
  sessionActive = Boolean(values.get('access-key') && values.get('secret-key'));
  if (!sessionActive) return;
  credentialScreen.hidden = true;
  map.invalidateSize();
});

cloudCover.addEventListener('input', () => { cloudValue.textContent = `${cloudCover.value}%`; });
analyzeButton.addEventListener('click', () => void analyze());
exportButton.addEventListener('click', () => void exportParquet());

locationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = locationQuery.value.trim();
  if (!query) return;
  setStatus('מאתר אזור...');
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`);
    const places = await response.json() as Array<{ lat: string; lon: string }>;
    if (!places[0]) throw new Error('לא נמצא אזור תואם.');
    map.setView([Number(places[0].lat), Number(places[0].lon)], 13);
    setStatus('האזור עודכן.');
  } catch (error) { setStatus(message(error)); }
});

function setupMap(): void {
  map = L.map('map', { zoomControl: false }).setView([31.7683, 35.2137], 10);
  detectionLayer = L.layerGroup().addTo(map);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  map.on('moveend', updateBounds);
  updateBounds();
}

function updateBounds(): void {
  const bounds = map.getBounds();
  boundsReadout.textContent = `${bounds.getSouth().toFixed(4)}, ${bounds.getWest().toFixed(4)}  |  ${bounds.getNorth().toFixed(4)}, ${bounds.getEast().toFixed(4)}`;
  detectionLayer?.clearLayers();
  detectionLegend.hidden = true;
}

setupMap();

async function analyze(): Promise<void> {
  if (!sessionActive || startDate.value > endDate.value) { setStatus('יש לבחור טווח תאריכים תקין.'); return; }
  analyzeButton.disabled = true;
  exportButton.disabled = true;
  results = [];
  resultBody.replaceChildren();
  try {
    const bounds = map.getBounds();
    setStatus('מחפש scenes תואמים...');
    const response = await fetch('https://earth-search.aws.element84.com/v1/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collections: ['sentinel-2-l2a'],
        bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        datetime: `${startDate.value}T00:00:00Z/${endDate.value}T23:59:59Z`,
        query: { 'eo:cloud_cover': { lte: Number(cloudCover.value) } }, limit: 24,
      }),
    });
    if (!response.ok) throw new Error(`STAC החזיר ${response.status}.`);
    const payload = await response.json() as { features?: Scene[] };
    const scenes = (payload.features ?? []).filter((scene) => scene.assets.red?.href && scene.assets.nir?.href)
      .sort((a, b) => String(a.properties.datetime).localeCompare(String(b.properties.datetime))).slice(0, 3);
    if (!scenes.length) throw new Error('לא נמצאו scenes לסינון שנבחר.');
    for (const [index, scene] of scenes.entries()) {
      setStatus(`מנתח scene ${index + 1} מתוך ${scenes.length}...`);
      try { results.push(await analyzeScene(scene, bounds)); } catch { /* non-overlapping tiles are ignored */ }
    }
    if (!results.length) throw new Error('לא נמצאו pixels תקינים באזור הנראה.');
    renderResults();
    exportButton.disabled = false;
    setStatus(`הושלם: ${results.length} scenes נותחו.`);
  } catch (error) { setStatus(message(error)); }
  finally { analyzeButton.disabled = false; }
}

async function analyzeScene(scene: Scene, bounds: L.LatLngBounds): Promise<RecordRow> {
  const [redTiff, nirTiff] = await Promise.all([fromUrl(scene.assets.red.href), fromUrl(scene.assets.nir.href)]);
  const [redImage, nirImage] = await Promise.all([redTiff.getImage(), nirTiff.getImage()]);
  const epsg = Number(scene.properties['proj:epsg'] ?? scene.assets.red['proj:epsg']);
  if (!Number.isInteger(epsg) || epsg < 32601 || epsg > 32760) throw new Error('ל־scene אין CRS UTM נתמך.');
  const selection = viewportWindow(bounds, redImage.getBoundingBox(), redImage.getWidth(), redImage.getHeight(), epsg);
  const options = { window: selection.pixels, width: 96, height: 96, resampleMethod: 'bilinear' as const };
  const [red, nir] = await Promise.all([redImage.readRasters(options), nirImage.readRasters(options)]);
  const metrics = calculateMetrics(red[0], nir[0], 96);
  drawDetections(selection.bounds, metrics.detections);
  const { detections: _detections, ...surfaceMetrics } = metrics;
  return {
    scene_id: scene.id, date: String(scene.properties.datetime).slice(0, 10),
    cloud_cover: Number(scene.properties['eo:cloud_cover'] ?? 0), ...surfaceMetrics,
  };
}

function viewportWindow(bounds: L.LatLngBounds, extent: number[], width: number, height: number, epsg: number): WindowSelection {
  const zone = epsg % 100;
  const utm = `+proj=utm +zone=${zone} ${epsg >= 32700 ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`;
  const points = [[bounds.getWest(), bounds.getSouth()], [bounds.getWest(), bounds.getNorth()], [bounds.getEast(), bounds.getSouth()], [bounds.getEast(), bounds.getNorth()]]
    .map(([longitude, latitude]) => proj4('EPSG:4326', utm, [longitude, latitude]));
  const xs = points.map(([x]) => x); const ys = points.map(([, y]) => y);
  const [minX, minY, maxX, maxY] = extent;
  const west = Math.max(minX, Math.min(...xs)); const east = Math.min(maxX, Math.max(...xs));
  const south = Math.max(minY, Math.min(...ys)); const north = Math.min(maxY, Math.max(...ys));
  if (west >= east || south >= north) throw new Error('ה־viewport אינו חופף ל־scene.');
  const pixels: [number, number, number, number] = [
    Math.max(0, Math.floor(((west - minX) / (maxX - minX)) * width)),
    Math.max(0, Math.floor(((maxY - north) / (maxY - minY)) * height)),
    Math.min(width, Math.ceil(((east - minX) / (maxX - minX)) * width)),
    Math.min(height, Math.ceil(((maxY - south) / (maxY - minY)) * height)),
  ];
  const [westLongitude, southLatitude] = proj4(utm, 'EPSG:4326', [west, south]);
  const [eastLongitude, northLatitude] = proj4(utm, 'EPSG:4326', [east, north]);
  return { pixels, bounds: L.latLngBounds([southLatitude, westLongitude], [northLatitude, eastLongitude]) };
}

function calculateMetrics(red: ArrayLike<number>, nir: ArrayLike<number>, width: number): Omit<RecordRow, 'scene_id' | 'date' | 'cloud_cover'> & { detections: Detection[] } {
  const ndvi = new Float64Array(red.length).fill(Number.NaN); const valid: number[] = [];
  for (let index = 0; index < red.length; index += 1) {
    const denominator = Number(red[index]) + Number(nir[index]);
    if (denominator <= 0) continue;
    const value = (Number(nir[index]) - Number(red[index])) / denominator;
    if (Number.isFinite(value)) { ndvi[index] = value; valid.push(value); }
  }
  if (!valid.length) throw new Error('לא נמצאו pixels תקינים.');
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  let differences = 0; let count = 0;
  for (let index = 0; index < ndvi.length; index += 1) for (const neighbor of [index + 1, index + width]) {
    if (neighbor >= ndvi.length || (neighbor === index + 1 && index % width === width - 1) || !Number.isFinite(ndvi[index]) || !Number.isFinite(ndvi[neighbor])) continue;
    differences += Math.abs(ndvi[index] - ndvi[neighbor]); count += 1;
  }
  const texture = count ? differences / count : 0;
  return {
    ndvi_mean: mean, texture, road_signal: Math.max(0, Math.min(100, (1 - mean) * 60 + texture * 220)),
    valid_fraction: valid.length / red.length, detections: findDetections(ndvi, width),
  };
}

function findDetections(ndvi: Float64Array, width: number): Detection[] {
  const gridSize = 12;
  const cellSize = width / gridSize;
  const detections: Detection[] = [];
  for (let row = 0; row < gridSize; row += 1) for (let column = 0; column < gridSize; column += 1) {
    const values: number[] = [];
    for (let y = row * cellSize; y < (row + 1) * cellSize; y += 1) for (let x = column * cellSize; x < (column + 1) * cellSize; x += 1) {
      const value = ndvi[Math.floor(y) * width + Math.floor(x)];
      if (Number.isFinite(value)) values.push(value);
    }
    if (values.length < cellSize * cellSize * .6) continue;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    const score = Math.max(0, Math.min(100, (1 - mean) * 60 + variation * 120));
    if (score >= 55) detections.push({ column, row, score });
  }
  return detections.sort((left, right) => right.score - left.score).slice(0, 30);
}

function drawDetections(bounds: L.LatLngBounds, detections: Detection[]): void {
  detectionLayer.clearLayers();
  const gridSize = 12;
  for (const detection of detections) {
    const west = bounds.getWest() + ((bounds.getEast() - bounds.getWest()) * detection.column / gridSize);
    const east = bounds.getWest() + ((bounds.getEast() - bounds.getWest()) * (detection.column + 1) / gridSize);
    const north = bounds.getNorth() - ((bounds.getNorth() - bounds.getSouth()) * detection.row / gridSize);
    const south = bounds.getNorth() - ((bounds.getNorth() - bounds.getSouth()) * (detection.row + 1) / gridSize);
    L.rectangle([[south, west], [north, east]], { color: '#a84d31', weight: 1, fillColor: '#e9c672', fillOpacity: .52 })
      .bindTooltip(`אות פני־שטח ${detection.score.toFixed(0)}`).addTo(detectionLayer);
  }
  detectionLegend.hidden = detections.length === 0;
}

function renderResults(): void {
  const latest = results.at(-1)!;
  summary.textContent = `${results.length} scenes | NDVI אחרון ${latest.ndvi_mean.toFixed(3)} | פיקסלים תקינים ${Math.round(latest.valid_fraction * 100)}%`;
  resultBody.innerHTML = results.map((row) => `<tr><td>${row.date}</td><td>${row.cloud_cover.toFixed(0)}%</td><td>${row.ndvi_mean.toFixed(3)}</td><td>${row.texture.toFixed(3)}</td><td><span class="signal-value">${row.road_signal.toFixed(0)}</span></td></tr>`).join('');
}

async function exportParquet(): Promise<void> {
  try {
    setStatus('מכין Parquet...');
    const db = await getDatabase(); const connection = await db.connect();
    await db.registerFileText('road-signals.json', JSON.stringify(results));
    await connection.query("COPY (SELECT * FROM read_json_auto('road-signals.json')) TO 'road-signals.parquet' (FORMAT PARQUET)");
    const buffer = await db.copyFileToBuffer('road-signals.parquet');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([Uint8Array.from(buffer)])); link.download = 'road-signals.parquet'; link.click(); URL.revokeObjectURL(link.href);
    await connection.close(); setStatus('קובץ Parquet הורד.');
  } catch (error) { setStatus(message(error)); }
}

async function getDatabase(): Promise<duckdb.AsyncDuckDB> {
  if (database) return database;
  const worker = new Worker(duckdbWorker); database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await database.instantiate(duckdbWasm); return database;
}

function setStatus(value: string): void { status.textContent = value; }
function message(error: unknown): string { return error instanceof Error ? error.message : 'הניתוח נכשל.'; }