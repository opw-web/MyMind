const assert = require('node:assert/strict');
const {todayIn, endOfWeek} = require('../dist/shared/dates');

const repairTitle = /appliance repair|dishwasher repair|repair.*(?:appliance|dishwasher)/i;

function initial(snapshot, reply, today = todayIn(snapshot.preferences.timezone)) {
  const {tasks} = snapshot;
  assert.equal(tasks.length, 10, 'Every distinct commitment must be proposed once.');
  assert.equal(snapshot.events.length, 0);

  const one = pattern => {
    const matches = tasks.filter(task => pattern.test(task.title));
    assert.equal(matches.length, 1, String(pattern));
    return matches[0];
  };
  const cutter = one(/laser cutter/i);
  const repair = one(repairTitle);
  one(/spring.*class|class.*spring/i);
  one(/library/i);
  one(/workbench/i);
  const summary = one(/^(?!.*(?:portfolio|newsletter)).*project summary/i);
  const portfolio = one(/portfolio/i);
  const newsletter = one(/newsletter/i);
  one(/seed/i);
  const tools = one(/return.*tools/i);

  assert.equal(cutter.dueDate, today);
  assert.equal(tools.dueDate, today);
  assert.equal(repair.dueDate, null, 'The conflicting repair deadline needs clarification.');
  for (const task of tasks) {
    assert.equal(task.scheduledDate, null);
    assert.equal(task.projectId, 'inbox');
    assert.doesNotMatch(task.title, /to.do list|mosaic profile/i);
    if (![cutter.id, tools.id].includes(task.id)) assert.equal(task.dueDate, null, task.title);
    assert.equal(task.steps.length, 0, task.title);
  }
  assert.deepEqual(portfolio.dependsOnIds, [summary.id]);
  assert.deepEqual(newsletter.dependsOnIds, [summary.id]);
  assert.match(reply, /mosaic/i, 'Ask about the unresolved mosaic profile phrase before Apply.');
  assert.match(reply, /repair|deadline/i, 'Ask about the conflicting repair deadline before Apply.');
  assert.doesNotMatch(reply, /which planner|which.*itemiz|do you want me to (?:save|create|add)/i);
  return {repair, summary};
}

function corrected(snapshot, repairId, reply) {
  assert.equal(snapshot.tasks.length, 10);
  const repair = snapshot.tasks.find(task => task.id === repairId);
  assert.ok(repair, 'Correction must preserve the repair task ID.');
  assert.equal(repair.dueDate, endOfWeek(todayIn(snapshot.preferences.timezone)));
  assert.match(repair.title, /dishwasher/i);
  assert.match(repair.title, /Maple Appliance Repair/i);
  assert.equal(repair.scheduledDate, null);
  assert.equal(snapshot.tasks.filter(task => /workshop portfolio/i.test(task.title)).length, 1);
  assert.equal(snapshot.tasks.filter(task => repairTitle.test(task.title)).length, 1);
  assert.doesNotMatch(reply, /error.*update action|clarify what changes|what did you mean by.*mosaic|which planner|(?:mosaic|mishear|dictation)[^.!?\n]{0,240}\?/i);
  return repair;
}

module.exports = {initial, corrected};
