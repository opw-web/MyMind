// Some local-model replies still seek approval despite an actionable request.
// Give these back to the model to execute; never treat them as user approval.
export function asksForApproval(reply:string):boolean {
  return /\b(?:would you like me to|do you (?:want|wish) me to|(?:should|shall|can|may) i (?:go ahead|proceed|add|create|save|commit|schedule|move|update|delete|remove|organize|mark|complete)|(?:want|like) me to (?:go ahead|proceed|add|create|save|commit|schedule|move|update|delete|remove|organize)|ready to (?:commit|save|proceed)|(?:please |can you )?confirm (?:that you (?:want|would like)|you (?:want|would like)|this (?:change|plan)|these changes|the (?:change|plan)|before i|so i can)|(?:is (?:that|this)|does (?:that|this) sound) (?:okay|ok|good)|let me know if you (?:want|would like)|once you confirm|with your approval)\b/i.test(reply);
}

export function actionFollowUp(reply:string,request:string,autoApply=false):string|undefined {
  const permission=asksForApproval(reply);
  const optional=/\b(?:which|what) (?:project|section|category|colou?r)\b|\b(?:which|what) planner\b|\b(?:itemi[sz]ed)\b|\b(?:what time|which time|what due date|what deadline|date and time)\b|\bwould you like(?: any)? notes\b/i.test(reply);
  const timeQuestion=/\b(?:time|times)\b/i.test(reply)&&/\b(?:need|require|tell|provide|what|which|when|could you|can you)\b/i.test(reply);
  const requestedTime=/\bat\s+\d|\b(?:time|times|am|pm|o'clock|morning|afternoon|evening|noon|midnight)\b/i.test(request);
  // Respect a specifically requested choice, even when the field is optional
  // in the database. Missing time in an explicit timed request needs an answer.
  const requestedChoice=/\b(?:project|section|category|colou?r|time|deadline|due date)\b|\bat\s+(?:\d|what|which)\b/i.test(request);
  if(permission||optional&&!requestedChoice||timeQuestion&&!requestedTime)return 'The user has already requested these changes. Do not ask for confirmation or optional setup. Use the stated defaults and verified context, stage every requested change, and '+(autoApply?'submit the complete batch with finish_request outcome=apply.':'publish the whole valid preview now; the user will Apply it.')+' Events with dates and no specified times are valid untimed events; propose them without times. Ask only for a genuinely missing required detail or unresolved item ambiguity. If you cannot complete the request, state the specific problem without claiming success or asking for permission again.';
}
