import * as duckdb from '@duckdb/duckdb-wasm';
import duckdbWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdbWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import { fromUrl } from 'geotiff';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import proj4 from 'proj4';
import './style.css';

type Scene = { id: string; properties: Record<string, unknown>; assets: Record<string, { href: string; [key: string]: unknown }> };
type Stage = 'NATURAL' | 'EARTHWORK' | 'FORMATION' | 'PAVED' | 'UNKNOWN';
type Cell = { ndvi: number; bsi: number; texture: number; valid: number };
type Selection = { pixels: [number, number, number, number]; bounds: L.LatLngBounds };
type SceneResult = { scene: Scene; date: string; cloud: number; selection: Selection; width: number; height: number; cells: Cell[]; stages: Stage[] };

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const credentialScreen = $('#credential-screen') as HTMLElement;
const credentialForm = $('#credential-form') as HTMLFormElement;
const locationForm = $('#location-form') as HTMLFormElement;
const locationQuery = $('#location-query') as HTMLInputElement;
const startDate = $('#start-date') as HTMLInputElement;
const endDate = $('#end-date') as HTMLInputElement;
const cloudCover = $('#cloud-cover') as HTMLInputElement;
const cloudValue = $('#cloud-value') as HTMLElement;
const intervalDays = $('#interval-days') as HTMLSelectElement;
const analyzeButton = $('#analyze-button') as HTMLButtonElement;
const exportButton = $('#export-button') as HTMLButtonElement;
const sceneSelector = $('#scene-selector') as HTMLSelectElement;
const visualizationMode = $('#visualization-mode') as HTMLSelectElement;
const boundsReadout = $('#bounds-readout') as HTMLElement;
const status = $('#analysis-status') as HTMLElement;
const summary = $('#result-summary') as HTMLElement;
const resultBody = $('#results-body') as HTMLTableSectionElement;
const stageLegend = $('#stage-legend') as HTMLElement;
let map: L.Map;
let stageLayer: L.LayerGroup;
let envelopeLayer: L.LayerGroup;
let sessionActive = false;
let results: SceneResult[] = [];
let database: duckdb.AsyncDuckDB | undefined;

credentialForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const values = new FormData(credentialForm);
  sessionActive = Boolean(values.get('access-key') && values.get('secret-key'));
  if (!sessionActive) return;
  credentialScreen.hidden = true;
  map.invalidateSize();
});

cloudCover.addEventListener('input', () => { cloudValue.textContent = `${cloudCover.value}%`; });
analyzeButton.addEventListener('click', () => void analyzeConstruction());
exportButton.addEventListener('click', () => void exportParquet());
sceneSelector.addEventListener('change', () => renderScene(Number(sceneSelector.value)));
visualizationMode.addEventListener('change', () => renderScene(Number(sceneSelector.value)));
locationForm.addEventListener('submit', (event) => void centerLocation(event));

function setupMap(): void {
  map = L.map('map', { zoomControl: false }).setView([32.69015, 35.4116], 14);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  stageLayer = L.layerGroup().addTo(map);
  envelopeLayer = L.layerGroup().addTo(map);
  map.fitBounds([[32.6745, 35.3889], [32.7058, 35.4343]], { padding: [20, 20] });
  map.on('moveend', updateBounds);
  updateBounds();
}

function updateBounds(): void {
  const bounds = map.getBounds();
  boundsReadout.textContent = `${bounds.getSouth().toFixed(4)}, ${bounds.getWest().toFixed(4)}  |  ${bounds.getNorth().toFixed(4)}, ${bounds.getEast().toFixed(4)}`;
}

