const assert = require('node:assert/strict');
const {createHash, randomUUID} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DatabaseSync} = require('node:sqlite');
const {_electron: electron} = require('playwright');

const repo = path.resolve(__dirname, '..');
const oldVersion = '2.4.0';
const newVersion = '2.5.0';
const date = '2026-11-18';
const tables = ['projects', 'sections', 'categories', 'tasks', 'events'];

// A synthetic 40 ms WebM/Opus silence clip, split into two recording chunks below.
const audio = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAHXEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTDZ1OsggE8TbuMU6uEHFO7a1OsggHB7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBNgIRMYXZmV0GETGF2ZkSJiEBIAAAAAAAAFlSua/GuAQAAAAAAAGjXgQFzxYgAAAAAAAAAAZyBACK1nIN1bmSIgQCGhkFfT1BVU1aqg2MuoFa7hATEtACDgQIj44OEATEtAOGRn4EBtYhA53AAAAAAAGJkgRBV7oEAY6KTT3B1c0hlYWQBATgBgLsAAAAAABJUw2fRc3POY8CLY8WIAAAAAAAAAAFnyJlFo4dFTkNPREVSRIeMTGF2YyBsaWJvcHVzZ8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMC4wNDgwMDAwMDAAH0O2darngQCjh4EAAID4//6jh4EAFYD4//6gk6GHgQApAPj//puBB3WihADN/mAcU7trkbuPs4EAt4r3gQHxggGS8IED',
  'base64'
);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function seedPlanner(db) {
  const details = {
    title: 'Prototype inspection', notes: 'Inspect the left edge before sign-off.',
    textBox: 'Measure the opening\nPhotograph the latch', categoryId: 'workshop'
  };
  db.mutate({
    label: 'Create upgrade fixture', requestId: 'migration-seed', expectedRevision: 0,
    changes: [
      {action: 'create', entity: 'project', id: 'prototype', fields: {title: 'Prototype'}},
      {action: 'create', entity: 'section', id: 'inspection', fields: {title: 'Inspection', projectId: 'prototype'}},
      {action: 'create', entity: 'category', id: 'workshop', fields: {title: 'Workshop', color: 'lavender'}},
      {action: 'create', entity: 'task', id: 'setup', fields: {title: 'Prepare the bench', completed: true, categoryId: 'workshop'}},
      {action: 'create', entity: 'task', id: 'inspect', fields: {
        ...details, projectId: 'prototype', sectionId: 'inspection', dueDate: date,
        dependsOnIds: ['setup'], steps: [
          {id: 'measure', title: 'Measure the opening', completed: true},
          {id: 'photo', title: 'Photograph the latch', completed: false}
        ]
      }},
      {action: 'create', entity: 'event', id: 'inspect-session', fields: {
        ...details, linkedTaskId: 'inspect', startDate: date, startTime: '09:30', endTime: '10:15'
      }}
    ]
  });
  const lastMutation = {
    label: 'Update inspection notes', requestId: 'migration-notes', expectedRevision: 1,
    changes: [{action: 'update', entity: 'task', id: 'inspect', fields: {notes: 'Use the revised latch drawing.'}}]
  };
  const receipt = db.mutate(lastMutation);
  db.preferences({timezone: 'Europe/Berlin', dayWidth: 148, year: 2026,
    chatOpen: true, chatWidth: 410, taskLayout: 'flow', voiceAutoSend: false, spokenReplies: false});
  const snapshot = db.snapshot();
  assert.equal(snapshot.tasks.find(task => task.id === 'inspect').scheduledDate, date);
  assert.equal(snapshot.events.find(event => event.id === 'inspect-session').linkedTaskId, 'inspect');
  assert.ok(snapshot.tasks.find(task => task.id === 'setup').completedAt);
  return {lastMutation, receipt, snapshot};
}

