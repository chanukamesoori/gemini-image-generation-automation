const fs = require('fs');
const path = require('path');
const config = require('./config');
const { launchBrowser } = require('./helpers/browser');
const { readPrompts } = require('./helpers/excel');
const {
  submitPrompt,
  waitForGeneration,
  openLatestGeneratedImage
} = require('./helpers/gemini');
const { triggerDownload } = require('./helpers/downloader');
const { initLog, saveLog } = require('./helpers/logger');

function parseArgs(argv) {
  const options = {
    force: false,
    limit: null,
    start: 1,
    debug: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--force') {
      options.force = true;
    } else if (arg === '--debug') {
      options.debug = true;
    } else if (arg === '--limit') {
      const value = Number.parseInt(argv[index + 1], 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error('--limit must be a positive number.');
      }
      options.limit = value;
      index += 1;
    } else if (arg === '--start') {
      const value = Number.parseInt(argv[index + 1], 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error('--start must be a positive 1-based row number.');
      }
      options.start = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function ensureDirectories() {
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(config.LOG_DIR, { recursive: true });
  fs.mkdirSync(config.PROFILE_DIR, { recursive: true });
}

function filterRows(rows, options) {
  let filtered = rows.slice(options.start - 1);

  if (options.limit !== null) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

async function runDebugSnapshot(page) {
  console.log('DEBUG: visible button texts:');
  console.log(await page.locator('button').allTextContents());
  console.log('DEBUG: image count:', await page.locator('img').count());
  console.log('DEBUG: Pausing 10 seconds for manual inspection...');
  await page.waitForTimeout(10000);
}

function logResult(entry) {
  saveLog(config.LOG_DIR, {
    ...entry,
    timestamp: new Date().toISOString()
  });
}

async function processPrompt(page, item, position, total, options) {
  const outputPath = path.join(config.OUTPUT_DIR, item.filename);

  if (fs.existsSync(outputPath) && !options.force) {
    console.log(`Skipped ${position}/${total}: ${item.filename} already exists`);
    logResult({
      row: item.row,
      prompt: item.prompt,
      filename: item.filename,
      status: 'skipped',
      error: '',
      method: 'existing-file'
    });
    return 'skipped';
  }

  let lastError = '';

  for (let attempt = 1; attempt <= config.MAX_RETRIES; attempt += 1) {
    try {
      console.log(`Processing ${position}/${total}: ${item.filename} (attempt ${attempt}/${config.MAX_RETRIES})`);

      await page.goto(config.GEMINI_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      await page.waitForTimeout(4000);

      await submitPrompt(page, config.PROMPT_PREFIX + item.prompt);
      console.log(`Submitted prompt ${position}/${total}: ${item.filename}`);

      await waitForGeneration(page, config.GENERATION_WAIT_MS);
      console.log('Generation wait complete. Attempting to open image...');

      if (options.debug) {
        await runDebugSnapshot(page);
      }

      const openedImage = await openLatestGeneratedImage(page);

      if (!openedImage) {
        throw new Error('Generated image was not found on the page.');
      }

      await page.waitForTimeout(25000);
      const downloadResult = await triggerDownload(page, config.OUTPUT_DIR, item.filename);

      if (!downloadResult.success) {
        throw new Error(downloadResult.error || 'Download failed.');
      }

      console.log(`Saved ${item.filename} using ${downloadResult.method}`);
      logResult({
        row: item.row,
        prompt: item.prompt,
        filename: item.filename,
        status: 'success',
        error: '',
        method: downloadResult.method
      });

      return 'success';
    } catch (error) {
      lastError = error.message;
      console.warn(`Attempt ${attempt} failed for ${item.filename}: ${lastError}`);

      if (attempt < config.MAX_RETRIES) {
        await page.waitForTimeout(3000);
      }
    }
  }

  logResult({
    row: item.row,
    prompt: item.prompt,
    filename: item.filename,
    status: 'failed',
    error: lastError,
    method: ''
  });

  return 'failed';
}

async function main() {
  const options = parseArgs(process.argv);
  ensureDirectories();
  initLog(config.LOG_DIR);

  const prompts = filterRows(readPrompts(config.EXCEL_FILE), options);

  if (prompts.length === 0) {
    console.log('No prompts found to process.');
    return;
  }

  const summary = {
    total: prompts.length,
    success: 0,
    failed: 0,
    skipped: 0
  };

  const { context, page } = await launchBrowser(config.PROFILE_DIR);
  let browserClosed = false;

  context.on('close', () => {
    browserClosed = true;
    console.error('Browser was closed or disconnected.');
  });

  await page.goto(config.GEMINI_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('============================================');
  console.log('Starting automatically with the saved Chrome profile.');
  console.log('Make sure Gemini is already logged in for this profile.');
  console.log('============================================');

  for (let index = 0; index < prompts.length; index += 1) {
    const item = prompts[index];

    if (browserClosed) {
      console.error('Stopping because the browser is no longer available.');
      break;
    }

    try {
      const status = await processPrompt(page, item, index + 1, prompts.length, options);
      summary[status] += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`Unexpected failure for ${item.filename}: ${error.message}`);
      logResult({
        row: item.row,
        prompt: item.prompt,
        filename: item.filename,
        status: 'failed',
        error: error.message,
        method: ''
      });
    } finally {
      try {
        await page.keyboard.press('Escape');
      } catch {
        // Browser may have been closed by the user.
      }

      if (!browserClosed) {
        try {
          await page.waitForTimeout(config.BETWEEN_PROMPTS_WAIT_MS);
        } catch {
          browserClosed = true;
        }
      }
    }
  }

  console.log('============================================');
  console.log(`Total: ${summary.total}`);
  console.log(`Success: ${summary.success}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log('Log saved to logs/results.csv');
  console.log('Browser left open for review. Close it manually when done.');
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exitCode = 1;
});
