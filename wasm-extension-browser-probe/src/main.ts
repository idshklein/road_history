import * as duckdb from '@duckdb/duckdb-wasm';
import duckdbWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdbWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import { fromUrl } from 'geotiff';

type ProbeResult = {
  extension: string;
  outcome: 'loaded' | 'failed';
  detail: string;
};

declare global {
  interface Window {
    duckdbExtensionProbe?: ProbeResult[];
    sentinelCogProbe?: ProbeResult;
  }
}

const status = document.querySelector<HTMLParagraphElement>('#status')!;
const resultsElement = document.querySelector<HTMLPreElement>('#results')!;
const extensions = ['spatial', 'httpfs', 'raster'];
const cogUrls = {
  b04: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/36/S/XA/2023/12/S2B_36SXA_20231231_0_L2A/B04.tif',
  b08: 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/36/S/XA/2023/12/S2B_36SXA_20231231_0_L2A/B08.tif',
};

async function readCogWindow(url: string): Promise<string> {
  const tiff = await fromUrl(url);
  const image = await tiff.getImage();
  const values = await image.readRasters({ window: [5_000, 5_000, 5_016, 5_016] });

  return `${image.getWidth()}x${image.getHeight()}, ${values[0].length} pixels`;
}

async function runProbe(): Promise<void> {
  const worker = new Worker(duckdbWorker);
  const database = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  const results: ProbeResult[] = [];

  try {
    await database.instantiate(duckdbWasm);
    const connection = await database.connect();

    for (const extension of extensions) {
      try {
        const installCommand = extension === 'raster'
          ? 'INSTALL raster FROM community;'
          : `INSTALL ${extension};`;

        await connection.query(installCommand);
      } catch (error) {
        results.push({
          extension,
          outcome: 'failed',
          detail: `INSTALL failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      try {
        await connection.query(`LOAD ${extension};`);
        results.push({ extension, outcome: 'loaded', detail: 'INSTALL and LOAD succeeded.' });
      } catch (error) {
        results.push({
          extension,
          outcome: 'failed',
          detail: `LOAD failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    await connection.close();

    try {
      const [b04, b08] = await Promise.all([readCogWindow(cogUrls.b04), readCogWindow(cogUrls.b08)]);
      window.sentinelCogProbe = {
        extension: 'Sentinel-2 COG',
        outcome: 'loaded',
        detail: `B04 ${b04}; B08 ${b08}`,
      };
    } catch (error) {
      window.sentinelCogProbe = {
        extension: 'Sentinel-2 COG',
        outcome: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    window.duckdbExtensionProbe = results;
    resultsElement.textContent = JSON.stringify({ extensions: results, cog: window.sentinelCogProbe }, null, 2);
    status.textContent = 'Completed';
    await database.terminate();
    worker.terminate();
  }
}

runProbe().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  window.duckdbExtensionProbe = [{ extension: 'runtime', outcome: 'failed', detail }];
  resultsElement.textContent = JSON.stringify(window.duckdbExtensionProbe, null, 2);
  status.textContent = 'Completed';
});