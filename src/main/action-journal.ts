import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ActionReceipt, ChatInput, ChatMessage, ChatResult, Entity, Snapshot, TaskStep} from '../shared/model';

export const actionCollections={event:'events',task:'tasks',project:'projects',section:'sections',category:'categories'} as const;
export type ActionState=Pick<Snapshot,(typeof actionCollections)[Entity]>;
type Row=Record<string,unknown>&{id:string};
type Version={owner:string;revision:number};
type Effect={entity:Entity;id:string;field?:string;stepId?:string;before?:unknown;after?:unknown;previous?:Version};
type PositionedStep={step:TaskStep;next?:string;previous?:string;index:number};
type Card={receipt:ActionReceipt;effects:Effect[];revision:number};

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const rows=(state:ActionState,entity:Entity)=>state[actionCollections[entity]] as unknown as Row[];
const entities=Object.keys(actionCollections) as Entity[];
const identity=(effect:Effect)=>JSON.stringify([effect.entity,effect.id,effect.stepId??null,effect.field??null]);

function fields(before:Row, after:Row, target:Pick<Effect,'entity'|'id'|'stepId'>, ignore:string[]=[]):Effect[] {
  return [...new Set([...Object.keys(before),...Object.keys(after)])]
    .filter(field=>field!=='id'&&!ignore.includes(field)&&!same(before[field],after[field]))
    .map(field=>({...target,field,before:before[field],after:after[field]}));
}

function checklist(before:TaskStep[],after:TaskStep[],id:string):Effect[] {
  const position=(list:TaskStep[],stepId:string):PositionedStep|undefined=>{
    const index=list.findIndex(step=>step.id===stepId);
    return index<0?undefined:{step:list[index],previous:list[index-1]?.id,next:list[index+1]?.id,index};
  };
  const effects:Effect[]=[];
  for(const stepId of new Set([...before,...after].map(step=>step.id))){
    const old=position(before,stepId),next=position(after,stepId);
    if(old&&next)effects.push(...fields(old.step as unknown as Row,next.step as unknown as Row,{entity:'task',id,stepId}));
    else effects.push({entity:'task',id,stepId,before:old,after:next});
  }
  const oldOrder=before.map(step=>step.id).filter(stepId=>after.some(step=>step.id===stepId));
  const nextOrder=after.map(step=>step.id).filter(stepId=>before.some(step=>step.id===stepId));
  if(!same(oldOrder,nextOrder))effects.push({entity:'task',id,field:'steps',before:oldOrder,after:nextOrder});
  return effects;
}

export function actionEffects(before:ActionState,after:ActionState):Effect[] {
  const effects:Effect[]=[];
  for(const entity of entities){
    const oldRows=new Map(rows(before,entity).map(row=>[row.id,row]));
    const nextRows=new Map(rows(after,entity).map(row=>[row.id,row]));
    for(const id of new Set([...oldRows.keys(),...nextRows.keys()])){
      const old=oldRows.get(id),next=nextRows.get(id);
      if(old&&next)effects.push(...fields(old,next,{entity,id},entity==='task'?['steps']:[]));
      else effects.push({entity,id,before:old,after:entity==='task'&&next?{...next,steps:[]}:next});
      if(entity==='task'&&next)effects.push(...checklist((old?.steps??[]) as TaskStep[],(next.steps??[]) as TaskStep[],id));
    }
  }
  return effects;
}

// Referential repairs belong to the operation that required them. They should
// never produce a second card for an unlinked block or a rehomed task.
function actionOwner(effect:Effect, before:ActionState,after:ActionState){
  const old=rows(before,effect.entity).find(row=>row.id===effect.id);
  const next=rows(after,effect.entity).find(row=>row.id===effect.id);
  if(!old)return effect;
  const removed=(entity:Entity,id:unknown)=>typeof id==='string'&&rows(before,entity).some(row=>row.id===id)&&!rows(after,entity).some(row=>row.id===id);
  if(effect.entity==='task'&&next?.projectId==='inbox'&&['projectId','sectionId'].includes(effect.field??'')&&removed('project',old.projectId))return {entity:'project' as const,id:old.projectId as string};
  if(effect.entity==='section'&&!next&&removed('project',old.projectId))return {entity:'project' as const,id:old.projectId as string};
  if(effect.entity==='event'&&['linkedTaskId','linkedStepId'].includes(effect.field??'')&&next?.linkedTaskId===null&&removed('task',old.linkedTaskId))return {entity:'task' as const,id:old.linkedTaskId as string};
  if(effect.entity==='event'&&effect.field==='linkedStepId'&&effect.after===null&&typeof old.linkedTaskId==='string'&&typeof effect.before==='string'){
    const owner=after.tasks.find(task=>task.id===old.linkedTaskId);
    if(owner&&!owner.steps.some(step=>step.id===effect.before))return {entity:'task' as const,id:owner.id,stepId:effect.before};
  }
  if(effect.field==='dependsOnIds'&&Array.isArray(effect.before)&&Array.isArray(effect.after)){
    const dependencies=effect.before.filter(id=>!(effect.after as unknown[]).includes(id));
    if(dependencies.length===1&&removed('task',dependencies[0]))return {entity:'task' as const,id:dependencies[0] as string};
  }
  if(['categoryId','colorOverride'].includes(effect.field??'')&&next?.categoryId===null&&removed('category',old.categoryId))return {entity:'category' as const,id:old.categoryId as string};
  return effect;
}

