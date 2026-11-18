import {z} from 'zod';
import {isDate} from '../shared/dates';
import {AssistantViewAction,Snapshot} from '../shared/model';

const actionSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('tab'),tab:z.enum(['calendar','tasks'])}).strict(),
  z.object({type:z.literal('date'),date:z.string().refine(isDate)}).strict(),
  z.object({type:z.literal('categoryVisibility'),categoryId:z.string(),visible:z.boolean()}).strict(),
  z.object({type:z.literal('showAllCategories')}).strict(),
  z.object({type:z.literal('taskFilters'),completion:z.enum(['active','completed','all']).optional(),schedule:z.enum(['all','scheduled','unscheduled']).optional()}).strict(),
  z.object({type:z.literal('projectCollapsed'),projectId:z.string(),collapsed:z.boolean()}).strict(),
  z.object({type:z.literal('taskExpanded'),taskId:z.string(),expanded:z.boolean()}).strict()
]);

export const viewActionParameters={
  type:'array',
  description:'Only when explicitly requested, use supported UI actions. A date is the YYYY-MM-DD date to open on the calendar. Use existing, verified IDs.',
  items:{type:'object',properties:{
    type:{type:'string',enum:['tab','date','categoryVisibility','showAllCategories','taskFilters','projectCollapsed','taskExpanded']},
    tab:{type:'string',enum:['calendar','tasks']},date:{type:'string'},
    categoryId:{type:'string'},visible:{type:'boolean'},
    completion:{type:'string',enum:['active','completed','all']},schedule:{type:'string',enum:['all','scheduled','unscheduled']},
    projectId:{type:'string'},collapsed:{type:'boolean'},taskId:{type:'string'},expanded:{type:'boolean'}
  },required:['type'],additionalProperties:false}
};

export function assistantViewActions(value:unknown,snapshot:Snapshot):AssistantViewAction[]|undefined {
  if(value===undefined)return;
  const actions=z.array(actionSchema).min(1).max(12).parse(value);
  const valid=(action:AssistantViewAction):boolean=>{
    switch(action.type){
      case 'categoryVisibility':return snapshot.categories.some(item=>item.id===action.categoryId);
      case 'projectCollapsed':return snapshot.projects.some(item=>item.id===action.projectId);
      case 'taskExpanded':return snapshot.tasks.some(item=>item.id===action.taskId);
      case 'taskFilters':return !!(action.completion||action.schedule);
      default:return true;
    }
  };
  if(!actions.every(valid))throw new Error('Use existing planner IDs and specify the requested filters.');
  return actions;
}
