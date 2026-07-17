import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// General smoke net for the browser app: does it boot, open a real PDF, render
// it, and produce a valid PDF back out? These intentionally stay coarse - they
// exercise the load -> render -> serialize pipeline end to end without pinning
// down pixel-level UI behaviour or any single past bug.

const fixturePath = fileURLToPath(
  new URL('../tests/fixtures/test-annotated.pdf', import.meta.url)
);

const HIDDEN_FILE_INPUT = 'input[type="file"].tabbedapp-hidden-input';

// Opening a PDF in Chromium normally goes through the File System Access
// picker, which Playwright can't drive. The shell always renders a hidden
// <input type="file"> fallback though, so we set files on it directly - that
// fires the same open path as the picker.
async function openFixture(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(fixturePath);
  await expect(page.locator('canvas').first()).toBeVisible();
}

test('boots, opens a PDF, and renders its first page', async ({ page }) => {
  await openFixture(page);

  // A rendered page canvas with real dimensions is the "it works" signal.
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);

  // Document-level controls appear only once a document is open.
  await expect(
    page.getByRole('button', { name: 'Download a copy' })
  ).toBeVisible();
});

test('download-a-copy round trips to a valid PDF with the same page count', async ({
  page
}) => {
  await openFixture(page);

  const original = await PDFDocument.load(await readFile(fixturePath));

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download a copy' }).click()
  ]);

  const bytes = await readFile(await download.path());

  // Structurally a PDF...
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1000);

  // ...and a real one the same library can reparse, preserving page count.
  const roundTripped = await PDFDocument.load(bytes);
  expect(roundTripped.getPageCount()).toBe(original.getPageCount());
});

test('a downloaded copy can be reopened in the app', async ({ page }) => {
  await openFixture(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download a copy' }).click()
  ]);
  const downloadPath = await download.path();

  // Reopen the freshly written copy through the same input; it should render.
  await page.locator(HIDDEN_FILE_INPUT).setInputFiles(downloadPath);
  await expect(page.locator('canvas').first()).toBeVisible();
});
