import * as duckdb from '@duckdb/duckdb-wasm';
import duckdbWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdbWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import { fromUrl } from 'geotiff';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { PCA } from 'ml-pca';
import proj4 from 'proj4';
import './style.css';

const sourceBands = ['blue', 'green', 'red', 'nir', 'nir08', 'swir16', 'swir22'] as const;
const sourceBandNames = ['B02', 'B03', 'B04', 'B08', 'B8A', 'B11', 'B12'];
const staticFeatureNames = [...sourceBandNames, 'NDVI', 'BSI', 'NDBI', 'B02/B04', 'B04/B08', 'B08/B11', 'B11/B12'];
const temporalFeatureNames = ['dB02', 'dB03', 'dB04', 'dB08', 'dB11', 'dB12', 'dNDVI', 'dBSI', 'dNDBI'];
const featureNames = [...staticFeatureNames, ...temporalFeatureNames];
const firstSentinelL2A = '2015-06-27';
const minimumAnalysisZoom = 15;
const clusterColors = ['#d34731', '#275f9d', '#d08d29', '#4c9b72', '#8656a5', '#3c4a4f', '#e0718b', '#6d8943', '#8a5b34', '#447f93', '#be644b', '#646a99'];

type Scene = { id: string; properties: Record<string, unknown>; assets: Record<string, { href: string;[key: string]: unknown }> };
type Selection = { pixels: [number, number, number, number]; bounds: L.LatLngBounds };
type PixelScene = { scene: Scene; date: string; cloud: number; selection: Selection; width: number; height: number; reflectance: Float32Array; vectors: Float32Array; clusterVectors: Float32Array; valid: Uint8Array; labels: Int16Array };
type PcaComponent = { label: string; variance: number; cumulativeVariance: number; loadings: Array<{ feature: string; value: number }> };
type PreparedClustering = { featureLabels: string[]; pcaComponents?: PcaComponent[] };
type ClusterModel = { featureLabels: string[]; means: Float64Array; deviations: Float64Array; centroids: Float64Array[]; pcaComponents?: PcaComponent[] };
type InspectedVector = { label: string; values: Float64Array; color: string };

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const startDate = $('#start-date') as HTMLInputElement;
const endDate = $('#end-date') as HTMLInputElement;
const cloudCover = $('#cloud-cover') as HTMLInputElement;
const cloudValue = $('#cloud-value') as HTMLElement;
const intervalDays = $('#interval-days') as HTMLSelectElement;
const clusterCount = $('#cluster-count') as HTMLSelectElement;
const clusteringInput = $('#clustering-input') as HTMLSelectElement;
const pcaComponents = $('#pca-components') as HTMLSelectElement;
const pcaComponentsLabel = $('#pca-components-label') as HTMLElement;
const featureOptions = $('#feature-options') as HTMLElement;
const analyzeButton = $('#analyze-button') as HTMLButtonElement;
const exportButton = $('#export-button') as HTMLButtonElement;
const clearMarkersButton = $('#clear-markers') as HTMLButtonElement;
const sceneSelector = $('#scene-selector') as HTMLSelectElement;
const boundsReadout = $('#bounds-readout') as HTMLElement;
const status = $('#analysis-status') as HTMLElement;
const copyDiagnosticButton = $('#copy-diagnostic') as HTMLButtonElement;
const summary = $('#result-summary') as HTMLElement;
const resultBody = $('#results-body') as HTMLTableSectionElement;
const clusterLegend = $('#cluster-legend') as HTMLElement;
const radarChart = $('#radar-chart') as HTMLElement;
const pcaDetails = $('#pca-details') as HTMLElement;
let map: L.Map;
let rasterLayer: L.LayerGroup;
let markerLayer: L.LayerGroup;
let results: PixelScene[] = [];
let database: duckdb.AsyncDuckDB | undefined;
let clusterModel: ClusterModel | undefined;
let inspectedVectors: InspectedVector[] = [];
let diagnosticLines: string[] = [];
let clusterVisibility: boolean[] = [];

