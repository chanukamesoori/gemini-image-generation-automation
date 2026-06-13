const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { findDownloadButton, openMoreMenu } = require('./gemini');

const DOWNLOAD_TIMEOUT_MS = 15000;
const NATIVE_DOWNLOAD_GRACE_MS = 8000;

async function configureChromeDownloadPath(page, outputDir) {
  await fs.mkdir(outputDir, { recursive: true });

  try {
    const session = await page.context().newCDPSession(page);

    // Chrome can complete the download even when Playwright misses the event.
    // This keeps that browser-native download inside this project's downloads folder.
    await session.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: path.resolve(outputDir),
      eventsEnabled: true
    });

    await session.detach();
  } catch (error) {
    console.warn(`Could not configure Chrome download path through CDP: ${error.message}`);
  }
}

async function listDownloadFiles(outputDir) {
  try {
    const entries = await fs.readdir(outputDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(outputDir, entry.name);
      const stat = await fs.stat(filePath);

      files.push({
        name: entry.name,
        path: filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    }

    return files;
  } catch {
    return [];
  }
}

function isTemporaryDownload(name) {
  return name.endsWith('.crdownload') || name.endsWith('.tmp') || name.endsWith('.download');
}

async function waitForFileToSettle(filePath) {
  let previousSize = -1;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const stat = await fs.stat(filePath);

    if (stat.size > 0 && stat.size === previousSize) {
      return;
    }

    previousSize = stat.size;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function moveNativeDownload(downloadedPath, outputPath) {
  if (path.resolve(downloadedPath) === path.resolve(outputPath)) {
    await waitForFileToSettle(outputPath);
    return;
  }

  await waitForFileToSettle(downloadedPath);

  if (fsSync.existsSync(outputPath)) {
    await fs.unlink(outputPath);
  }

  await fs.rename(downloadedPath, outputPath);
}

async function waitForNativeDownload(outputDir, outputPath, beforeFiles, startedAt) {
  const before = new Map(beforeFiles.map((file) => [file.name, file]));
  const timeoutAt = Date.now() + DOWNLOAD_TIMEOUT_MS + NATIVE_DOWNLOAD_GRACE_MS;

  while (Date.now() < timeoutAt) {
    const files = await listDownloadFiles(outputDir);
    const completedFiles = files
      .filter((file) => !isTemporaryDownload(file.name))
      .filter((file) => {
        const previous = before.get(file.name);
        return !previous || file.mtimeMs > startedAt || file.size !== previous.size;
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const target = completedFiles.find((file) => path.resolve(file.path) === path.resolve(outputPath));
    const candidate = target || completedFiles[0];

    if (candidate) {
      await moveNativeDownload(candidate.path, outputPath);
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

async function saveDownloadFromButton(page, button, outputDir, outputPath) {
  await configureChromeDownloadPath(page, outputDir);

  const beforeFiles = await listDownloadFiles(outputDir);
  const startedAt = Date.now();
  const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS })
    .then((download) => ({ type: 'playwright-download', download }))
    .catch((error) => ({ type: 'playwright-timeout', error }));

  const nativeDownloadPromise = waitForNativeDownload(outputDir, outputPath, beforeFiles, startedAt)
    .then((downloaded) => ({ type: 'native-download', downloaded }));

  await button.click();

  const firstResult = await Promise.race([downloadPromise, nativeDownloadPromise]);

  if (firstResult.type === 'playwright-download') {
    await firstResult.download.saveAs(outputPath);
    return 'download-button';
  }

  if (firstResult.type === 'native-download' && firstResult.downloaded) {
    return 'browser-native-download';
  }

  const nativeResult = await nativeDownloadPromise;

  if (nativeResult.downloaded) {
    return 'browser-native-download';
  }

  throw firstResult.error || new Error('Download button did not create a downloadable file.');
}

async function tryButtonDownload(page, outputDir, outputPath) {
  const button = await findDownloadButton(page);

  if (!button) {
    return null;
  }

  const method = await saveDownloadFromButton(page, button, outputDir, outputPath);
  return { success: true, method };
}

async function extractLargestImage(page) {
  return page.evaluate(async () => {
    function getVisibleImages() {
      return Array.from(document.querySelectorAll('img'))
        .map((img) => {
          const rect = img.getBoundingClientRect();

          return {
            img,
            width: rect.width,
            height: rect.height,
            area: rect.width * rect.height,
            visible: rect.width > 0 && rect.height > 0
          };
        })
        .filter((item) => item.visible && item.width > 200 && item.height > 200)
        .sort((a, b) => b.area - a.area);
    }

    const largest = getVisibleImages()[0];

    if (!largest || !largest.img.src) {
      return {
        success: false,
        error: 'No visible generated image src found.'
      };
    }

    const src = largest.img.src;
    const response = await fetch(src);

    if (!response.ok) {
      return {
        success: false,
        error: `Image fetch failed with status ${response.status}.`
      };
    }

    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
    }

    return {
      success: true,
      base64: btoa(binary),
      mimeType: blob.type || response.headers.get('content-type') || 'application/octet-stream',
      isBlob: src.startsWith('blob:')
    };
  });
}

async function triggerDownload(page, outputDir, filename) {
  const outputPath = path.join(outputDir, filename);

  try {
    const directDownload = await tryButtonDownload(page, outputDir, outputPath);

    if (directDownload) {
      return directDownload;
    }
  } catch (error) {
    console.warn(`Direct download button failed: ${error.message}`);
  }

  try {
    const openedMenu = await openMoreMenu(page);

    if (openedMenu) {
      await page.waitForTimeout(1200);
      const menuDownload = await tryButtonDownload(page, outputDir, outputPath);

      if (menuDownload) {
        return menuDownload;
      }
    }
  } catch (error) {
    console.warn(`More-menu download failed: ${error.message}`);
  }

  try {
    const imageData = await extractLargestImage(page);

    if (!imageData.success) {
      return {
        success: false,
        error: imageData.error || 'All download methods failed'
      };
    }

    const buffer = Buffer.from(imageData.base64, 'base64');
    await fs.writeFile(outputPath, buffer);

    return {
      success: true,
      method: imageData.isBlob ? 'blob-fetch' : 'src-fetch'
    };
  } catch (error) {
    return {
      success: false,
      error: `All download methods failed: ${error.message}`
    };
  }
}

module.exports = {
  triggerDownload
};
