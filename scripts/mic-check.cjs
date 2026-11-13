// Microphone permission probe for the Tauri desktop app.
// Connects to the app over CDP (launch it with
// MYMIND_BROWSER_ARGS=--remote-debugging-port=9222 ...) and verifies
// getUserMedia resolves in the real planner page. With the fake audio device
// flags this works on machines without a microphone; pre-fix WebView2 denies
// the request with NotAllowedError.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const port = process.env.MYMIND_CDP_PORT || '9222';

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
          .evaluate(() => !!navigator.mediaDevices?.getUserMedia)
          .catch(() => false))
      ) {
        page = candidate;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert(page, 'no planner page with media devices found');
    const result = await page.evaluate(() =>
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(stream => {
          stream.getTracks().forEach(track => track.stop());
          return 'granted';
        })
        .catch(error => `denied:${error.name}`),
    );
    assert.equal(result, 'granted', `microphone probe: ${result}`);
    console.log('microphone probe: granted');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
