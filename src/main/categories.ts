import {randomUUID} from 'node:crypto';
import {Category,Change,Color,Snapshot,COLORS} from '../shared/model';

const aliases:Record<string,string>={sleep:'Sleep',sleeping:'Sleep',slept:'Sleep',bedtime:'Sleep',exam:'Exams',exams:'Exams',assignment:'Assignments',assignments:'Assignments',homework:'Assignments',submission:'Submissions',submissions:'Submissions',deadline:'Submissions',meeting:'Meetings',meetings:'Meetings',appointment:'Appointments',appointments:'Appointments',errand:'Errands',errands:'Errands',task:'Tasks',tasks:'Tasks',event:'Events',events:'Events'};
export const categoryKey=(title:string)=>title.trim().toLowerCase().replace(/\s+/g,' ');
export function categoryTitle(title:string):string{return aliases[categoryKey(title)]??title.trim();}
// Stable identity lives on the category so display-name edits do not break reuse.
export function normalizeCategory<T extends Category>(category:T):T {
  return {...category,semanticKey:category.semanticKey??categoryKey(categoryTitle(category.title)),aliases:[...new Set([...(category.aliases??[]).map(categoryKey),categoryKey(category.title),categoryKey(categoryTitle(category.title))])]};
}
export function inferCategory(title:string,entity:'task'|'event'):string {
  if(/\b(sleep|slept|sleeping|bedtime)\b|\b(?:went|go|going) to bed\b/i.test(title))return 'Sleep';
  if(/\b(exam|test|quiz|midterm|finals)\b/i.test(title))return 'Exams';
  if(/\b(submit|submission|deadline|hand in|turn in)\b/i.test(title))return 'Submissions';
  if(/\b(assignment|homework|coursework|essay|worksheet)\b/i.test(title))return 'Assignments';
  if(/\b(meeting|review|standup|interview)\b/i.test(title))return 'Meetings';
  if(/\b(doctor|dentist|appointment|checkup)\b/i.test(title))return 'Appointments';
  if(/\b(buy|shop|groceries|pick up|collect|pay)\b/i.test(title))return 'Errands';
  if(/\b(prototype|cornhole|3d print|packaging|build|design)\b/i.test(title))return 'Projects';
  return entity==='task'?'Tasks':'Events';
}
const semanticColors:Record<string,Color>={Sleep:'lavender',Exams:'rose',Assignments:'sky',Submissions:'amber',Meetings:'lavender',Appointments:'coral',Errands:'sage',Projects:'lavender',Tasks:'sage',Events:'sky'};

