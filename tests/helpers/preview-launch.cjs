// Test-only launch boundary. Production main/IPC/draft/database remain unchanged.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const {OllamaRuntime}=require(path.join(root,'dist/main/ollama.js'));
OllamaRuntime.prototype.start=async function(){this.status={...this.status,state:'ready',context:65536,gpu:'cpu',message:'Deterministic UI fixture'};this.onStatus(this.status);};
OllamaRuntime.prototype.call=async function(endpoint,body){
 if(endpoint!=='chat')return endpoint==='tags'?{models:[{name:'qwen3.5:9b',size:5000}]}:endpoint==='show'?{capabilities:['completion','tools'],details:{format:'gguf'}}:{};
 fs.appendFileSync(process.env.MYMIND_UI_CALLS,JSON.stringify(body)+'\n');
 const queue=JSON.parse(fs.readFileSync(process.env.MYMIND_UI_QUEUE,'utf8'));const next=queue.shift();fs.writeFileSync(process.env.MYMIND_UI_QUEUE,JSON.stringify(queue));
 return next??{message:{role:'assistant',content:'Review your proposal, then Apply.'}};
};
OllamaRuntime.prototype.streamChat=async function(body){return this.call('chat',body);};
const {SpeechRuntime}=require(path.join(root,'dist/main/speech.js'));
SpeechRuntime.prototype.start=async function(){this.status={state:'ready',message:'Fixture ASR'};return this.status;};
SpeechRuntime.prototype.transcribe=async function(){await new Promise(resolve=>setTimeout(resolve,700));return {text:'this one should end at 7 AM'};};
require(path.join(root,'dist/main/index.js'));
