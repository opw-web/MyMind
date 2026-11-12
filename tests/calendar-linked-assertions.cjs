const assert=require('node:assert/strict');
module.exports=function(state,today=require('../dist/shared/dates').todayIn()){
 assert.equal(state.tasks.length,9,JSON.stringify(state.tasks.map(t=>t.title)));assert.equal(state.events.length,5,JSON.stringify(state.events));assert.equal(new Set(state.events.map(e=>e.linkedTaskId)).size,5);
 const {shiftDate,weekday}=require('../dist/shared/dates');let thursday=today;while(weekday(thursday)!=='Thu')thursday=shiftDate(thursday,1);
 const expected=[[/budget/i,today],[/laser cutter/i,today],[/appliance repair/i,thursday],[/cardboard model/i,today],[/display stand/i,shiftDate(today,1)]];
 for(const [pattern,date] of expected){const task=state.tasks.find(t=>pattern.test(t.title));assert.ok(task,`${pattern} task missing`);const event=state.events.find(e=>e.linkedTaskId===task.id);assert.ok(event,`${task.title} event missing`);assert.equal(event.startDate,date);assert.equal(event.endDate,date);assert.equal(event.startTime,null);assert.equal(event.endTime,null);}
 const scheduled=new Set(state.events.map(e=>e.linkedTaskId));assert.equal(state.tasks.filter(t=>!scheduled.has(t.id)).length,4);assert.ok(state.tasks.filter(t=>!scheduled.has(t.id)).every(t=>t.scheduledDate===null&&t.dueDate===null));assert.ok(state.tasks.every(t=>!t.completed));
};
