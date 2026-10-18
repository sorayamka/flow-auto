const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const panelUrl = pathToFileURL(path.resolve(__dirname, '../sidepanel/panel.html')).href;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    const image =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#dedbc8"/></svg>',
      );
    window.testState = {
      phase: 'idle',
      username: 'studio',
      scrapedAt: 1,
      posts: [{ imageUrls: [image] }],
      queue: [],
      logs: [],
      linkQueue: [],
      upLinks: [],
      upQueue: [],
    };
    window.sentMessages = [];
    window.chrome = {
      runtime: {
        getManifest: () => ({ version: '0.1.10' }),
        onMessage: {
          addListener: (listener) => {
            window.receiveMessage = listener;
          },
        },
        sendMessage: async (message) => {
          window.sentMessages.push(message);
          if (message.type === 'GET_STATE') return { state: window.testState };
          if (message.type === 'GET_HISTORY') return { history: [] };
          return {};
        },
      },
    };
  });
  await page.goto(panelUrl);
});

test('empty sources hide restored photos and clearing sources resets selection', async ({
  page,
}) => {
  await expect(page.locator('#pickingSec')).toBeHidden();
  await page.locator('#link').fill('https://www.threads.com/@studio');
  await expect(page.locator('#pickingSec')).toBeVisible();
  await page.locator('.thumb').click();
  await expect(page.locator('#startBtn')).toBeEnabled();
  await page.locator('#link').fill('');
  await expect(page.locator('#pickingSec')).toBeHidden();
  await expect(page.locator('#startBtn')).toBeDisabled();
  await expect(page.locator('.thumb.sel')).toHaveCount(0);
});

test('paused jobs cannot be restarted by selecting photos or editing queue', async ({ page }) => {
  await page.evaluate(() =>
    window.receiveMessage({
      type: 'STATE',
      state: {
        ...window.testState,
        phase: 'paused',
      },
    }),
  );
  await expect(page.locator('#pickingSec')).toBeVisible();
  await page.locator('.thumb').click();
  await page.locator('#prompt').fill('studio portrait');
  await page.locator('#linkList').fill('https://www.threads.com/@studio');
  await expect(page.locator('#startBtn')).toBeDisabled();
  await expect(page.locator('#queueBtn')).toBeDisabled();
  await expect(page.locator('#resumeBtn')).toBeEnabled();
});

test('scraping rebuilds gallery even when background returns the same snapshot', async ({
  page,
}) => {
  await page.locator('#link').fill('https://www.threads.com/@studio');
  await page.locator('#grabBtn').click();
  await expect(page.locator('#gallery .thumb')).toHaveCount(1);
});

test('upload progress uses link counters when individual jobs are unavailable', async ({
  page,
}) => {
  await page.evaluate(() =>
    window.receiveMessage({
      type: 'STATE',
      state: {
        ...window.testState,
        upLinks: [{ url: 'https://www.threads.com/@studio', total: 8, done: 3, status: 'done' }],
      },
    }),
  );
  await page.locator('[data-tab="upload"]').click();
  await expect(page.locator('#upStat')).toContainText('3/8');
  await expect(page.locator('#upPbar')).toHaveAttribute('style', 'width: 38%;');
});

test('runtime disconnection is reported, including synchronous API errors', async ({ page }) => {
  await page.evaluate(() => {
    window.chrome.runtime.sendMessage = () => {
      throw new Error('Context invalidated');
    };
  });
  await page.locator('#diagBtn').click();
  await expect(page.locator('.toast.err')).toContainText('Context invalidated');
});

for (const width of [320, 400, 600]) {
  test(`tabs fit at ${width}px without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const [tab, pane] of [
      ['work', 'tabWork'],
      ['upload', 'tabUpload'],
      ['history', 'tabHistory'],
    ]) {
      await page.locator(`[data-tab="${tab}"]`).click();
      await expect(page.locator(`#${pane}`)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  });
}
