export type ModelMessage={role:string;content:string;[key:string]:unknown};
export const estimateTokens=(value:unknown)=>Math.ceil(Buffer.byteLength(JSON.stringify(value),'utf8')/3)+32;
export function conversationContext(system:string,turns:ModelMessage[][],user:ModelMessage,context:number,tools:unknown,responseReserve?:number):{messages:ModelMessage[];trimmed:boolean;historyGroups:number[]}{
  const writable=Array.isArray(tools)&&tools.some(t=>t.function?.name==='stage_changes');
  const budget=context-(responseReserve??(writable?3072:2048))-estimateTokens(tools),chosen:ModelMessage[][]=[];
  let used=estimateTokens([{role:'system',content:system},user]);
  if(used>budget)throw new Error('This message is too long for the local model. Please split it into two messages.');
  for(let i=turns.length-1;i>=0;i--){const cost=estimateTokens(turns[i]);if(used+cost>budget)break;chosen.unshift(turns[i]);used+=cost;}
  return {messages:[{role:'system',content:system},...chosen.flat(),user],trimmed:chosen.length<turns.length,historyGroups:chosen.map(turn=>turn.length)};
}