function restoreEffect(state:ActionState,effect:Effect){
  const list=rows(state,effect.entity),index=list.findIndex(row=>row.id===effect.id),record=list[index];
  if(effect.stepId){
    const steps=record.steps as TaskStep[],stepIndex=steps.findIndex(step=>step.id===effect.stepId);
    if(effect.field){
      const step=steps[stepIndex] as unknown as Row;
      step[effect.field]=structuredClone(effect.before);
    }else if(effect.before){
      const value=effect.before as PositionedStep;
      const next=steps.findIndex(step=>step.id===value.next),previous=steps.findIndex(step=>step.id===value.previous);
      steps.splice(next>=0?next:previous>=0?previous+1:Math.min(value.index,steps.length),0,structuredClone(value.step));
    }else steps.splice(stepIndex,1);
  }else if(effect.field==='steps'&&effect.entity==='task'){
    const steps=record.steps as TaskStep[],order=effect.before as string[];
    const ordered=order.map(id=>steps.find(step=>step.id===id)).filter((step):step is TaskStep=>!!step);
    record.steps=steps.map(step=>order.includes(step.id)?ordered.shift()!:step);
  }else if(effect.field){
    if(effect.before===undefined)delete record[effect.field];
    else record[effect.field]=structuredClone(effect.before);
  }else if(effect.before)list.push(structuredClone(effect.before as Row));
  else list.splice(index,1);
}

export class ActionJournal {
  constructor(private readonly db:DatabaseSync){}

  static migrate(db:DatabaseSync){
    db.exec(`CREATE TABLE IF NOT EXISTS chat_turns (id TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS chat_actions (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES chat_turns(id) ON DELETE CASCADE, card TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_actions_turn ON chat_actions(turn_id);
      CREATE TABLE IF NOT EXISTS action_versions (path TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL);`);
  }

  begin(input:ChatInput){
    this.db.prepare('INSERT OR IGNORE INTO chat_turns(id,input) VALUES (?,?)').run(input.requestId,input.text);
    const entry=this.db.prepare('SELECT input FROM chat_turns WHERE id=?').get(input.requestId);
    if(entry?.input!==input.text)throw new Error('This message ID already belongs to another request.');
  }

  result(id:string):ChatResult|undefined {
    const entry=this.db.prepare('SELECT result FROM chat_turns WHERE id=?').get(id);
    if(!entry?.result)return undefined;
    const result=JSON.parse(String(entry.result)) as ChatResult;
    if(result.receipt?.actions)result.receipt.actions=this.db.prepare('SELECT card FROM chat_actions WHERE turn_id=? ORDER BY rowid').all(id)
      .map(row=>(JSON.parse(String(row.card)) as Card).receipt);
    return result;
  }

  finish(id:string,result:ChatResult):ChatResult {
    const existing=this.result(id);
    if(existing)return existing;
    const {preview: _preview,...saved}=result;
    const write=this.db.prepare('UPDATE chat_turns SET result=? WHERE id=?').run(JSON.stringify(saved),id);
    if(!write.changes)throw new Error('This chat is no longer active.');
    return saved;
  }

  history():ChatMessage[] {
    return this.db.prepare(`SELECT id,input FROM chat_turns
      WHERE rowid > COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='chat_history_cutoff'),0)
      ORDER BY rowid`).all().flatMap(row=>{
      const id=String(row.id),result=this.result(id);
      const message:ChatMessage={id:`${id}:user`,role:'user',content:String(row.input)};
      return result?[message,{id:`${id}:assistant`,role:'assistant',...result}]:[message];
    });
  }

  startConversation(){
    this.db.exec(`INSERT OR REPLACE INTO meta (key,value)
      SELECT 'chat_history_cutoff', COALESCE(MAX(rowid),0) FROM chat_turns`);
  }

  recover(){
    const interrupted:ChatResult={status:'interrupted',content:'This request was interrupted. You can send it again.'};
    this.db.prepare('UPDATE chat_turns SET result=? WHERE result IS NULL').run(JSON.stringify(interrupted));
  }