cloudCover.addEventListener('input', () => { cloudValue.textContent = `${cloudCover.value}%`; });
clusteringInput.addEventListener('change', updatePcaControl);
analyzeButton.addEventListener('click', () => void analyzeVectors());
exportButton.addEventListener('click', () => void exportParquet());
copyDiagnosticButton.addEventListener('click', () => void copyDiagnostic());
clearMarkersButton.addEventListener('click', () => { markerLayer.clearLayers(); inspectedVectors = []; renderRadar(); });
sceneSelector.addEventListener('change', () => renderScene(Number(sceneSelector.value)));
clusterLegend.addEventListener('change', (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.dataset.cluster === undefined) return;
  clusterVisibility[Number(input.dataset.cluster)] = input.checked;
  renderScene(Number(sceneSelector.value));
});

function setupMap(): void {
  map = L.map('map', { zoomControl: false }).setView([32.69015, 35.4116], 14);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  rasterLayer = L.layerGroup().addTo(map); markerLayer = L.layerGroup().addTo(map);
  map.fitBounds([[32.6745, 35.3889], [32.7058, 35.4343]], { padding: [20, 20] });
  map.on('moveend zoomend', updateActionAvailability);
  map.on('click', inspectPixel);
  updateActionAvailability();
}

function updateActionAvailability(): void {
  const bounds = map.getBounds();
  boundsReadout.textContent = `${bounds.getSouth().toFixed(4)}, ${bounds.getWest().toFixed(4)}  |  ${bounds.getNorth().toFixed(4)}, ${bounds.getEast().toFixed(4)}`;
  const tooWide = map.getZoom() < minimumAnalysisZoom;
  analyzeButton.disabled = tooWide;
  if (tooWide) setStatus(`יש לבצע zoom in לרמה ${minimumAnalysisZoom} לפחות לפני ניתוח ברזולוציה מלאה.`);
}

function updatePcaControl(): void { pcaComponentsLabel.hidden = clusteringInput.value !== 'pca'; }

async function analyzeVectors(): Promise<void> {
  if (map.getZoom() < minimumAnalysisZoom) { updateActionAvailability(); return; }
  if (startDate.value < firstSentinelL2A || startDate.value > endDate.value) { setStatus(`תאריך ההתחלה חייב להיות בין ${firstSentinelL2A} לתאריך הסיום.`); return; }
  if (!selectedFeatureIndices().length) { setStatus('יש לבחור לפחות feature אחד לקלאסטרינג.'); return; }
  if (clusteringInput.value === 'pca' && selectedFeatureIndices().length < Number(pcaComponents.value)) { setStatus('יש לבחור לפחות כמספר רכיבי ה־PCA המבוקש.'); return; }
  resetDiagnostic();
  analyzeButton.disabled = true; exportButton.disabled = true; sceneSelector.replaceChildren(); results = []; clusterModel = undefined; inspectedVectors = []; clusterVisibility = []; rasterLayer.clearLayers(); markerLayer.clearLayers(); clusterLegend.hidden = true; pcaDetails.hidden = true; pcaDetails.replaceChildren(); renderRadar();
  try {
    const viewport = map.getBounds();
    setStatus('טוען scenes ודוגם bands, מדדים ושינויי זמן לכל pixel...');
    const scenes = sampleScenes(await findScenes(viewport, Number(intervalDays.value)), Number(intervalDays.value));
    if (!scenes.length) throw new Error('לא נמצאו scenes לסינון שנבחר.');
    const failedScenes: string[] = [];
    for (const [index, scene] of scenes.entries()) {
      setStatus(`קורא bands, תאריך ${index + 1} מתוך ${scenes.length}...`);
      try { results.push(await readScene(scene, viewport)); } catch (error) { failedScenes.push(scene.id); addDiagnostic('קריאת COG', error, `scene=${scene.id}`); }
    }
    if (!results.length) throw new Error(`כל ${failedScenes.length} ה־scenes שנבחרו נכשלו בקריאת COG. ניתן להעתיק אבחון.`);
    addTemporalFeatures(results);
    const featureIndices = selectedFeatureIndices();
    const prepared = prepareClusteringVectors(results, featureIndices);
    setStatus(`מריץ K-means גלובלי על ${prepared.featureLabels.length} dimensions...`);
    clusterModel = clusterAllVectors(results, Number(clusterCount.value), prepared);
    clusterVisibility = Array.from({ length: Number(clusterCount.value) }, () => true);
    renderPcaDetails();
    renderRadar();
    populateSceneSelector(); renderTable(); renderScene(results.length - 1);
    exportButton.disabled = false; setStatus(`הושלם: ${results.length} תאריכים ו־${validPixelCount().toLocaleString()} וקטורים קובצו יחד.`);
  } catch (error) { addDiagnostic('ניתוח', error); setStatus(`${message(error)} ניתן להעתיק אבחון.`); }
  finally { updateActionAvailability(); }
}

