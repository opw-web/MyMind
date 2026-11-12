import {Task} from './model';

export const COMPLETED_TASK_RETENTION_MS=24*60*60*1000;
export function isArchivedTask(task:Pick<Task,'completed'|'completedAt'>,now=Date.now()):boolean{
  return task.completed&&(!task.completedAt||now>=Date.parse(task.completedAt)+COMPLETED_TASK_RETENTION_MS);
}
export function formatTaskTimestamp(timestamp:string|null|undefined,timezone:string):string{
  return timestamp?new Intl.DateTimeFormat('en',{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(timestamp)):'Unknown';
}

export function blockers(task:Task,tasks:Task[]):Task[]{
  return task.dependsOnIds.map(id=>tasks.find(t=>t.id===id)).filter((t):t is Task=>!!t&&!t.completed);
}

// Validate the final graph, not the order of writes in a batch.
export function validateTaskGraph(tasks:Task[]):void{
  const byId=new Map(tasks.map(t=>[t.id,t]));
  const visiting=new Set<string>(),visited=new Set<string>();
  function visit(task:Task):void{
    if(visiting.has(task.id))throw new Error('Task prerequisites cannot contain a cycle.');
    if(visited.has(task.id))return;
    visiting.add(task.id);
    for(const id of task.dependsOnIds){
      if(id===task.id)throw new Error('A task cannot depend on itself.');
      const prerequisite=byId.get(id);
      if(!prerequisite)throw new Error('A prerequisite task no longer exists. Refresh and try again.');
      visit(prerequisite);
    }
    visiting.delete(task.id);visited.add(task.id);
  }
  tasks.forEach(visit);
}
