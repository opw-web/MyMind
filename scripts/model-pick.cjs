// Reconfigure the runtime to an installed model, wait for ready, then chat.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const port = process.env.MYMIND_CDP_PORT || '9223';
const model = process.env.MYMIND_MODEL_PICK || 'qwen3.5:4b';

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
          .evaluate(() => !!window.planner?.configureRuntime)
          .catch(() => false))
      ) {
        page = candidate;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert(page, 'planner page not found');
    const settings = await page.evaluate(() => window.planner.runtimeSettings());
    console.log('current settings:', JSON.stringify(settings));
    await page.evaluate(pick => window.planner.configureRuntime(pick), {
      model,
      context: 32768,
    });
    console.log(`configured model: ${model}; waiting for ready...`);
    let status = null;
    const readyDeadline = Date.now() + 180_000;
    while (Date.now() < readyDeadline) {
      status = await page.evaluate(() => window.planner.status());
      if (status.state === 'ready' || status.state === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    console.log('runtime status:', JSON.stringify(status));
    assert.equal(status.state, 'ready', `runtime did not become ready: ${JSON.stringify(status)}`);
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