async function findScenes(viewport: L.LatLngBounds, days: number): Promise<Scene[]> {
  const endpoint = 'https://earth-search.aws.element84.com/v1/search';
  const scenes = new Map<string, Scene>(); const end = new Date(`${endDate.value}T23:59:59Z`); let bucketStart = new Date(`${startDate.value}T00:00:00Z`);
  while (bucketStart < end) {
    const bucketEnd = new Date(Math.min(bucketStart.getTime() + days * 86_400_000, end.getTime()));
    const request = { collections: ['sentinel-2-l2a'], bbox: [viewport.getWest(), viewport.getSouth(), viewport.getEast(), viewport.getNorth()], datetime: `${bucketStart.toISOString()}/${bucketEnd.toISOString()}`, query: { 'eo:cloud_cover': { lte: Number(cloudCover.value) } }, limit: 100 };
    let response: Response;
    try { response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }); }
    catch (error) { addDiagnostic('STAC POST', error, `endpoint=${endpoint}; bbox=${request.bbox.join(',')}; datetime=${request.datetime}`); throw new Error('לא ניתן לגשת לקטלוג STAC. בדוק/י חיבור, proxy או חסימת CORS.'); }
    if (!response.ok) { addDiagnostic('STAC POST', new Error(`HTTP ${response.status}`), `endpoint=${endpoint}; datetime=${request.datetime}; limit=${request.limit}`); throw new Error(`STAC החזיר ${response.status}.`); }
    const payload = await response.json() as { features?: Scene[] };
    (payload.features ?? []).filter(isBrowserReadableScene).forEach((scene) => scenes.set(scene.id, scene));
    bucketStart = bucketEnd;
  }
  return [...scenes.values()];
}

