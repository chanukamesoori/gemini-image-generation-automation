const { chromium } = require('playwright');
const config = require('../config');

async function launchBrowser(profileDir) {
  const baseOptions = {
    headless: config.HEADLESS,
    acceptDownloads: true,
    viewport: null,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--start-maximized'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  };

  let context;

  try {
    // Uses installed Google Chrome for better Google login compatibility.
    context = await chromium.launchPersistentContext(profileDir, {
      ...baseOptions,
      channel: 'chrome'
    });
  } catch (error) {
    console.warn('Warning: Could not launch installed Google Chrome.');
    console.warn('Falling back to Playwright Chromium. Run "npx playwright install chrome" if you want Chrome.');
    console.warn(`Chrome launch error: ${error.message}`);

    // If channel: 'chrome' fails because Chrome is not installed, retry without channel.
    context = await chromium.launchPersistentContext(profileDir, baseOptions);
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  return { context, page };
}

module.exports = {
  launchBrowser
};