function seedDictation(DictationDrafts, filename) {
  const db = new DictationDrafts(filename);
  try {
    const generation = randomUUID();
    const {id: draftId} = db.create({generation, prefix: 'Inspection reminder.'});
    const midpoint = Math.floor(audio.length / 2);
    for (const [sequence, bytes] of [audio.subarray(0, midpoint), audio.subarray(midpoint)].entries()) {
      db.append({draftId, generation, sequence, audio: Uint8Array.from(bytes).buffer, seconds: 0.04});
    }
    db.checkpoint({draftId, generation, liveText: 'Check the latch.', reviewText: 'Inspection reminder. Check the revised latch.'});
    assert.deepEqual(Buffer.from(db.audio(draftId, generation)), audio);
    return db.get(draftId);
  } finally {
    db.close();
  }
}

function readDatabase(filename, inspect) {
  const db = new DatabaseSync(filename, {readOnly: true});
  try {
    return inspect(db);
  } finally {
    db.close();
  }
}

function readPlanner(filename) {
  return readDatabase(filename, db => {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
        .map(row => ({...row, body: JSON.parse(row.body)}))])),
      meta: db.prepare('SELECT * FROM meta ORDER BY key').all(),
      history: db.prepare('SELECT * FROM history ORDER BY id').all()
        .map(row => ({...row, before_state: JSON.parse(row.before_state)})),
      requests: db.prepare('SELECT * FROM requests ORDER BY id').all()
    };
  });
}

function addV9Fields(state) {
  return {
    ...state,
    events: state.events.map(event => ({...event, kind: 'planned', linkedStepId: null})),
    categories: state.categories.map(category => ({...category, semanticKey: 'workshop', aliases: ['workshop']}))
  };
}