function isBrowserReadableScene(scene: Scene): boolean {
  return sourceBands.every((band) => {
    const href = scene.assets[band]?.href;
    return typeof href === 'string' && href.startsWith('https://') && /\.tiff?(?:$|[?#])/i.test(href);
  });
}

function sampleScenes(scenes: Scene[], days: number): Scene[] {
  const selected: Scene[] = []; let bucket = new Date(`${startDate.value}T00:00:00Z`); const end = new Date(`${endDate.value}T23:59:59Z`);
  while (bucket < end) {
    const bucketEnd = new Date(bucket.getTime() + days * 86_400_000);
    const candidate = scenes.filter((scene) => { const date = new Date(String(scene.properties.datetime)); return date >= bucket && date < bucketEnd; }).sort((left, right) => Number(left.properties['eo:cloud_cover'] ?? 100) - Number(right.properties['eo:cloud_cover'] ?? 100))[0];
    if (candidate) selected.push(candidate); bucket = bucketEnd;
  }
  return selected;
}

async function readScene(scene: Scene, viewport: L.LatLngBounds): Promise<PixelScene> {
  const tiffs = await Promise.all(sourceBands.map((band) => fromUrl(scene.assets[band].href)));
  const images = await Promise.all(tiffs.map((tiff) => tiff.getImage()));
  const epsg = Number(scene.properties['proj:epsg'] ?? scene.assets.red['proj:epsg']);
  if (!Number.isInteger(epsg) || epsg < 32601 || epsg > 32760) throw new Error('ל־scene אין CRS UTM נתמך.');
  const selection = viewportSelection(viewport, images[3].getBoundingBox(), images[3].getWidth(), images[3].getHeight(), epsg);
  const width = selection.pixels[2] - selection.pixels[0]; const height = selection.pixels[3] - selection.pixels[1];
  const rasters = await Promise.all(images.map(async (image) => image.readRasters({ window: viewportSelection(selection.bounds, image.getBoundingBox(), image.getWidth(), image.getHeight(), epsg).pixels, width, height, resampleMethod: 'bilinear' })));
  const reflectance = new Float32Array(width * height * sourceBands.length); const vectors = new Float32Array(width * height * staticFeatureNames.length); const valid = new Uint8Array(width * height);
  for (let pixel = 0; pixel < valid.length; pixel += 1) {
    let usable = true;
    for (let band = 0; band < sourceBands.length; band += 1) { const value = Number(rasters[band][0][pixel]); reflectance[pixel * sourceBands.length + band] = value; if (!Number.isFinite(value) || value <= 0) usable = false; }
    if (!usable) continue;
    const blue = reflectance[pixel * sourceBands.length]; const green = reflectance[pixel * sourceBands.length + 1]; const red = reflectance[pixel * sourceBands.length + 2]; const nir = reflectance[pixel * sourceBands.length + 3]; const nir8a = reflectance[pixel * sourceBands.length + 4]; const swir16 = reflectance[pixel * sourceBands.length + 5]; const swir22 = reflectance[pixel * sourceBands.length + 6];
    const features = [blue, green, red, nir, nir8a, swir16, swir22, normalizedDifference(nir, red), normalizedDifference(swir16 + red, nir + blue), normalizedDifference(swir16, nir), safeRatio(blue, red), safeRatio(red, nir), safeRatio(nir, swir16), safeRatio(swir16, swir22)];
    if (features.some((value) => !Number.isFinite(value))) continue;
    vectors.set(features, pixel * staticFeatureNames.length); valid[pixel] = 1;
  }
  return { scene, date: String(scene.properties.datetime).slice(0, 10), cloud: Number(scene.properties['eo:cloud_cover'] ?? 0), selection, width, height, reflectance, vectors, clusterVectors: new Float32Array(0), valid, labels: new Int16Array(width * height).fill(-1) };
}

function normalizedDifference(left: number, right: number): number { return (left - right) / (left + right); }
function safeRatio(numerator: number, denominator: number): number { return denominator ? numerator / denominator : Number.NaN; }

function addTemporalFeatures(scenes: PixelScene[]): void {
  for (const [sceneIndex, scene] of scenes.entries()) {
    const previous = scenes[sceneIndex - 1]; const vectors = new Float32Array(scene.valid.length * featureNames.length);
    const comparable = previous && previous.width === scene.width && previous.height === scene.height;
    for (let pixel = 0; pixel < scene.valid.length; pixel += 1) {
      const staticOffset = pixel * staticFeatureNames.length; const vectorOffset = pixel * featureNames.length;
      vectors.set(scene.vectors.subarray(staticOffset, staticOffset + staticFeatureNames.length), vectorOffset);
      if (!comparable || !scene.valid[pixel] || !previous.valid[pixel]) continue;
      const current = scene.vectors; const prior = previous.vectors;
      const deltas = [current[staticOffset] - prior[staticOffset], current[staticOffset + 1] - prior[staticOffset + 1], current[staticOffset + 2] - prior[staticOffset + 2], current[staticOffset + 3] - prior[staticOffset + 3], current[staticOffset + 5] - prior[staticOffset + 5], current[staticOffset + 6] - prior[staticOffset + 6], current[staticOffset + 7] - prior[staticOffset + 7], current[staticOffset + 8] - prior[staticOffset + 8], current[staticOffset + 9] - prior[staticOffset + 9]];
      vectors.set(deltas, vectorOffset + staticFeatureNames.length);
    }
    scene.vectors = vectors;
  }
}

function prepareClusteringVectors(scenes: PixelScene[], featureIndices: number[]): PreparedClustering {
  if (clusteringInput.value === 'raw') {
    scenes.forEach((scene) => {
      scene.clusterVectors = new Float32Array(scene.valid.length * featureIndices.length);
      scene.valid.forEach((valid, pixel) => { if (!valid) return; featureIndices.forEach((vectorFeature, feature) => { scene.clusterVectors[pixel * featureIndices.length + feature] = scene.vectors[pixel * featureNames.length + vectorFeature]; }); });
    });
    return { featureLabels: featureIndices.map((index) => featureNames[index]) };
  }
  const components = Number(pcaComponents.value); const sample = pcaSample(scenes, featureIndices, 5_000);
  if (sample.length < components) throw new Error('אין מספיק pixels תקינים להתאמת PCA.');
  const pca = new PCA(sample, { center: true, scale: true, ignoreZeroVariance: true });
  scenes.forEach((scene) => {
    const pixels: number[] = []; const rows: number[][] = [];
    scene.valid.forEach((valid, pixel) => { if (!valid) return; pixels.push(pixel); rows.push(featureIndices.map((feature) => scene.vectors[pixel * featureNames.length + feature])); });
    scene.clusterVectors = new Float32Array(scene.valid.length * components);
    pca.predict(rows, { nComponents: components }).to2DArray().forEach((row, rowIndex) => scene.clusterVectors.set(row, pixels[rowIndex] * components));
  });
  const eigenvectors = pca.getEigenvectors(); const explainedVariance = pca.getExplainedVariance(); const excluded = pca.toJSON().excludedFeatures ?? [];
  const activeFeatures = featureIndices.filter((_, index) => !excluded.includes(index)).map((index) => featureNames[index]);
  let cumulativeVariance = 0;
  const pcaMetadata: PcaComponent[] = Array.from({ length: components }, (_, component) => {
    const variance = explainedVariance[component] ?? 0; cumulativeVariance += variance;
    const loadings = activeFeatures.map((feature, row) => ({ feature, value: eigenvectors.get(row, component) })).sort((left, right) => Math.abs(right.value) - Math.abs(left.value)).slice(0, 3);
    return { label: `PC${component + 1}`, variance, cumulativeVariance, loadings };
  });
  return { featureLabels: pcaMetadata.map((component) => component.label), pcaComponents: pcaMetadata };
}

function pcaSample(scenes: PixelScene[], featureIndices: number[], maximum: number): number[][] {
  const total = validPixelCount(); const step = Math.max(1, Math.floor(total / maximum)); const sample: number[][] = []; let seen = 0;
  scenes.forEach((scene) => scene.valid.forEach((valid, pixel) => { if (!valid) return; if (seen % step === 0 && sample.length < maximum) sample.push(featureIndices.map((feature) => scene.vectors[pixel * featureNames.length + feature])); seen += 1; }));
  return sample;
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

function clusterAllVectors(scenes: PixelScene[], k: number, prepared: PreparedClustering): ClusterModel {
  const { featureLabels } = prepared;
  const means = new Float64Array(featureLabels.length); const deviations = new Float64Array(featureLabels.length); let count = 0;
  scenes.forEach((scene) => scene.valid.forEach((valid, pixel) => { if (!valid) return; count += 1; for (let feature = 0; feature < featureLabels.length; feature += 1) means[feature] += scene.clusterVectors[pixel * featureLabels.length + feature]; }));
  for (let feature = 0; feature < featureLabels.length; feature += 1) means[feature] /= count;
  scenes.forEach((scene) => scene.valid.forEach((valid, pixel) => { if (!valid) return; for (let feature = 0; feature < featureLabels.length; feature += 1) deviations[feature] += (scene.clusterVectors[pixel * featureLabels.length + feature] - means[feature]) ** 2; }));
  for (let feature = 0; feature < featureLabels.length; feature += 1) deviations[feature] = Math.sqrt(deviations[feature] / count) || 1;
  const centroids = seedCentroids(scenes, k, featureLabels.length, means, deviations);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const sums = Array.from({ length: k }, () => new Float64Array(featureLabels.length)); const sizes = new Uint32Array(k);
    scenes.forEach((scene) => scene.valid.forEach((valid, pixel) => {
      if (!valid) return; const label = nearestCentroid(scene.clusterVectors, pixel, centroids, featureLabels.length, means, deviations); scene.labels[pixel] = label; sizes[label] += 1;
      for (let feature = 0; feature < featureLabels.length; feature += 1) sums[label][feature] += (scene.clusterVectors[pixel * featureLabels.length + feature] - means[feature]) / deviations[feature];
    }));
    for (let cluster = 0; cluster < k; cluster += 1) if (sizes[cluster]) for (let feature = 0; feature < featureLabels.length; feature += 1) centroids[cluster][feature] = sums[cluster][feature] / sizes[cluster];
  }
  return { featureLabels, means, deviations, centroids, pcaComponents: prepared.pcaComponents };
}

function seedCentroids(scenes: PixelScene[], k: number, dimension: number, means: Float64Array, deviations: Float64Array): Float64Array[] {
  const centroids: Float64Array[] = []; let seen = 0; const step = Math.max(1, Math.floor(validPixelCount() / k));
  scenes.forEach((scene) => scene.valid.forEach((valid, pixel) => { if (!valid || centroids.length >= k) return; if (seen % step === 0) { const centroid = new Float64Array(dimension); for (let feature = 0; feature < dimension; feature += 1) centroid[feature] = (scene.clusterVectors[pixel * dimension + feature] - means[feature]) / deviations[feature]; centroids.push(centroid); } seen += 1; }));
  while (centroids.length < k) centroids.push(new Float64Array(dimension)); return centroids;
}

function nearestCentroid(vectors: Float32Array, pixel: number, centroids: Float64Array[], dimension: number, means: Float64Array, deviations: Float64Array): number {
  let selected = 0; let bestDistance = Number.POSITIVE_INFINITY;
  for (let cluster = 0; cluster < centroids.length; cluster += 1) { let distance = 0; for (let feature = 0; feature < dimension; feature += 1) { const delta = ((vectors[pixel * dimension + feature] - means[feature]) / deviations[feature]) - centroids[cluster][feature]; distance += delta * delta; } if (distance < bestDistance) { bestDistance = distance; selected = cluster; } }
  return selected;
}

function selectedFeatureIndices(): number[] { return Array.from(featureOptions.querySelectorAll<HTMLInputElement>('input:checked'), (input) => Number(input.value)); }

function initializeFeatureOptions(): void {
  featureOptions.replaceChildren(...featureNames.map((name, index) => {
    const label = document.createElement('label'); label.className = 'feature-option';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = String(index); input.checked = index < sourceBandNames.length;
    label.append(input, document.createTextNode(name)); return label;
  }));
}

function populateSceneSelector(): void {
  sceneSelector.replaceChildren(...results.map((result, index) => new Option(`${result.date} | עננות ${result.cloud.toFixed(0)}%`, String(index), index === results.length - 1, index === results.length - 1))); sceneSelector.disabled = false;
}

function renderScene(index: number): void {
  const result = results[index]; if (!result) return; rasterLayer.clearLayers();
  const canvas = document.createElement('canvas'); canvas.width = result.width; canvas.height = result.height; const context = canvas.getContext('2d')!; const image = context.createImageData(result.width, result.height);
  result.labels.forEach((label, pixel) => { const offset = pixel * 4; if (label < 0 || !clusterVisibility[label]) { image.data[offset + 3] = 0; return; } const color = hexToRgb(clusterColors[label % clusterColors.length]); image.data[offset] = color[0]; image.data[offset + 1] = color[1]; image.data[offset + 2] = color[2]; image.data[offset + 3] = 180; });
  context.putImageData(image, 0, 0); L.imageOverlay(canvas.toDataURL(), result.selection.bounds, { opacity: .72, className: 'cluster-raster-overlay' }).addTo(rasterLayer);
  const visibleClusters = clusterVisibility.filter(Boolean).length;
  clusterLegend.hidden = false; clusterLegend.setAttribute('aria-label', `${visibleClusters} מתוך ${clusterVisibility.length} clusters מוצגים`); clusterLegend.innerHTML = clusterVisibility.map((visible, cluster) => `<label class="cluster-toggle"><input type="checkbox" data-cluster="${cluster}" ${visible ? 'checked' : ''}/><i style="background:${clusterColors[cluster]}"></i>C${cluster + 1}</label>`).join('');
  const counts = clusterCounts(result); summary.textContent = `${result.date} | ${result.width} × ${result.height} pixels | ${counts.map((count, cluster) => `C${cluster + 1}: ${count.toLocaleString()}`).join(' | ')}`;
}

function inspectPixel(event: L.LeafletMouseEvent): void {
  const scene = results[Number(sceneSelector.value)]; if (!scene) { setStatus('הרץ ניתוח לפני סימון נקודה.'); return; }
  const x = Math.floor(((event.latlng.lng - scene.selection.bounds.getWest()) / (scene.selection.bounds.getEast() - scene.selection.bounds.getWest())) * scene.width); const y = Math.floor(((scene.selection.bounds.getNorth() - event.latlng.lat) / (scene.selection.bounds.getNorth() - scene.selection.bounds.getSouth())) * scene.height);
  if (x < 0 || y < 0 || x >= scene.width || y >= scene.height) return;
  const pixel = y * scene.width + x; if (!scene.valid[pixel]) { setStatus('אין vector תקין בנקודה שסומנה.'); return; }
  const values = featureNames.map((name, feature) => `${name}: ${scene.vectors[pixel * featureNames.length + feature].toFixed(3)}`).join('<br>');
  L.marker(event.latlng).bindPopup(`<strong>נקודת בדיקה</strong><br>Cluster C${scene.labels[pixel] + 1}<br>${values}`).addTo(markerLayer).openPopup();
  if (clusterModel) {
    const model = clusterModel; const standardized = new Float64Array(model.featureLabels.length);
    for (let feature = 0; feature < model.featureLabels.length; feature += 1) standardized[feature] = (scene.clusterVectors[pixel * model.featureLabels.length + feature] - model.means[feature]) / model.deviations[feature];
    inspectedVectors.push({ label: `P${inspectedVectors.length + 1} / C${scene.labels[pixel] + 1}`, values: standardized, color: '#17231f' });
    renderRadar();
  }
}

function renderRadar(): void {
  if (!clusterModel) { radarChart.hidden = true; radarChart.replaceChildren(); return; }
  const centroidSeries = clusterModel.centroids.map((values, cluster) => ({ label: `C${cluster + 1}`, values, color: clusterColors[cluster % clusterColors.length], type: 'cluster' }));
  const selectedSeries = inspectedVectors.map((vector) => ({ ...vector, type: 'pixel' }));
  const series = [...centroidSeries, ...selectedSeries];
  const side = 286; const center = side / 2; const radius = 93;
  const maximum = Math.max(2, ...series.flatMap((entry) => Array.from(entry.values, Math.abs)));
  const radarFeatures = clusterModel.featureLabels;
  const angle = (index: number) => (Math.PI * 2 * index / radarFeatures.length) - Math.PI / 2;
  const point = (index: number, scale: number) => `${(center + Math.cos(angle(index)) * radius * scale).toFixed(1)},${(center + Math.sin(angle(index)) * radius * scale).toFixed(1)}`;
  const label = (name: string, index: number) => { const radians = angle(index); const cosine = Math.cos(radians); const sine = Math.sin(radians); const anchor = cosine > .28 ? 'start' : cosine < -.28 ? 'end' : 'middle'; const baseline = sine > .28 ? 'hanging' : sine < -.28 ? 'auto' : 'central'; return `<text x="${point(index, 1.12).split(',')[0]}" y="${point(index, 1.12).split(',')[1]}" text-anchor="${anchor}" dominant-baseline="${baseline}">${name}</text>`; };
  const polygon = (values: Float64Array) => Array.from(values, (value, index) => point(index, .5 + (.4 * Math.max(-1, Math.min(1, value / maximum))))).join(' ');
  const axes = radarFeatures.map((name, index) => `<line x1="${center}" y1="${center}" x2="${point(index, 1)}" y2="${point(index, 1)}"/>${label(name, index)}`).join('');
  const rings = [.1, .3, .5, .7, .9].map((scale) => `<polygon points="${Array.from({ length: radarFeatures.length }, (_, index) => point(index, scale)).join(' ')}"/>`).join('');
  const lines = series.map((entry) => `<polygon data-series-type="${entry.type}" points="${polygon(entry.values)}" style="--series:${entry.color}" class="radar-series ${entry.type}"/>`).join('');
  const legend = series.map((entry) => `<span class="radar-key ${entry.type}" style="--series:${entry.color}">${entry.label}</span>`).join('');
  radarChart.hidden = false;
  radarChart.innerHTML = `<svg viewBox="0 0 ${side} ${side}" role="img" aria-label="גרף רדאר של מרכזי clusters ונקודות שנבחרו"><g class="radar-grid">${rings}${axes}</g><g>${lines}</g></svg><div class="radar-legend">${legend}</div>`;
}

function renderPcaDetails(): void {
  const components = clusterModel?.pcaComponents;
  if (!components) { pcaDetails.hidden = true; pcaDetails.replaceChildren(); return; }
  pcaDetails.hidden = false;
  pcaDetails.innerHTML = `<div class="pca-heading"><p class="eyebrow">PCA</p><h3>שונות ורכיבים</h3></div><div class="pca-component-list">${components.map((component) => `<article><strong>${component.label} <span>${(component.variance * 100).toFixed(1)}%</span></strong><small>מצטבר ${(component.cumulativeVariance * 100).toFixed(1)}%</small><p>${component.loadings.map((loading) => `${loading.feature} ${loading.value >= 0 ? '+' : ''}${loading.value.toFixed(2)}`).join(' | ')}</p></article>`).join('')}</div>`;
}

function renderTable(): void { resultBody.innerHTML = results.map((result) => { const counts = clusterCounts(result); return `<tr><td>${result.date}</td><td>${result.cloud.toFixed(0)}%</td><td>${result.width * result.height}</td><td>${counts.map((count, cluster) => `C${cluster + 1}:${count}`).join(' ')}</td></tr>`; }).join(''); }
function clusterCounts(scene: PixelScene): number[] { return Array.from({ length: Number(clusterCount.value) }, (_, cluster) => scene.labels.filter((label) => label === cluster).length); }
function validPixelCount(): number { return results.reduce((sum, scene) => sum + scene.valid.reduce((total, valid) => total + valid, 0), 0); }
function hexToRgb(hex: string): [number, number, number] { return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)]; }

