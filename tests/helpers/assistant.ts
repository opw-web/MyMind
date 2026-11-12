import assert from 'node:assert/strict';
import {PlannerDatabase} from '../../src/main/database';
import {PlannerAssistant} from '../../src/main/assistant';
import {ChatInput,ChatResult} from '../../src/shared/model';
/** Legacy outcome assertions explicitly exercise the user's Apply action. */
export async function chatAndApply(assistant:PlannerAssistant,input:ChatInput):Promise<ChatResult>{
 const db=(assistant as unknown as {db:PlannerDatabase}).db,before=db.snapshot();
 const journal=()=>({history:db.db.prepare('SELECT * FROM history ORDER BY id').all(),requests:db.db.prepare('SELECT * FROM requests ORDER BY id').all()});
 const beforeJournal=journal(),result=await assistant.chat(input);
 assert.deepEqual(db.snapshot(),before,'AI never writes planner records before explicit Apply');
 assert.deepEqual(journal(),beforeJournal,'AI never writes history/request receipts before explicit Apply');
 assert.equal(result.receipt===undefined||result.receipt.revision<=before.revision,true,'Only cached actually applied results contain receipts');
 if(!result.preview||result.preview.draft.unresolved.some(issue=>issue.required))return result;
 const draft=result.preview.draft,receipt=assistant.applyDraft({draftId:draft.id,version:draft.version,expectedRevision:draft.baseRevision,requestId:`test-apply:${input.requestId}`});
 return {...result,preview:undefined,receipt};
}
