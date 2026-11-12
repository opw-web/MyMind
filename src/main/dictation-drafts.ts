import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {z} from 'zod';
import {DictationDraft} from '../shared/model';

const identity={draftId:z.string().uuid(),generation:z.string().uuid()};
export class DictationDrafts {
  private db:DatabaseSync;
  constructor(path:string){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;'+
      'CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,body TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS chunks(draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,sequence INTEGER NOT NULL,audio BLOB NOT NULL,PRIMARY KEY(draft_id,sequence));');
  }
  private write(draft:DictationDraft){draft.updatedAt=new Date().toISOString();this.db.prepare('INSERT INTO drafts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(draft.id,JSON.stringify(draft));return draft;}
  get(id:string):DictationDraft{
    z.string().uuid().parse(id);const row=this.db.prepare('SELECT body FROM drafts WHERE id=?').get(id);
    if(!row)throw new Error('This dictation draft is no longer available.');
    return {partialText:'',...JSON.parse(row.body as string)};
  }
  owned(id:string,generation:string){const draft=this.get(id);if(draft.generation!==generation)throw new Error('This dictation belongs to an earlier session.');return draft;}
  create(input:{generation:string;prefix:string}){
    const {generation,prefix}=z.object({generation:z.string().uuid(),prefix:z.string()}).strict().parse(input),now=new Date().toISOString();
    return this.write({id:randomUUID(),generation,prefix,liveText:'',finalText:'',partialText:'',reviewText:prefix,revision:0,seconds:0,bytes:0,nextSequence:0,createdAt:now,updatedAt:now});
  }
  bind(id:string,generation:string){z.string().uuid().parse(generation);return this.write({...this.get(id),generation});}
  append(input:{draftId:string;generation:string;sequence:number;audio:ArrayBuffer;seconds:number}){
    const p=z.object({...identity,sequence:z.number().int().nonnegative(),audio:z.instanceof(ArrayBuffer).refine(b=>b.byteLength>0),seconds:z.number().nonnegative().finite()}).strict().parse(input);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const draft=this.owned(p.draftId,p.generation),audio=Buffer.from(p.audio);
      if(p.sequence<draft.nextSequence){
        const existing=this.db.prepare('SELECT audio FROM chunks WHERE draft_id=? AND sequence=?').get(draft.id,p.sequence);
        if(!existing||!audio.equals(Buffer.from(existing.audio as Uint8Array)))throw new Error('An audio chunk was repeated with different content.');
      }else{
        if(p.sequence!==draft.nextSequence)throw new Error('An audio chunk is missing. Your recording is retained; retry saving it.');
        this.db.prepare('INSERT INTO chunks VALUES (?,?,?)').run(draft.id,p.sequence,audio);
        draft.nextSequence++;draft.bytes+=audio.length;draft.seconds=Math.max(draft.seconds,p.seconds);this.write(draft);
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  checkpoint(input:{draftId:string;generation:string;liveText?:string;reviewText?:string;revision?:number;seconds?:number}){
    const p=z.object({...identity,liveText:z.string().optional(),reviewText:z.string().optional(),revision:z.number().int().nonnegative().optional(),seconds:z.number().nonnegative().finite().optional()}).strict().parse(input);
    const draft=this.owned(p.draftId,p.generation);
    if(p.revision!==undefined&&p.revision!==draft.revision)throw new Error('The dictation draft changed. Review the retained versions.');
    if(p.liveText!==undefined)draft.liveText=p.liveText;
    if(p.reviewText!==undefined&&p.reviewText!==draft.reviewText){draft.reviewText=p.reviewText;draft.revision++;}
    if(p.seconds!==undefined)draft.seconds=Math.max(draft.seconds,p.seconds);
    return this.write(draft);
  }
  progress(id:string,generation:string,text:string){const draft=this.owned(id,generation);draft.partialText=text;return this.write(draft);}
  final(id:string,generation:string,text:string,reviewRevision?:number){
    const draft=this.owned(id,generation);if(text.trim()){draft.finalText=text;draft.partialText='';}
    if(text.trim()&&reviewRevision!==undefined&&draft.revision===reviewRevision){
      draft.reviewText=[draft.prefix.trim(),text.trim()].filter(Boolean).join(' ');draft.revision++;
    }
    return this.write(draft);
  }
  audio(id:string,generation:string):ArrayBuffer{
    const draft=this.owned(id,generation);
    const bytes=Buffer.concat(this.db.prepare('SELECT audio FROM chunks WHERE draft_id=? ORDER BY sequence').all(id).map(row=>Buffer.from(row.audio as Uint8Array)));
    if(!bytes.length||bytes.length!==draft.bytes)throw new Error('No complete audio is available. Your text draft is retained.');
    return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
  }
  list():DictationDraft[]{return this.db.prepare('SELECT body FROM drafts ORDER BY rowid DESC').all().map(row=>({partialText:'',...JSON.parse(row.body as string)}));}
  discard(id:string){z.string().uuid().parse(id);this.db.prepare('DELETE FROM drafts WHERE id=?').run(id);this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}
  close(){this.db.close();}
}