  clear(){
    this.db.exec('BEGIN IMMEDIATE');
    try{this.db.exec("DELETE FROM chat_turns; DELETE FROM action_versions; DELETE FROM meta WHERE key='chat_history_cutoff'; COMMIT");}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  private version(effect:Effect):Version|undefined {
    const entry=this.db.prepare('SELECT owner,revision FROM action_versions WHERE path=?').get(identity(effect));
    return entry?{owner:String(entry.owner),revision:Number(entry.revision)}:undefined;
  }

  private setVersion(effect:Effect,version?:Version){
    const key=identity(effect);
    if(version)this.db.prepare('INSERT INTO action_versions VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET owner=excluded.owner,revision=excluded.revision').run(key,version.owner,version.revision);
    else this.db.prepare('DELETE FROM action_versions WHERE path=?').run(key);
  }

  track(effects:Effect[],revision:number,owner=`manual:${revision}`){
    if(!this.db.prepare('SELECT 1 FROM chat_actions LIMIT 1').get())return;
    for(const effect of effects)this.setVersion(effect,{owner,revision});
  }

  capture(id:string,before:ActionState,after:ActionState,revision:number):ActionReceipt[] {
    const groups=new Map<string,{owner:Pick<Effect,'entity'|'id'|'stepId'>;effects:Effect[]}>();
    for(const effect of actionEffects(before,after)){
      const owner=actionOwner(effect,before,after),key=identity({...owner,field:undefined});
      const group=groups.get(key)??{owner,effects:[]};
      group.effects.push({...effect,previous:this.version(effect)});
      groups.set(key,group);
    }
    const receipts:ActionReceipt[]=[];
    for(const {owner,effects} of groups.values()){
      const {entity,id:idOfItem,stepId}=owner;
      const old=rows(before,entity).find(row=>row.id===idOfItem),next=rows(after,entity).find(row=>row.id===idOfItem);
      const oldItem=stepId?(old?.steps as TaskStep[]|undefined)?.find(step=>step.id===stepId):old;
      const nextItem=stepId?(next?.steps as TaskStep[]|undefined)?.find(step=>step.id===stepId):next;
      if(entity==='section'){
        for(const effect of effects)this.setVersion(effect,{owner:`manual:${revision}`,revision});
        continue;
      }
      const action=oldItem?(nextItem?'update':'delete'):'create';
      const receipt:ActionReceipt={actionId:randomUUID(),action,title:String(nextItem?.title??oldItem?.title??'Planner item'),
        target:{entity:stepId?'step':entity,id:stepId??idOfItem,...(stepId?{taskId:idOfItem}:{}),
          ...(action==='delete'&&oldItem?{before:{...oldItem}}:{})}};
      const card:Card={receipt,effects,revision};
      this.db.prepare('INSERT INTO chat_actions VALUES (?,?,?)').run(receipt.actionId,id,JSON.stringify(card));
      for(const effect of effects)this.setVersion(effect,{owner:receipt.actionId,revision});
      receipts.push(receipt);
    }
    return receipts;
  }

  card(id:string):Card {
    const row=this.db.prepare('SELECT card FROM chat_actions WHERE id=?').get(id);
    if(!row)throw new Error('This action is no longer available in chat.');
    return JSON.parse(String(row.card)) as Card;
  }

  inverse(card:Card,state:ActionState):ActionState {
    const {receipt,effects,revision}=card;
    const conflict=()=>new Error('This item or a required relationship changed after the action. Undo the later change first.');
    for(const effect of effects){
      if(this.version(effect)?.owner!==receipt.actionId)throw conflict();
      const record=rows(state,effect.entity).find(row=>row.id===effect.id);
      const recordVersion=this.version({entity:effect.entity,id:effect.id});
      if(recordVersion&&recordVersion.revision>revision)throw conflict();
      if(effect.stepId){
        const stepVersion=this.version({entity:'task',id:effect.id,stepId:effect.stepId});
        if(stepVersion&&stepVersion.revision>revision)throw conflict();
        if(!record)throw conflict();
        const step=(record.steps as TaskStep[]).find(item=>item.id===effect.stepId);
        if(!effect.field&&effect.after){
          if(!step)throw conflict();
          for(const field of ['title','completed'])if((this.version({...effect,field})?.revision??0)>revision)throw conflict();
        }
      }else if(!effect.field&&effect.after){
        if(!record)throw conflict();
        if(effect.entity==='task'&&(record.steps as TaskStep[]).length)throw new Error('Undo or remove the task’s checklist steps first.');
        for(const field of Object.keys(record)){
          const version=this.version({...effect,field});
          if(version&&version.revision>revision&&!version.owner.startsWith('repair:'))throw conflict();
        }
      }
    }
    const next=structuredClone(state);
    for(const effect of effects.slice().reverse())restoreEffect(next,effect);
    return next;
  }

  reverse(card:Card,before:ActionState,after:ActionState,revision:number):ActionReceipt {
    const owned=new Set(card.effects.map(identity));
    for(const effect of actionEffects(before,after))if(!owned.has(identity(effect)))this.setVersion(effect,{owner:`repair:${revision}`,revision});
    for(const effect of card.effects)this.setVersion(effect,effect.previous);
    card.receipt.undone=true;
    this.db.prepare('UPDATE chat_actions SET card=? WHERE id=?').run(JSON.stringify(card),card.receipt.actionId);
    return card.receipt;
  }
}