async function run(oldRoot, executable) {
  assert.equal(require(path.join(oldRoot, 'package.json')).version, oldVersion);
  const development = executable === '--development';
  const executablePath = development ? require('electron') : fs.realpathSync(executable);
  const {PlannerDatabase} = require(path.join(oldRoot, 'dist/main/database.js'));
  const {DictationDrafts} = require(path.join(oldRoot, 'dist/main/dictation-drafts.js'));
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-msi-migration-'));
  const dataDir = path.join(evidenceDir, 'data');
  const plannerFile = path.join(dataDir, 'planner.sqlite');
  const dictationFile = path.join(dataDir, 'dictation.sqlite');
  const backupFile = `${plannerFile}.v8-backup`;
  const report = {oldVersion, expectedNewVersion: development ? require('../package.json').version : newVersion,
    executable: executablePath, development, dataDir, checks: [], pageErrors: []};
  const passed = check => {
    report.checks.push(check);
    console.log(`PASS ${check}`);
  };
  let legacy;
  let app;
  try {
    legacy = new PlannerDatabase(plannerFile);
    const {lastMutation, receipt, snapshot} = seedPlanner(legacy);
    // Keep the writer open so the packaged app has to migrate committed WAL frames.
    assert.ok(fs.statSync(`${plannerFile}-wal`).size > 32, 'Expected committed changes in the v8 WAL');
    const before = readPlanner(plannerFile);
    assert.equal(before.version, 8);
    assert.equal(before.history.length, 2);
    assert.equal(before.requests.length, 2);
    assert.equal(fs.existsSync(backupFile), false);
    const draft = seedDictation(DictationDrafts, dictationFile);
    const dictationHash = sha256(fs.readFileSync(dictationFile));
    passed('Seeded planner v8 history and receipts, preferences, and a text and audio dictation');

    const env = {...process.env, MYMIND_DATA_DIR: dataDir, MYMIND_SKIP_OLLAMA: '1', MYMIND_TEST_MODE: '1'};
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({executablePath, args: development ? [repo] : [], env, timeout: 30_000});
    const page = await app.firstWindow({timeout: 30_000});
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.getByTestId('calendar').waitFor({timeout: 30_000});
    const appInfo = await app.evaluate(({app}) => ({
      version: app.getVersion(), packaged: app.isPackaged, userData: app.getPath('userData')
    }));
    assert.equal(appInfo.version, report.expectedNewVersion);
    assert.equal(appInfo.packaged, !development);
    assert.equal(fs.realpathSync(appInfo.userData), fs.realpathSync(dataDir));
    report.app = appInfo;

    const current = await page.evaluate(() => window.planner.snapshot());
    assert.deepEqual(current, addV9Fields({...snapshot, preferences: {...snapshot.preferences, appearance: 'light'}}));
    const session = page.locator('[data-event-id="inspect-session"][data-entry-type="session"][data-linked-task="inspect"]');
    const deadline = page.locator('[data-event-id="deadline:inspect"][data-entry-type="deadline"][data-linked-task="inspect"]');
    for (const entry of [session, deadline]) {
      await entry.first().waitFor({state: 'attached', timeout: 10_000});
      assert.equal(await entry.first().getAttribute('data-start-date'), date);
    }
    passed('Bloom opened the isolated planner with the same saved content and separate session and deadline cards');

    assert.deepEqual(await page.evaluate(() => window.planner.listDictations()), [draft]);
    assert.deepEqual(await page.evaluate(id => window.planner.getDictation(id), draft.id), draft);
    assert.deepEqual(await page.evaluate(input => window.planner.mutate(input), lastMutation), receipt);
    assert.deepEqual(await page.evaluate(() => window.planner.snapshot()), current);
    passed('Recoverable dictation is available and retrying a v8 request returns its saved receipt');

    await app.close();
    app = undefined;
    legacy.close();
    legacy = undefined;
    const after = readPlanner(plannerFile);
    const expected = {
      ...before,
      version: 9,
      rows: {
        ...before.rows,
        events: before.rows.events.map(row => ({...row, body: {...row.body, kind: 'planned', linkedStepId: null}})),
        categories: before.rows.categories.map(row => ({...row, body: {...row.body, semanticKey: 'workshop', aliases: ['workshop']}}))
      },
      history: before.history.map(row => ({...row, before_state: addV9Fields(row.before_state)}))
    };
    assert.deepEqual(after, expected);
    assert.deepEqual(readPlanner(backupFile), before);
    report.schema = {before: before.version, after: after.version, backup: backupFile,
      plannerRows: Object.fromEntries(tables.map(table => [table, after.rows[table].length])),
      historyRows: after.history.length, requestRows: after.requests.length};
    passed('Persisted records, history and receipts match v8 apart from v9 metadata, and the v8 backup includes all WAL data');

    assert.equal(sha256(fs.readFileSync(dictationFile)), dictationHash);
    const restoredAudio = readDatabase(dictationFile, db => Buffer.concat(
      db.prepare('SELECT audio FROM chunks WHERE draft_id=? ORDER BY sequence').all(draft.id).map(row => Buffer.from(row.audio))
    ));
    assert.deepEqual(restoredAudio, audio);
    report.dictation = {fileSha256: dictationHash, audioSha256: sha256(restoredAudio), bytes: restoredAudio.length};
    assert.deepEqual(report.pageErrors, []);
    passed('Dictation database fingerprint and ordered audio bytes are unchanged');
  } catch (error) {
    report.error = error.stack ?? String(error);
    throw error;
  } finally {
    try {
      await app?.close();
    } finally {
      legacy?.close();
      const reportPath = path.join(evidenceDir, 'results.json');
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
      console.log(`Evidence: ${reportPath}`);
    }
  }
}

const [oldRoot, executable] = process.argv.slice(2);
if (!oldRoot || !executable || process.argv.length !== 4) {
  console.error('Usage: node tests/bloom-msi-migration.cjs "<v2.4.0 resources/app>" "<extracted v2.5.0 MYMIND.exe|--development>"');
  process.exitCode = 1;
} else {
  run(path.resolve(oldRoot), executable).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