// Shared by manual editing, assistant drafts and the explicit bulk organizer.
export function categorizeChanges(snapshot:Snapshot,source:Change[]):Change[]{
  const changes=source.map(c=>({...c,fields:c.fields?{...c.fields}:undefined}));
  let categories:Category[]=snapshot.categories.filter(c=>!changes.some(change=>change.entity==='category'&&change.action==='delete'&&change.id===c.id)).map(normalizeCategory);
  const additions:Change[]=[],metadata:Change[]=[],replacements=new Map<string,string>();
  const matches=(title:string,semanticKey?:string)=>categories.find(c=>c.semanticKey===(semanticKey??categoryKey(categoryTitle(title)))||c.aliases?.includes(categoryKey(title))||categoryKey(categoryTitle(c.title))===categoryKey(categoryTitle(title)));
  const addAlias=(category:Category,title:string)=>{
    const alias=categoryKey(title);
    if(!category.aliases?.includes(alias)){
      category.aliases=[...category.aliases??[],alias];
      const creation=additions.find(c=>c.id===category.id);
      if(creation)creation.fields!.aliases=category.aliases;
      else {const update=metadata.find(c=>c.id===category.id);if(update)update.fields!.aliases=category.aliases;else metadata.push({action:'update',entity:'category',id:category.id,fields:{semanticKey:category.semanticKey,aliases:category.aliases}});}
    }
  };
  // Reuse explicit category creations too; references in this batch follow the saved identity.
  for(const change of changes.filter(c=>c.entity==='category'&&c.action==='create')){
    const fields=change.fields??{},title=categoryTitle(String(fields.title??'')),existing=matches(title,fields.semanticKey as string|undefined);
    change.id??=randomUUID();
    if(existing){if(change.id!==existing.id)replacements.set(change.id,existing.id);addAlias(existing,title);continue;}
    const category=normalizeCategory({id:change.id,title,color:(fields.color??'sky') as Color,...(fields.semanticKey?{semanticKey:String(fields.semanticKey)}:{}),aliases:fields.aliases as string[]|undefined});
    categories.push(category);change.fields={...fields,title,semanticKey:category.semanticKey,aliases:category.aliases};additions.push(change);
  }
  const canonicalId=(id:string):string=>{
    const visited=new Set<string>();
    while(replacements.has(id)){
      if(visited.has(id))throw new Error('Category references cannot contain a cycle.');
      visited.add(id);id=replacements.get(id)!;
    }
    return id;
  };
  // Resolve every operation before choosing inference candidates: an absorbed
  // delete is a real deletion of the canonical identity, even for later inference.
  for(const change of changes)if(change.entity==='category'&&change.id)change.id=canonicalId(change.id);
  const deleted=new Set(changes.filter(change=>change.entity==='category'&&change.action==='delete').map(change=>change.id));
  categories=categories.filter(category=>!deleted.has(category.id));
  for(const change of changes){
    if(change.entity==='category'&&change.action==='update'&&change.fields){
      const category=categories.find(c=>c.id===change.id);if(category&&change.fields.title){addAlias(category,String(change.fields.title));category.title=String(change.fields.title);}
    }
    if(!['event','task'].includes(change.entity)||change.action==='delete'||!change.fields)continue;
    const f=change.fields;
    if(typeof f.categoryId==='string'){
      f.categoryId=canonicalId(f.categoryId);
      if(!categories.some(category=>category.id===f.categoryId)){
        // Models sometimes put an exact category name in an ID field. Resolve
        // only unique verified/new names or retained aliases; never invent IDs.
        const ref=categoryKey(f.categoryId as string),found=categories.filter(category=>categoryKey(category.title)===ref||category.semanticKey===ref||category.aliases?.includes(ref));
        if(found.length>1)throw new Error('Several categories match this reference. Choose a verified category ID.');
        if(found.length===1)f.categoryId=found[0].id;
      }
    }
    if(f.color!==undefined&&f.colorOverride===undefined)f.colorOverride=f.color;
    if(f.categoryTitle!==undefined||(change.action==='create'&&f.categoryId===undefined)){
      const requested=String(f.categoryTitle??inferCategory(String(f.title??''),change.entity as 'task'|'event')),title=categoryTitle(requested);
      if(title.length>80||!title)throw new Error('Use a concise category name.');
      let category=matches(title);
      if(!category&&!semanticColors[title]&&categoryKey(title)===categoryKey(String(f.title??'')))throw new Error('Use a reusable category, not the item title.');
      if(!category){category=normalizeCategory({id:randomUUID(),title,color:semanticColors[title]??COLORS.find(color=>!categories.some(c=>c.color===color))??'sky'});categories.push(category);additions.push({action:'create',entity:'category',id:category.id,fields:{title,color:category.color,semanticKey:category.semanticKey,aliases:category.aliases}});}
      addAlias(category,requested);f.categoryId=category.id;delete f.categoryTitle;
    }
  }
  // Prefer caller order, but wait for title-releasing deletions and creations.
  // Dependencies also carry later edits and linked sessions with a delayed item;
  // unrelated reassignments must still run before category deletion side effects.
  const operations=changes.filter(change=>change.entity!=='category'||change.action!=='create');
  const pending=[...metadata,...additions,...operations],dependencies=new Map(pending.map(change=>[change,new Set<Change>()]));
  const creations=new Map(pending.filter(change=>change.action==='create'&&change.id).map(change=>[`${change.entity}:${change.id}`,change]));
  const previous=new Map<string,Change>();
  for(const change of pending){
    const required=dependencies.get(change)!;
    if(change.id){const key=`${change.entity}:${change.id}`,prior=previous.get(key);if(prior)required.add(prior);previous.set(key,change);}
    for(const [field,entity] of [['categoryId','category'],['linkedTaskId','task']] as const){
      const id=change.fields?.[field],creation=typeof id==='string'?creations.get(`${entity}:${id}`):undefined;
      if(creation)required.add(creation);
    }
  }
  for(const addition of additions){
    const title=categoryKey(String(addition.fields?.title??''));
    const blockers=operations.filter(change=>change.entity==='category'&&change.action==='delete'&&change.id!==addition.id&&[
      snapshot.categories.find(category=>category.id===change.id)?.title,
      ...operations.filter(operation=>operation.entity==='category'&&operation.id===change.id&&operation.action==='update').map(operation=>operation.fields?.title)
    ].some(candidate=>typeof candidate==='string'&&categoryKey(candidate)===title));
    for(const blocker of blockers)dependencies.get(addition)!.add(blocker);
  }
  // A delayed consumer must not cross deletion of its explicit category: before
  // deletion it attaches and then detaches normally; after deletion it is invalid.
  for(const [index,deletion] of operations.entries())if(deletion.entity==='category'&&deletion.action==='delete'){
    for(const [consumerIndex,consumer] of operations.entries())if(consumer.fields?.categoryId===deletion.id){
      if(consumerIndex<index)dependencies.get(deletion)!.add(consumer);
      else dependencies.get(consumer)!.add(deletion);
    }
  }
  const ordered:Change[]=[],emitted=new Set<Change>();
  while(pending.length){
    const index=pending.findIndex(change=>[...dependencies.get(change)!].every(dependency=>emitted.has(dependency)));
    if(index<0)throw new Error('Category changes have conflicting creation and deletion dependencies.');
    const [change]=pending.splice(index,1);ordered.push(change);emitted.add(change);
  }
  return ordered;
}
