// Manual Bloom interaction coverage against Electron IPC and real local storage.
const {_electron: electron} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = process.env.MYMIND_BLOOM_EVIDENCE;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mymind-bloom-manual-'));
const env = {...process.env, MYMIND_DATA_DIR: dataDir, MYMIND_TEST_MODE: '1', MYMIND_SKIP_OLLAMA: '1'};
delete env.ELECTRON_RUN_AS_NODE;

let app;
let page;
const errors = [];
const button = (name, within = page) => within.getByRole('button', {name, exact: true});
const dialog = name => page.getByRole('dialog', {name, exact: true});
const snapshot = () => page.evaluate(() => window.planner.snapshot());
const taskRow = title => page.locator('[data-task-id]').filter({has: button(title)});
const timed = (date, title) => page.locator(`.time-column[data-date="${date}"] .event-block`, {hasText: title});
const allDay = (date, title) => page.locator(`.all-day-cell[data-date="${date}"] .all-day-chip`, {hasText: title});
const dateOffset = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

async function size(width, height) {
  await app.evaluate(({BrowserWindow}, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
}

async function check(name, action) {
  await action();
  console.log(`PASS ${name}`);
}

async function seed(changes) {
  await page.evaluate(async changes => {
    const {revision} = await window.planner.snapshot();
    await window.planner.mutate({changes, expectedRevision: revision, label: 'Test fixtures', requestId: crypto.randomUUID()});
  }, changes);
}

async function submit(name, modal) {
  await button(name, modal).click();
  await modal.waitFor({state: 'hidden'});
}

async function scrollGrid(top) {
  await page.getByTestId('calendar-scroller').evaluate((element, y) => {element.scrollTop = y;}, top);
}

async function leadingDate(date) {
  await page.waitForFunction(date => {
    const gutter = document.querySelector('.corner-label').getBoundingClientRect();
    const days = [...document.querySelectorAll('.day-header')];
    return days.some(day => day.dataset.date === date && Math.abs(day.getBoundingClientRect().left - gutter.right) <= 2);
  }, date);
}

async function screenshot(name) {
  if (!output) return;
  fs.mkdirSync(output, {recursive: true});
  await page.screenshot({path: path.join(output, name + '.png')});
}

(async () => {
  try {
    app = await electron.launch({
      executablePath: process.env.MYMIND_TEST_EXECUTABLE || require('electron'),
      args: ['--force-device-scale-factor=1', ...(process.env.MYMIND_TEST_EXECUTABLE ? [] : [root])],
      env,
    });
    page = await app.firstWindow();
    await app.evaluate(({BrowserWindow}) => {
      const window = BrowserWindow.getAllWindows()[0];
      const keepFrames = setInterval(() => {
        if (!window.isDestroyed()) void window.webContents.capturePage(undefined, {stayHidden: true, stayAwake: true}).catch(() => {});
      }, 150);
      keepFrames.unref();
    });
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    await size(1280, 800);
    await page.getByTestId('calendar-scroller').waitFor();
    const today = await page.evaluate(async () => {
      const {preferences} = await window.planner.snapshot();
      return new Intl.DateTimeFormat('en-CA', {timeZone: preferences.timezone}).format(new Date());
    });
    const categoryId = (await snapshot()).categories[0].id;
    const projectId = 'manual-project';
    const overnightId = 'manual-overnight';
    await seed([
      {action: 'create', entity: 'project', id: projectId, fields: {title: 'Portfolio Refresh'}},
      {action: 'create', entity: 'event', fields: {title: 'Retrospective notes', kind: 'actual', startDate: today, startTime: '10:00', endTime: '11:00', categoryId}},
      {action: 'create', entity: 'event', fields: {title: 'Team sync', startDate: today, startTime: '10:30', endTime: '12:00'}},
      {action: 'create', entity: 'event', id: overnightId, fields: {title: 'Legacy overnight', kind: 'actual', textBox: 'Historical context',
        startDate: today, endDate: dateOffset(today, 1), startTime: '22:00', endTime: '01:00'}},
    ]);

    await check('Calendar leads with today and continuous days keep the two-tab shell', async () => {
      const navigation = page.getByRole('navigation', {name: 'Main navigation'});
      assert.equal(await navigation.getByRole('button').count(), 2);
      assert.equal(await button('Calendar', navigation).getAttribute('aria-current'), 'page');
      await leadingDate(today);
      await button('Next seven days').click();
      await leadingDate(dateOffset(today, 7));
      await button('Today').click();
      await leadingDate(today);
      await button('Previous seven days').click();
      await leadingDate(dateOffset(today, -7));
      await scrollGrid(8 * 66);
      await button('Tasks', navigation).click();
      await page.getByRole('heading', {name: 'My tasks'}).waitFor();
      await button('Calendar', navigation).click();
      await leadingDate(dateOffset(today, -7));
      assert.equal(await page.getByTestId('calendar-scroller').evaluate(element => element.scrollTop), 8 * 66);
      await button('Today').click();
      await leadingDate(today);
      const panel = page.getByTestId('calendar-scroller');
      const dayWidth = await page.locator('.day-header.is-today').evaluate(element => element.getBoundingClientRect().width);
      await panel.hover({position: {x: 120, y: 220}});
      await page.mouse.wheel(dayWidth * 2, 0);
      await leadingDate(dateOffset(today, 2));
      await button('Today').click();
      await leadingDate(today);
      await scrollGrid(7 * 66);
      assert.equal(await page.getByRole('button', {name: 'Actual', exact: true}).count(), 0);
      await screenshot('calendar');
    });

    await check('Clicking a half-hour slot opens a one-hour editor and validates the range', async () => {
      await scrollGrid(7 * 66);
      const column = page.locator(`.time-column[data-date="${today}"]`);
      const {x, y} = await column.evaluate(element => {
        const box = element.getBoundingClientRect();
        return {x: box.left + 20, y: box.top + 9.5 * 66 + 6};
      });
      await page.mouse.click(x, y);
      const modal = dialog('New calendar block');
      assert.equal(await modal.getByLabel('Start time').inputValue(), '09:30');
      assert.equal(await modal.getByLabel('End time').inputValue(), '10:30');
      await modal.getByLabel('Title').fill('Manual focus block');
      await modal.getByLabel('End time').fill('09:00');
      await button('Add block', modal).click();
      assert.equal(await modal.getByRole('alert').innerText(), 'End time must be after start time');
      await modal.getByLabel('End time').fill('10:30');
      await submit('Add block', modal);
      await timed(today, 'Manual focus block').waitFor();
    });

    await check('Dragging across empty slots and clicking the all-day lane prefill the editor', async () => {
      await scrollGrid(7 * 66);
      const column = page.locator(`.time-column[data-date="${today}"]`);
      const points = await column.evaluate(element => {
        const box = element.getBoundingClientRect();
        return {x: box.left + 20, first: box.top + 8 * 66 + 6, last: box.top + 9 * 66 + 6};
      });
      await page.mouse.move(points.x, points.first);
      await page.mouse.down();
      await page.mouse.move(points.x, points.last, {steps: 5});
      await page.mouse.up();
      const modal = dialog('New calendar block');
      assert.equal(await modal.getByLabel('Start time').inputValue(), '08:00');
      assert.equal(await modal.getByLabel('End time').inputValue(), '09:30');
      await page.keyboard.press('Escape');
      await modal.waitFor({state: 'hidden'});
      await page.locator(`.all-day-cell[data-date="${today}"]`).click({position: {x: 10, y: 10}});
      assert.ok(await modal.getByLabel('All-day block').isChecked());
      assert.equal(await modal.getByLabel('Start time').count(), 0);
      await modal.getByLabel('Title').fill('All-day workshop');
      await submit('Add block', modal);
      await allDay(today, 'All-day workshop').waitFor();
      await allDay(today, 'All-day workshop').click();
      await submit('Delete', dialog('Edit calendar block'));
      await allDay(today, 'All-day workshop').waitFor({state: 'detached'});
    });

    await check('Categories filter, restore, add and rename within the single calendar', async () => {
      const first = (await snapshot()).categories.find(category => category.id === categoryId);
      const categories = page.getByRole('button', {name: /^Categories/});
      await categories.click();
      await page.getByRole('checkbox', {name: 'Show ' + first.title, exact: true}).uncheck();
      await timed(today, 'Retrospective notes').waitFor({state: 'detached'});
      await timed(today, 'Team sync').waitFor();
      await button('Show all').click();
      await timed(today, 'Retrospective notes').waitFor();
      await page.getByRole('textbox', {name: 'New category name'}).fill('Client work');
      await page.getByRole('textbox', {name: 'New category name'}).press('Enter');
      await button('Rename category: Client work').click();
      await page.getByRole('textbox', {name: 'Category name', exact: true}).fill('Client projects');
      await button('Save name').click();
      await page.getByRole('checkbox', {name: 'Show Client projects', exact: true}).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await categories.getAttribute('aria-expanded'), 'false');
    });

    let taskId;
    await check('Project, task metadata, and checklist edits share existing task persistence', async () => {
      await button('Tasks').click();
      await button('New project').click();
      const project = dialog('New project');
      await project.getByLabel('Project name').fill('Weekly planning');
      await submit('Create project', project);
      await button('Add task to Portfolio Refresh').click();
      const task = dialog('Create a task');
      await task.getByLabel('Task name').fill('Write proposal');
      assert.equal(await task.getByLabel('Project', {exact: true}).inputValue(), projectId);
      await task.getByLabel('Due date').fill(today);
      await task.getByLabel('Priority').selectOption('High');
      await task.getByLabel('Estimate').fill('1h 30m');
      await button('Add checklist step', task).click();
      await task.getByRole('textbox', {name: 'Step 1', exact: true}).fill('Write outline');
      await submit('Add task', task);
      const stored = (await snapshot()).tasks.find(task => task.title === 'Write proposal');
      taskId = stored.id;
      assert.equal(stored.priority, 'High');
      assert.equal(stored.estimate, '1h 30m');
      assert.equal(stored.steps.length, 1);
      await taskRow('Write proposal').getByRole('button', {name: 'Show checklist steps'}).click();
      await taskRow('Write proposal').getByRole('checkbox', {name: 'Mark Write outline'}).click();
      await page.waitForFunction(id => window.planner.snapshot().then(s => s.tasks.find(t => t.id === id).steps[0].completed), taskId);
      assert.equal((await snapshot()).tasks.find(t => t.id === taskId).completed, false);
      await button('Scheduled').click();
      await taskRow('Write proposal').waitFor({state: 'detached'});
      await button('Unscheduled').click();
      await taskRow('Write proposal').waitFor();
    });

    await check('Scheduling twice links two sessions and renaming the task updates both labels', async () => {
      for (const startTime of ['09:00', '11:00']) {
        await taskRow('Write proposal').getByRole('button', {name: 'Schedule on calendar'}).click();
        const modal = dialog('New calendar block');
        assert.equal(await modal.getByLabel('Linked task (optional)').inputValue(), taskId);
        assert.equal(await modal.getByLabel('Date', {exact: true}).inputValue(), today);
        await modal.getByLabel('Start time').fill(startTime);
        await modal.getByLabel('End time').fill(startTime === '09:00' ? '10:00' : '12:00');
        await submit('Add block', modal);
        if (startTime === '09:00') {
          await taskRow('Write proposal').waitFor({state: 'detached'});
          await button('Scheduled').click();
        }
      }
      assert.equal((await snapshot()).events.filter(event => event.linkedTaskId === taskId).length, 2);
      await button('Calendar').click();
      await leadingDate(today);
      await timed(today, 'Write proposal').first().click();
      await button('Open linked task: Write proposal', dialog('Edit calendar block')).click();
      const modal = dialog('Edit task');
      await modal.getByLabel('Task name').fill('Polish proposal');
      await submit('Save changes', modal);
      await button('Calendar').click();
      assert.equal(await timed(today, 'Polish proposal').count(), 2);
    });

    await check('Project deletion rehomes tasks, and deleting a task preserves linked blocks', async () => {
      await button('Tasks').click();
      await button('Portfolio Refresh').click();
      await submit('Remove project', dialog('Rename project'));
      const standalone = page.locator('.standalone-panel').locator('[data-task-id]').filter({hasText: 'Polish proposal'});
      await standalone.waitFor();
      await standalone.getByRole('checkbox', {name: 'Mark Polish proposal complete'}).click();
      await standalone.waitFor({state: 'detached'});
      await button('Completed').click();
      await standalone.waitFor();
      await button('Polish proposal', standalone).click();
      await submit('Delete task', dialog('Edit task'));
      const state = await snapshot();
      assert.equal(state.tasks.find(task => task.id === taskId), undefined);
      assert.equal(state.events.filter(event => event.title === 'Write proposal' && event.linkedTaskId === null).length, 2);
      await screenshot('tasks');
    });

    await check('Editing a legacy overnight block preserves timing and hidden legacy fields', async () => {
      await button('Calendar').click();
      await page.locator(`.time-column[data-date="${today}"] [data-event-id="${overnightId}"]`).click();
      const modal = dialog('Edit calendar block');
      assert.equal(await modal.getByLabel('Start time').inputValue(), '22:00');
      assert.equal(await modal.getByLabel('End time').inputValue(), '01:00');
      await modal.getByLabel('Notes').fill('Edited notes');
      await submit('Save changes', modal);
      const event = (await snapshot()).events.find(event => event.id === overnightId);
      assert.equal(event.notes, 'Edited notes');
      assert.equal(event.endDate, dateOffset(today, 1));
      assert.equal(event.kind, 'actual');
      assert.equal(event.textBox, 'Historical context');
    });

    await check('Close, backdrop and Cancel discard edits at narrow sizes', async () => {
      await size(720, 650);
      for (const close of ['Close dialog', 'Cancel', 'backdrop']) {
        await button('New block').click();
        const modal = dialog('New calendar block');
        await modal.getByLabel('Title').fill('Discarded title');
        if (close === 'backdrop') await page.mouse.click(4, 4);
        else await button(close, modal).click();
        await modal.waitFor({state: 'hidden'});
      }
      assert.ok(!(await snapshot()).events.some(event => event.title === 'Discarded title'));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollHeight <= innerHeight + 1));
      await screenshot('narrow-calendar');

      await size(390, 844);
      await scrollGrid(7 * 66);
      const newBlock = await button('New block').boundingBox();
      const heading = await page.locator('.screen-content:not([hidden]) .topbar h1').boundingBox();
      assert.ok(newBlock.x + newBlock.width <= 390 && heading.y < newBlock.y + newBlock.height && newBlock.y < heading.y + heading.height);
      assert.ok(await button('Today').isVisible());
      assert.ok(await page.getByRole('button', {name: /^Categories/}).isVisible());
      assert.equal(await page.locator('.single-calendar-note').isVisible(), false);
      await screenshot('mobile-calendar');
    });

    assert.deepEqual(errors, [], 'No uncaught renderer exceptions');
  } catch (error) {
    await screenshot('error').catch(() => {});
    throw error;
  } finally {
    await app?.close();
    fs.rmSync(dataDir, {recursive: true, force: true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
