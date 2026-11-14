// Speech pipeline probe: starts dictation and waits for the worker to load
// Whisper, proving the model path fix end-to-end.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const port = process.env.MYMIND_CDP_PORT || '9223';

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    let page;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const pages = browser.contexts().flatMap(context => context.pages());
      const candidate =
        pages.find(item => item.url().includes('tauri.localhost')) ?? pages[0];
      if (
        candidate &&
        (await candidate
          .evaluate(() => !!window.planner?.startSpeech)
          .catch(() => false))
      ) {
        page = candidate;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert(page, 'planner page not found');
    await page.evaluate(() => window.planner.startSpeech());
    let status = null;
    const readyDeadline = Date.now() + 90_000;
    while (Date.now() < readyDeadline) {
      status = await page.evaluate(() => window.planner.speechStatus());
      if (status.state === 'ready') break;
      if (status.state === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log('speech status:', JSON.stringify(status));
    assert.equal(status.state, 'ready', `speech worker did not become ready: ${JSON.stringify(status)}`);
    console.log('speech probe: ready');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
