import {Task} from './model';

export interface FlowNode {task:Task;x:number;y:number;width:number;height:number;context:boolean;}
export interface TaskFlowLayout {nodes:FlowNode[];edges:{from:string;to:string}[];width:number;height:number;}

export function layoutTaskFlow(visible:Task[],all:Task[],measured:ReadonlyMap<string,number>=new Map()):TaskFlowLayout{
  const byId=new Map(all.map(t=>[t.id,t])),visibleIds=new Set(visible.map(t=>t.id)),included=new Set<string>();
  function include(task:Task){if(included.has(task.id))return;included.add(task.id);task.dependsOnIds.forEach(id=>{const parent=byId.get(id);if(parent)include(parent);});}
  visible.forEach(include);
  const tasks=all.filter(t=>included.has(t.id)),neighbors=new Map(tasks.map(t=>[t.id,new Set<string>()]));
  const edges=tasks.flatMap(task=>task.dependsOnIds.filter(id=>included.has(id)).map(from=>({from,to:task.id})));
  edges.forEach(edge=>{neighbors.get(edge.from)!.add(edge.to);neighbors.get(edge.to)!.add(edge.from);});
  const grouped=new Set<string>(),nodes:FlowNode[]=[];let top=28,width=0;
  const cardWidth=324,gap=88;
  function height(task:Task){return measured.get(task.id)??106+Math.ceil(task.title.length/34)*22+task.steps.reduce((n,s)=>n+Math.max(42,Math.ceil(s.title.length/34)*20+18),0);}
  for(const seed of tasks){
    if(grouped.has(seed.id))continue;
    const ids=new Set<string>(),queue=[seed.id];
    while(queue.length){const id=queue.shift()!;if(ids.has(id))continue;ids.add(id);grouped.add(id);neighbors.get(id)?.forEach(next=>queue.push(next));}
    const members=tasks.filter(t=>ids.has(t.id)),depths=new Map<string,number>();
    function depth(task:Task,visiting=new Set<string>()):number{
      if(depths.has(task.id))return depths.get(task.id)!;
      if(visiting.has(task.id))return 0;
      const next=new Set(visiting).add(task.id);
      const parents=task.dependsOnIds.filter(id=>ids.has(id));
      const value=parents.length?1+Math.max(...parents.map(id=>depth(byId.get(id)!,next))):0;depths.set(task.id,value);return value;
    }
    const columns=new Map<number,number>();let bottom=top;
    for(const task of members){
      const column=depth(task),y=columns.get(column)??top,h=height(task),x=28+column*(cardWidth+gap);
      nodes.push({task,x,y,width:cardWidth,height:h,context:!visibleIds.has(task.id)});
      columns.set(column,y+h+34);bottom=Math.max(bottom,y+h);width=Math.max(width,x+cardWidth+28);
    }
    top=bottom+54;
  }
  return {nodes,edges,width:Math.max(380,width),height:Math.max(240,top)};
}
