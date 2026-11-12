const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, realpathSync, rmSync } = require('node:fs');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const executable = realpathSync(process.argv[2]);
const profile = mkdtempSync(join(tmpdir(), 'mymind-tauri-test-'));
const prompt = 'Remove the apply for community garden plan task and all its associated calendar event just delete them and do the same with the library meeting task remove the calendar events for that as well just delete';

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const number = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return number;
}

async function ready(check, message) {
  for (let i = 0; i < 150; i++) {
    if (await check().catch(() => false)) return;
    await delay(200);
  }
  throw new Error(message);
}

async function run() {
  const [browserPort, nativePort] = await Promise.all([port(), port()]);
  const driver = spawn(process.env.MYMIND_TAURI_DRIVER || 'tauri-driver', [
    '--port', String(browserPort), '--native-port', String(nativePort),
    ...(process.env.MYMIND_NATIVE_DRIVER ? ['--native-driver', process.env.MYMIND_NATIVE_DRIVER] : []),
  ], {
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env, MYMIND_DATA_DIR: profile, MYMIND_SKIP_OLLAMA: '1', MYMIND_TEST_MODE: '1' },
  });
  let spawnError;
  driver.once('error', error => { spawnError = error; });
  let session;
  async function command(method, route, data) {
    if (spawnError) throw spawnError;
    const response = await fetch('http://127.0.0.1:' + browserPort + route, {
      method,
      ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(35_000),
    });
    const { value } = await response.json();
    if (!response.ok || value?.error) throw new Error(value?.message || ('WebDriver failed: ' + response.status));
    return value;
  }
  async function evalInApp(fn, ...args) {
    const result = await command('POST', '/session/' + session + '/execute/async', {
      args,
      script: 'const done = arguments[arguments.length-1]; (' + fn.toString() + ')(...Array.from(arguments).slice(0,-1)).then(value=>done({value}),error=>done({error:String(error)}));',
    });
    if (result.error) throw new Error(result.error);
    return result.value;
  }
  try {
    await ready(() => command('GET', '/status').then(status => status.ready), 'Tauri WebDriver did not become ready.');
    const opened = await command('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: executable } } } });
    session = opened.sessionId;
    await ready(() => evalInApp(async () => Boolean(window.planner && document.querySelector('[data-testid=calendar]'))), 'The native planner did not render the calendar.');
    const result = await evalInApp(async promptText => {
      const api = window.planner;
      const task = (id, title) => ({ action: 'create', entity: 'task', id, fields: { title } });
      const event = (id, title, linkedTaskId) => ({
        action: 'create', entity: 'event', id, fields: {
          title, startDate: '2026-11-12', ...(linkedTaskId ? { linkedTaskId } : {}),
        },
      });
      const initial = await api.snapshot();
      if (initial.tasks.length || initial.events.length) throw new Error('Fixture profile must be empty.');
      await api.mutate({ requestId: crypto.randomUUID(), expectedRevision: initial.revision, label: 'Fixture', changes: [
        task('application', 'Apply for Community Garden Plan'), task('hall', 'Library fundraiser'), task('retain', 'Retained task'),
        event('app-1', 'Application draft', 'application'), event('app-2', 'Application review', 'application'),
        event('hall-1', 'Hall session', 'hall'), event('hall-2', 'Prepare agenda', 'hall'), event('standalone', 'Library fundraiser'),
      ] });
      const before = await api.snapshot();
      const response = await api.chat({ requestId: crypto.randomUUID(), text: promptText });
      if (!response.preview) throw new Error(response.content);
      const preview = response.preview.draft;
      const beforeApply = await api.snapshot();
      await api.applyDraft({ draftId: preview.id, version: preview.version, expectedRevision: preview.baseRevision, requestId: crypto.randomUUID() });
      const after = await api.snapshot();
      await api.undo(after.revision);
      const restored = await api.snapshot();

      const generation = crypto.randomUUID();
      const recording = await api.createDictation({ generation, prefix: 'Typed prefix' });
      const audio = new Uint8Array([1, 2, 3, 4]).buffer;
      await api.appendDictation({ draftId: recording.id, generation, sequence: 0, seconds: 1, audio });
      await api.checkpointDictation({ draftId: recording.id, generation, reviewText: 'Review this draft' });
      const recovered = await api.getDictation(recording.id);
      return {
        before, beforeApply, after, restored, recovered, proposed: preview.changes,
        context: (await api.status()).context,
      };
    }, prompt);
    assert.equal(result.context, 32768);
    assert.deepEqual(result.beforeApply, result.before);
    assert.deepEqual(result.proposed.map(c => c.action + ':' + c.id).sort(),
      ['delete:app-1', 'delete:app-2', 'delete:application', 'delete:hall', 'delete:hall-1', 'delete:hall-2'].sort());
    assert.deepEqual(result.after.tasks.map(task => task.id), ['retain']);
    assert.deepEqual(result.after.events.map(event => event.id), ['standalone']);
    assert.deepEqual(result.restored.tasks, result.before.tasks);
    assert.deepEqual(result.restored.events, result.before.events);
    assert.equal(result.recovered.bytes, 4);
    assert.equal(result.recovered.reviewText, 'Review this draft');
    console.log('Tauri desktop passed calendar startup, verbatim preview, Apply, Undo, and binary dictation recovery.');
  } finally {
    if (session) await command('DELETE', '/session/' + session).catch(() => {});
    driver.kill();
    await delay(200);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
