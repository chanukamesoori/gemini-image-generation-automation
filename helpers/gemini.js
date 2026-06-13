const config = require('../config');

async function firstVisibleLocator(page, selector, timeout = 5000) {
  const locator = page.locator(selector).first();

  try {
    await locator.waitFor({ state: 'visible', timeout });
    return locator;
  } catch {
    return null;
  }
}

async function findPromptInput(page) {
  const selectorAttempts = [
    {
      // Targets a standard text area if Gemini exposes one.
      type: 'css',
      value: 'textarea'
    },
    {
      // Targets rich text input areas such as custom editors.
      type: 'css',
      value: '[contenteditable="true"]'
    },
    {
      // Targets inputs exposed through accessibility as a textbox.
      type: 'role',
      value: 'textbox'
    },
    {
      // Targets message inputs whose placeholder mentions "message".
      type: 'css',
      value: '[placeholder*="message" i]'
    },
    {
      // Targets prompt inputs whose placeholder mentions "prompt".
      type: 'css',
      value: '[placeholder*="prompt" i]'
    },
    {
      // Targets Gemini/Chrome Quill editor instances.
      type: 'css',
      value: '.ql-editor'
    }
  ];

  for (const attempt of selectorAttempts) {
    let locator;

    if (attempt.type === 'role') {
      locator = page.getByRole(attempt.value).first();
      try {
        await locator.waitFor({ state: 'visible', timeout: 5000 });
        return locator;
      } catch {
        continue;
      }
    }

    locator = await firstVisibleLocator(page, attempt.value, 5000);
    if (locator) {
      return locator;
    }
  }

  throw new Error('Gemini prompt input was not found. Try --debug and update selectors in helpers/gemini.js.');
}

async function submitPrompt(page, promptText) {
  const input = await findPromptInput(page);

  await input.click();
  await page.keyboard.type(promptText, { delay: 40 });
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(config.AFTER_SUBMIT_WAIT_MS);
}

async function waitForGeneration(page, waitMs) {
  const startTime = Date.now();
  const spinnerSelectors = [
    // Targets loading indicators exposed with an aria-label.
    '[aria-label*="loading" i]',
    // Targets common CSS loading indicator elements.
    '.loading-indicator',
    // Targets progress bars exposed through accessibility.
    '[role="progressbar"]'
  ];

  const spinner = page.locator(spinnerSelectors.join(', ')).first();

  try {
    await spinner.waitFor({ state: 'visible', timeout: 3000 });
    const elapsedMs = Date.now() - startTime;
    const remainingMs = Math.max(waitMs - elapsedMs, 1000);
    await spinner.waitFor({ state: 'hidden', timeout: remainingMs });
  } catch {
    const elapsedMs = Date.now() - startTime;
    const remainingMs = waitMs - elapsedMs;

    if (remainingMs > 0) {
      await page.waitForTimeout(remainingMs);
    }
  }
}

async function openLatestGeneratedImage(page) {
  const imageHandles = await page.locator('img').elementHandles();
  const candidates = [];

  for (const handle of imageHandles) {
    const box = await handle.boundingBox();

    if (box && box.width > 200 && box.height > 200) {
      candidates.push(handle);
    }
  }

  const latestImage = candidates[candidates.length - 1];

  if (!latestImage) {
    return false;
  }

  await latestImage.click();
  await page.waitForTimeout(2500);
  return true;
}

async function findDownloadButton(page) {
  const attempts = [
    {
      // Targets a semantic button with accessible text such as "Download".
      type: 'role',
      value: /download/i
    },
    {
      // Targets any element whose aria-label contains "download".
      type: 'css',
      value: '[aria-label*="download" i]'
    },
    {
      // Targets any element whose title contains "download".
      type: 'css',
      value: '[title*="download" i]'
    },
    {
      // Targets a visible text-only "Download" control, often inside menus.
      type: 'text',
      value: /^download$/i
    }
  ];

  for (const attempt of attempts) {
    let locator;

    if (attempt.type === 'role') {
      locator = page.getByRole('button', { name: attempt.value }).first();
    } else if (attempt.type === 'text') {
      locator = page.getByText(attempt.value).first();
    } else {
      locator = page.locator(attempt.value).first();
    }

    try {
      await locator.waitFor({ state: 'visible', timeout: 2500 });
      return locator;
    } catch {
      // Try the next selector.
    }
  }

  return null;
}

async function openMoreMenu(page) {
  const attempts = [
    {
      // Targets a semantic "More options" button.
      type: 'role',
      value: /more options/i
    },
    {
      // Targets a semantic "More" button.
      type: 'role',
      value: /more/i
    },
    {
      // Targets icon buttons labeled as "more" through aria-label.
      type: 'css',
      value: '[aria-label*="more" i]'
    },
    {
      // Targets icon buttons labeled as "more" through title text.
      type: 'css',
      value: '[title*="more" i]'
    }
  ];

  for (const attempt of attempts) {
    const locator = attempt.type === 'role'
      ? page.getByRole('button', { name: attempt.value }).first()
      : page.locator(attempt.value).first();

    try {
      await locator.waitFor({ state: 'visible', timeout: 2500 });
      await locator.click();
      return true;
    } catch {
      // Try the next selector.
    }
  }

  return false;
}

module.exports = {
  findPromptInput,
  submitPrompt,
  waitForGeneration,
  openLatestGeneratedImage,
  findDownloadButton,
  openMoreMenu
};
