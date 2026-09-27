import { expect, test } from '@playwright/test';

test.setTimeout(240_000);

test('opens the public road-signal workspace without credentials', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('#map')).toBeVisible();
  await expect(page.locator('#analyze-button')).toBeDisabled();
  await expect(page.locator('#analysis-status')).toContainText('zoom in');
  await expect(page.locator('#bounds-readout')).not.toBeEmpty();
  await expect(page.locator('.control-accordion')).toHaveCount(2);
  await expect(page.locator('.control-accordion[open]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
});

test('analyzes Sentinel-2 COGs for the visible map area', async ({ page }) => {
  await page.goto('/');
  await page.locator('.control-accordion').filter({ hasText: 'סינון scenes' }).locator('summary').click();
  await page.locator('#interval-days').selectOption('365');
  await page.locator('.control-accordion').filter({ hasText: 'קלאסטרינג' }).locator('summary').click();
  await expect(page.locator('#feature-options input')).toHaveCount(23);
  await expect(page.locator('#feature-options input:checked')).toHaveCount(23);
  await page.locator('#feature-options input[value="0"]').uncheck();
  await expect(page.locator('#feature-options input:checked')).toHaveCount(22);
  await page.locator('#clustering-input').selectOption('pca');
  await expect(page.locator('#pca-components-label')).toBeVisible();
  await page.locator('#pca-components').selectOption('3');
  await page.locator('#map').hover();
  await page.mouse.wheel(0, -1800);
  await page.locator('#analyze-button').click();

  await expect(page.locator('#analysis-status')).toContainText('הושלם:', { timeout: 120_000 });
  await expect(page.locator('#analysis-status')).not.toContainText('קריאת COG');
  await expect(page.locator('#results-body tr')).not.toHaveCount(0);
  await expect(page.locator('#export-button')).toBeEnabled();
  await expect(page.locator('#scene-selector')).toBeEnabled();
  await expect(page.locator('#cluster-legend')).toBeVisible();
  await expect(page.locator('#cluster-legend input[type="checkbox"]')).toHaveCount(6);
  await expect(page.locator('#cluster-legend input:checked')).toHaveCount(6);
  await page.locator('#cluster-legend input[data-cluster="0"]').uncheck();
  await expect(page.locator('#cluster-legend input:checked')).toHaveCount(5);
  await expect(page.locator('#cluster-legend')).toHaveAttribute('aria-label', '5 מתוך 6 clusters מוצגים');
  await expect(page.locator('#radar-chart')).toBeVisible();
  await expect(page.locator('#radar-chart [data-series-type="cluster"]')).toHaveCount(6);
  await expect(page.locator('#radar-chart .radar-grid text')).toHaveCount(3);
  await expect(page.locator('#radar-chart .radar-grid text', { hasText: 'PC1' })).toHaveCount(1);
  await expect(page.locator('#pca-details')).toBeVisible();
  await expect(page.locator('#pca-details .pca-component-list article')).toHaveCount(3);
  await expect(page.locator('#pca-details')).toContainText('PC1');
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