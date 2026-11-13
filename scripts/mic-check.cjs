// Microphone permission probe for the Tauri desktop app.
// Connects to the app over CDP (launch WebView2 with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222) and
// verifies getUserMedia resolves. With the fake audio device flags this works
// on machines without a microphone; pre-fix WebView2 denies the request with
// NotAllowedError.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const port = process.env.MYMIND_CDP_PORT || '9222';

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const page = browser.contexts()[0]?.pages()[0];
    assert(page, 'no page found in the desktop app');
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