async function centerLocation(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const query = locationQuery.value.trim();
  if (!query) return;
  setStatus('מאתר אזור...');
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`);
    const places = await response.json() as Array<{ lat: string; lon: string }>;
    if (!places[0]) throw new Error('לא נמצא אזור תואם.');
    map.setView([Number(places[0].lat), Number(places[0].lon)], 14);
    setStatus('האזור עודכן.');
  } catch (error) { setStatus(message(error)); }
}

async function analyzeConstruction(): Promise<void> {
  if (!sessionActive || startDate.value > endDate.value) { setStatus('יש לבחור טווח תאריכים תקין.'); return; }
  analyzeButton.disabled = true; exportButton.disabled = true; results = []; resultBody.replaceChildren(); sceneSelector.replaceChildren();
  stageLayer.clearLayers(); envelopeLayer.clearLayers(); stageLegend.hidden = true; visualizationMode.disabled = true;
  try {
    const viewport = map.getBounds();
    setStatus('טוען time series...');
    const scenes = await findScenes(viewport);
    const sampled = sampleScenes(scenes, Number(intervalDays.value));
    if (!sampled.length) throw new Error('לא נמצאו scenes לסינון שנבחר.');
    const raw: Omit<SceneResult, 'stages'>[] = [];
    for (const [index, scene] of sampled.entries()) {
      setStatus(`מנתח תאריך ${index + 1} מתוך ${sampled.length}...`);
      try { raw.push(await analyzeScene(scene, viewport)); } catch { /* tile can be outside the viewport */ }
    }
    if (!raw.length) throw new Error('לא נמצאו pixels תקינים באזור הנראה.');
    const baseline = raw[0].cells;
    results = raw.map((entry) => ({ ...entry, stages: entry.cells.map((cell, index) => classifyStage(cell, baseline[index])) }));
    populateSceneSelector(); renderTable(); renderScene(results.length - 1);
    exportButton.disabled = false; setStatus(`הושלם: ${results.length} תאריכים נותחו.`);
  } catch (error) { setStatus(message(error)); }
  finally { analyzeButton.disabled = false; }
}

async function findScenes(viewport: L.LatLngBounds): Promise<Scene[]> {
  const response = await fetch('https://earth-search.aws.element84.com/v1/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      bbox: [viewport.getWest(), viewport.getSouth(), viewport.getEast(), viewport.getNorth()],
      datetime: `${startDate.value}T00:00:00Z/${endDate.value}T23:59:59Z`,
      query: { 'eo:cloud_cover': { lte: Number(cloudCover.value) } }, limit: 500,
      sortby: [{ field: 'properties.datetime', direction: 'asc' }],
    }),
  });
  if (!response.ok) throw new Error(`STAC החזיר ${response.status}.`);
  const payload = await response.json() as { features?: Scene[] };
  return (payload.features ?? []).filter((scene) => ['blue', 'red', 'nir', 'swir16'].every((band) => Boolean(scene.assets[band]?.href)));
}

function sampleScenes(scenes: Scene[], days: number): Scene[] {
  const selected: Scene[] = [];
  let bucketStart = new Date(`${startDate.value}T00:00:00Z`);
  const end = new Date(`${endDate.value}T23:59:59Z`);
  while (bucketStart < end) {
    const bucketEnd = new Date(bucketStart.getTime() + days * 86_400_000);
    const candidate = scenes.filter((scene) => {
      const date = new Date(String(scene.properties.datetime));
      return date >= bucketStart && date < bucketEnd;
    }).sort((left, right) => Number(left.properties['eo:cloud_cover'] ?? 100) - Number(right.properties['eo:cloud_cover'] ?? 100))[0];
    if (candidate) selected.push(candidate);
    bucketStart = bucketEnd;
  }
  return selected;
}

async function analyzeScene(scene: Scene, viewport: L.LatLngBounds): Promise<Omit<SceneResult, 'stages'>> {
  const [blueTiff, redTiff, nirTiff, swirTiff] = await Promise.all(['blue', 'red', 'nir', 'swir16'].map((band) => fromUrl(scene.assets[band].href)));
  const [blueImage, redImage, nirImage, swirImage] = await Promise.all([blueTiff.getImage(), redTiff.getImage(), nirTiff.getImage(), swirTiff.getImage()]);
  const epsg = Number(scene.properties['proj:epsg'] ?? scene.assets.red['proj:epsg']);
  if (!Number.isInteger(epsg) || epsg < 32601 || epsg > 32760) throw new Error('ל־scene אין CRS UTM נתמך.');
  const selection = viewportSelection(viewport, redImage.getBoundingBox(), redImage.getWidth(), redImage.getHeight(), epsg);
  const width = selection.pixels[2] - selection.pixels[0];
  const height = selection.pixels[3] - selection.pixels[1];
  const read = async (image: Awaited<ReturnType<typeof redTiff.getImage>>) => image.readRasters({ window: viewportSelection(selection.bounds, image.getBoundingBox(), image.getWidth(), image.getHeight(), epsg).pixels, width, height, resampleMethod: 'bilinear' });
  const [blue, red, nir, swir] = await Promise.all([read(blueImage), read(redImage), read(nirImage), read(swirImage)]);
  return { scene, date: String(scene.properties.datetime).slice(0, 10), cloud: Number(scene.properties['eo:cloud_cover'] ?? 0), selection, width, height, cells: buildCells(blue[0], red[0], nir[0], swir[0], width, height) };
}

function viewportSelection(bounds: L.LatLngBounds, extent: number[], width: number, height: number, epsg: number): Selection {
  const zone = epsg % 100; const utm = `+proj=utm +zone=${zone} ${epsg >= 32700 ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`;
  const corners = [[bounds.getWest(), bounds.getSouth()], [bounds.getWest(), bounds.getNorth()], [bounds.getEast(), bounds.getSouth()], [bounds.getEast(), bounds.getNorth()]].map(([longitude, latitude]) => proj4('EPSG:4326', utm, [longitude, latitude]));
  const xs = corners.map(([x]) => x); const ys = corners.map(([, y]) => y); const [minX, minY, maxX, maxY] = extent;
  const west = Math.max(minX, Math.min(...xs)); const east = Math.min(maxX, Math.max(...xs)); const south = Math.max(minY, Math.min(...ys)); const north = Math.min(maxY, Math.max(...ys));
  if (west >= east || south >= north) throw new Error('ה־viewport אינו חופף ל־scene.');
  const pixels: [number, number, number, number] = [Math.max(0, Math.floor(((west - minX) / (maxX - minX)) * width)), Math.max(0, Math.floor(((maxY - north) / (maxY - minY)) * height)), Math.min(width, Math.ceil(((east - minX) / (maxX - minX)) * width)), Math.min(height, Math.ceil(((maxY - south) / (maxY - minY)) * height))];
  const [westLongitude, southLatitude] = proj4(utm, 'EPSG:4326', [west, south]); const [eastLongitude, northLatitude] = proj4(utm, 'EPSG:4326', [east, north]);
  return { pixels, bounds: L.latLngBounds([southLatitude, westLongitude], [northLatitude, eastLongitude]) };
}

function buildCells(blue: ArrayLike<number>, red: ArrayLike<number>, nir: ArrayLike<number>, swir: ArrayLike<number>, width: number, height: number): Cell[] {
  const cells: Cell[] = Array.from({ length: width * height }, () => ({ ndvi: Number.NaN, bsi: Number.NaN, texture: Number.NaN, valid: 0 }));
  for (let index = 0; index < cells.length; index += 1) {
    const b = Number(blue[index]); const r = Number(red[index]); const n = Number(nir[index]); const s = Number(swir[index]);
    if (b + r + n + s <= 0 || n + r === 0 || s + r + n + b === 0) continue;
    cells[index] = { ndvi: (n - r) / (n + r), bsi: ((s + r) - (n + b)) / ((s + r) + (n + b)), texture: 0, valid: 1 };
  }
  for (let index = 0; index < cells.length; index += 1) {
    const neighbors = [index - 1, index + 1, index - width, index + width].filter((neighbor) => neighbor >= 0 && neighbor < cells.length && !(neighbor === index - 1 && index % width === 0) && !(neighbor === index + 1 && index % width === width - 1) && cells[neighbor].valid);
    if (!cells[index].valid || !neighbors.length) continue;
    cells[index].texture = neighbors.reduce((sum, neighbor) => sum + Math.abs(cells[index].ndvi - cells[neighbor].ndvi), 0) / neighbors.length;
  }
  return cells;
}

function classifyStage(cell: Cell, baseline: Cell): Stage {
  if (cell.valid < .6 || !Number.isFinite(cell.ndvi) || !Number.isFinite(cell.bsi)) return 'UNKNOWN';
  const deltaNdvi = cell.ndvi - baseline.ndvi;
  if (cell.ndvi > .26 && cell.bsi < .05) return 'NATURAL';
  if (cell.ndvi < .16 && cell.bsi > .06 && deltaNdvi < -.05) return 'EARTHWORK';
  if (cell.ndvi < .13 && cell.bsi < .03 && cell.texture < .055) return 'PAVED';
  if (cell.ndvi < .20 && cell.bsi > -.08) return 'FORMATION';
  return 'NATURAL';
}

function populateSceneSelector(): void {
  sceneSelector.replaceChildren(...results.map((result, index) => new Option(`${result.date} | עננות ${result.cloud.toFixed(0)}%`, String(index), index === results.length - 1, index === results.length - 1)));
  sceneSelector.disabled = false;
  visualizationMode.disabled = results.length < 2;
}

function renderScene(index: number): void {
  const result = results[index]; if (!result) return;
  stageLayer.clearLayers(); envelopeLayer.clearLayers();
  const canvas = document.createElement('canvas'); canvas.width = result.width; canvas.height = result.height;
  const context = canvas.getContext('2d')!; const image = context.createImageData(result.width, result.height);
  const previous = results[index - 1];
  const showingChange = visualizationMode.value === 'change' && previous !== undefined;
  if (showingChange) result.stages.forEach((stage, pixelIndex) => paintChangePixel(image.data, pixelIndex, previous.stages[pixelIndex], stage));
  else result.stages.forEach((stage, pixelIndex) => paintPixel(image.data, pixelIndex, stage));
  context.putImageData(image, 0, 0);
  L.imageOverlay(canvas.toDataURL(), result.selection.bounds, { opacity: .72, className: 'stage-raster-overlay' }).addTo(stageLayer);
  const envelope = L.latLngBounds([] as L.LatLngExpression[]);
  results.forEach((entry) => entry.stages.forEach((stage, cellIndex) => {
    if (stage !== 'NATURAL' && stage !== 'UNKNOWN') envelope.extend(pixelBounds(entry.selection.bounds, cellIndex, entry.width, entry.height));
  }));
  if (envelope.isValid()) L.rectangle(envelope, { color: '#162d29', weight: 2, dashArray: '5 5', fill: false }).bindTooltip('תיחום בנייה מועמד').addTo(envelopeLayer);
  stageLegend.hidden = false;
  stageLegend.innerHTML = showingChange
    ? '<span class="earthwork"></span>התקדמות לעפר <span class="formation"></span>התקדמות למצע <span class="paved"></span>התקדמות לסלילה <i></i>תיחום'
    : '<span class="earthwork"></span>עפר <span class="formation"></span>מצע <span class="paved"></span>סלילה <i></i>תיחום';
  const counts = stageCounts(result.stages);
  const changedPixels = previous ? result.stages.filter((stage, pixelIndex) => stage !== previous.stages[pixelIndex] && stage !== 'UNKNOWN' && previous.stages[pixelIndex] !== 'UNKNOWN').length : 0;
  summary.textContent = showingChange
    ? `${previous.date} → ${result.date} | ${changedPixels.toLocaleString()} pixels שינו שלב | התיחום המקווקו מצטבר לכל התקופה`
    : `${result.date} | עבודות עפר ${counts.EARTHWORK.toLocaleString()} | מצע ${counts.FORMATION.toLocaleString()} | סלילה ${counts.PAVED.toLocaleString()} | תיחום בנייה מסומן במקף`;
}

function pixelBounds(bounds: L.LatLngBounds, index: number, width: number, height: number): L.LatLngBoundsExpression {
  const row = Math.floor(index / width); const column = index % width;
  const west = bounds.getWest() + ((bounds.getEast() - bounds.getWest()) * column / width); const east = bounds.getWest() + ((bounds.getEast() - bounds.getWest()) * (column + 1) / width);
  const north = bounds.getNorth() - ((bounds.getNorth() - bounds.getSouth()) * row / height); const south = bounds.getNorth() - ((bounds.getNorth() - bounds.getSouth()) * (row + 1) / height);
  return [[south, west], [north, east]];
}

function paintPixel(data: Uint8ClampedArray, index: number, stage: Stage): void {
  const color = ({ EARTHWORK: [180, 83, 56], FORMATION: [210, 141, 45], PAVED: [56, 77, 134], NATURAL: [0, 0, 0], UNKNOWN: [0, 0, 0] })[stage];
  const offset = index * 4; data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2]; data[offset + 3] = stage === 'NATURAL' || stage === 'UNKNOWN' ? 0 : 170;
}

function paintChangePixel(data: Uint8ClampedArray, index: number, previous: Stage, current: Stage): void {
  const rank = (stage: Stage) => ({ NATURAL: 0, EARTHWORK: 1, FORMATION: 2, PAVED: 3, UNKNOWN: -1 })[stage];
  const offset = index * 4;
  if (previous === current || previous === 'UNKNOWN' || current === 'UNKNOWN') { data[offset + 3] = 0; return; }
  const color = rank(current) > rank(previous)
    ? ({ EARTHWORK: [180, 83, 56], FORMATION: [210, 141, 45], PAVED: [56, 77, 134], NATURAL: [88, 167, 126] })[current]
    : [81, 115, 105];
  data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2]; data[offset + 3] = 190;
}

function renderTable(): void {
  resultBody.innerHTML = results.map((result, index) => { const counts = stageCounts(result.stages); return `<tr data-index="${index}"><td>${result.date}</td><td>${result.cloud.toFixed(0)}%</td><td>${counts.EARTHWORK}</td><td>${counts.FORMATION}</td><td>${counts.PAVED}</td></tr>`; }).join('');
}

function stageCounts(stages: Stage[]): Record<Stage, number> { return stages.reduce((counts, stage) => ({ ...counts, [stage]: counts[stage] + 1 }), { NATURAL: 0, EARTHWORK: 0, FORMATION: 0, PAVED: 0, UNKNOWN: 0 }); }
function stageColor(stage: Stage): string { return ({ EARTHWORK: '#b45338', FORMATION: '#d28d2d', PAVED: '#384d86', NATURAL: '#58a77e', UNKNOWN: '#9ba8a2' })[stage]; }
function stageLabel(stage: Stage): string { return ({ EARTHWORK: 'עבודות עפר', FORMATION: 'מצע / הכנה', PAVED: 'סלילה', NATURAL: 'טבעי', UNKNOWN: 'לא ידוע' })[stage]; }

async function exportParquet(): Promise<void> {
  try {
    const rows = results.flatMap((result) => result.stages.map((stage, index) => ({ date: result.date, cloud_cover: result.cloud, cell_index: index, stage })));
    const db = await getDatabase(); const connection = await db.connect(); await db.registerFileText('construction-stages.json', JSON.stringify(rows));
    await connection.query("COPY (SELECT * FROM read_json_auto('construction-stages.json')) TO 'construction-stages.parquet' (FORMAT PARQUET)");
    const buffer = await db.copyFileToBuffer('construction-stages.parquet'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([Uint8Array.from(buffer)])); link.download = 'construction-stages.parquet'; link.click(); URL.revokeObjectURL(link.href); await connection.close(); setStatus('קובץ Parquet הורד.');
  } catch (error) { setStatus(message(error)); }
}

async function getDatabase(): Promise<duckdb.AsyncDuckDB> { if (database) return database; const worker = new Worker(duckdbWorker); database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker); await database.instantiate(duckdbWasm); return database; }
function setStatus(value: string): void { status.textContent = value; }
function message(error: unknown): string { return error instanceof Error ? error.message : 'הניתוח נכשל.'; }

setupMap();