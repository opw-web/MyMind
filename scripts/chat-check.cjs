// Chat probe: sends one real message through the app's chat pipeline and
// prints the assistant reply, proving the local model round-trip works.
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
          .evaluate(() => !!window.planner?.chat)
          .catch(() => false))
      ) {
        page = candidate;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert(page, 'planner page not found');
    const status = await page.evaluate(() => window.planner.status());
    console.log('runtime status:', JSON.stringify(status));
    const result = await page.evaluate(() =>
      window.planner.chat({
        text: 'Reply with the single word: pong',
        requestId: crypto.randomUUID(),
      }),
    );
    console.log('assistant reply:', JSON.stringify(result && result.content));
    assert(
      result && typeof result.content === 'string' && result.content.trim().length > 0,
      `empty assistant reply: ${JSON.stringify(result)}`,
    );
    console.log('chat probe: ok');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