async function exportParquet(): Promise<void> {
  try {
    const pcaModel = clusterModel?.pcaComponents ? clusterModel : undefined;
    const rows = results.flatMap((scene) => Array.from({ length: scene.labels.length }, (_, pixel) => {
      const row = Math.floor(pixel / scene.width); const column = pixel % scene.width; const longitude = scene.selection.bounds.getWest() + ((scene.selection.bounds.getEast() - scene.selection.bounds.getWest()) * (column + .5) / scene.width); const latitude = scene.selection.bounds.getNorth() - ((scene.selection.bounds.getNorth() - scene.selection.bounds.getSouth()) * (row + .5) / scene.height);
      const pcValues = pcaModel ? Object.fromEntries(pcaModel.featureLabels.map((name, feature) => [name, scene.clusterVectors[pixel * pcaModel.featureLabels.length + feature]])) : {};
      return { date: scene.date, cloud_cover: scene.cloud, longitude, latitude, cluster: scene.labels[pixel] < 0 ? null : scene.labels[pixel] + 1, ...Object.fromEntries(featureNames.map((name, feature) => [name, scene.vectors[pixel * featureNames.length + feature]])), ...pcValues };
    }));
    const db = await getDatabase(); const connection = await db.connect(); await db.registerFileText('pixel-vectors.json', JSON.stringify(rows)); await connection.query("COPY (SELECT * FROM read_json_auto('pixel-vectors.json')) TO 'pixel-vectors-clusters.parquet' (FORMAT PARQUET)");
    const buffer = await db.copyFileToBuffer('pixel-vectors-clusters.parquet'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([Uint8Array.from(buffer)])); link.download = 'pixel-vectors-clusters.parquet'; link.click(); URL.revokeObjectURL(link.href); await connection.close(); setStatus('וקטורי bands, מדדים ושינויי זמן וה־clusters הורדו כ־Parquet.');
  } catch (error) { setStatus(message(error)); }
}

