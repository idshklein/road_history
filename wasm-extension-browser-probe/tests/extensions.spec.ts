import { expect, test } from '@playwright/test';

test.setTimeout(240_000);

test('opens the public road-signal workspace without credentials', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#map')).toBeVisible();
  await expect(page.locator('#analyze-button')).toBeDisabled();
  await expect(page.locator('#analysis-status')).toContainText('zoom in');
  await expect(page.locator('#bounds-readout')).not.toBeEmpty();
});

test('analyzes Sentinel-2 COGs for the visible map area', async ({ page }) => {
  await page.goto('/');
  await page.locator('#interval-days').selectOption('365');
  await expect(page.locator('#feature-options input')).toHaveCount(23);
  await expect(page.locator('#feature-options input:checked')).toHaveCount(23);
  await page.locator('#feature-options input[value="0"]').uncheck();
  await expect(page.locator('#feature-options input:checked')).toHaveCount(22);
  await page.locator('#map').hover();
  await page.mouse.wheel(0, -1800);
  await page.locator('#analyze-button').click();

  await expect(page.locator('#analysis-status')).toContainText('הושלם:', { timeout: 120_000 });
  await expect(page.locator('#analysis-status')).not.toContainText('קריאת COG');
  await expect(page.locator('#results-body tr')).not.toHaveCount(0);
  await expect(page.locator('#export-button')).toBeEnabled();
  await expect(page.locator('#scene-selector')).toBeEnabled();
  await expect(page.locator('#cluster-legend')).toBeVisible();
  await expect(page.locator('#radar-chart')).toBeVisible();
  await expect(page.locator('#radar-chart [data-series-type="cluster"]')).toHaveCount(6);
  await expect(page.locator('#radar-chart .radar-grid text')).toHaveCount(22);
  await expect(page.locator('#radar-chart .radar-grid text[text-anchor="start"]')).not.toHaveCount(0);
  await expect(page.locator('#radar-chart .radar-grid text[text-anchor="end"]')).not.toHaveCount(0);
  await expect(page.locator('img.cluster-raster-overlay')).toBeVisible();
  const rasterDimensions = await page.locator('img.cluster-raster-overlay').evaluate((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
  expect(rasterDimensions.width).toBeGreaterThan(0);
  expect(rasterDimensions.height).toBeGreaterThan(0);
  await page.locator('#map').click({ position: { x: 180, y: 180 } });
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
  await expect(page.locator('#radar-chart [data-series-type="pixel"]')).toHaveCount(1);
  await page.mouse.wheel(0, 300);
  await expect(page.locator('img.cluster-raster-overlay')).toBeVisible();
});