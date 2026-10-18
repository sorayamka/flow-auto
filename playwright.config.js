const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  timeout: 15000,
  use: {
    viewport: { width: 400, height: 1000 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  },
});