async function getDatabase(): Promise<duckdb.AsyncDuckDB> { if (database) return database; const worker = new Worker(duckdbWorker); database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker); await database.instantiate(duckdbWasm); return database; }
function setStatus(value: string): void { status.textContent = value; }
function message(error: unknown): string { return error instanceof Error ? error.message : 'הניתוח נכשל.'; }

function resetDiagnostic(): void { diagnosticLines = []; copyDiagnosticButton.hidden = true; }
function addDiagnostic(stage: string, error: unknown, detail = ''): void {
  const entry = `[${new Date().toISOString()}] ${stage}: ${message(error)}${detail ? `\n${detail}` : ''}`;
  if (!diagnosticLines.includes(entry)) diagnosticLines.push(entry);
  copyDiagnosticButton.hidden = false;
}
async function copyDiagnostic(): Promise<void> {
  const report = ['Road Signal Lab diagnostic', `zoom=${map.getZoom()}`, `dates=${startDate.value}/${endDate.value}`, `cloud=${cloudCover.value}%`, `bounds=${boundsReadout.textContent}`, ...diagnosticLines].join('\n');
  try { await navigator.clipboard.writeText(report); setStatus('אבחון השגיאה הועתק.'); }
  catch { setStatus('לא ניתן להעתיק אוטומטית. פתח/י את כלי הפיתוח וצירף/י את הודעת השגיאה.'); }
}

startDate.min = firstSentinelL2A; endDate.min = firstSentinelL2A; initializeFeatureOptions(); updatePcaControl(); setupMap();