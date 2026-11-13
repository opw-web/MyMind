import {DictationDraft,SpeechProgress} from '../shared/model';
import {LiveTranscript} from './live-transcript';

type Phase='idle'|'starting'|'listening'|'finishing'|'failed'|'review';
export type DictationState={phase:Phase;caption:string;error:string;level:number;seconds:number;lag:number;unsaved:boolean;draft?:DictationDraft;drafts:DictationDraft[];text:string;textVersion:number;finalProgress:string};
type Capture={draft?:DictationDraft;stream?:MediaStream;context?:AudioContext;source?:MediaStreamAudioSourceNode;worklet?:AudioWorkletNode;recorder?:MediaRecorder;stopped?:Promise<void>;timer?:ReturnType<typeof setInterval>;started:number;stopping:boolean;pending:{sequence:number;blob:Blob;seconds:number}[];nextSequence:number;saving?:Promise<void>;flushing?:Promise<void>;pcm:Float32Array;frames:number;previewId?:string;previewPromise?:Promise<void>;lastPreview:number;previewSequence:number;merger:LiveTranscript;};
const append=(prefix:string,text:string)=>[prefix.trim(),text.trim()].filter(Boolean).join(' ');
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
const active=(phase:Phase)=>phase==='starting'||phase==='listening'||phase==='finishing';

class DictationSession {
  private state:DictationState={phase:'idle',caption:'',error:'',level:0,seconds:0,lag:0,unsaved:false,drafts:[],text:'',textVersion:0,finalProgress:''};
  private listeners=new Set<()=>void>();
  private capture?:Capture;
  private generation=crypto.randomUUID();
  private operation=0;
  private initialized=false;
  private request?:string;
  private requestSequence=0;
  private edits=0;
  private metadata:Promise<void>=Promise.resolve();
  getSnapshot=()=>this.state;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private update(patch:Partial<DictationState>){this.state={...this.state,...patch};for(const fn of this.listeners)fn();}
  private publish(text:string){this.update({text,textVersion:this.state.textVersion+1});}
  private fail(e:unknown,caption='Your dictation is retained. Retry transcription or review the live text.'){this.update({error:errorText(e),caption});}
  initialize(){
    if(this.initialized)return;this.initialized=true;
    window.planner.onSpeechProgress(event=>this.progress(event));
    window.planner.onPrepareClose(async()=>{await this.cancel();await this.metadata;});
    void this.refresh();
  }
  async refresh(){try{this.update({drafts:await window.planner.listDictations()});}catch(e){this.fail(e,'Could not read saved dictations.');}}
  private checkpoint(input:{draftId:string;generation:string;liveText?:string;reviewText?:string;seconds?:number}){
    const editVersion=this.edits,textVersion=this.state.textVersion;
    const pending=this.metadata.then(async()=>{
      const draft=await window.planner.checkpointDictation(input);
      if(this.state.draft?.id===draft.id&&this.state.draft.generation===draft.generation)this.update({draft:this.edits===editVersion&&this.state.textVersion===textVersion?draft:{...draft,liveText:this.state.draft.liveText,reviewText:this.state.draft.reviewText}});
    });
    this.metadata=pending.catch(e=>{this.fail(e,'Could not save your transcript. Your captured audio and visible text are retained.');});
    return pending;
  }
  edit(text:string){
    this.edits++;this.update({text});const draft=this.state.draft;if(!draft||active(this.state.phase))return;
    this.update({draft:{...draft,reviewText:text}});
    void this.checkpoint({draftId:draft.id,generation:draft.generation,reviewText:text}).catch(()=>{});
  }
  private release(c:Capture){
    clearInterval(c.timer);c.worklet?.disconnect();c.source?.disconnect();
    c.stream?.getTracks().forEach(track=>track.stop());
    if(c.context&&c.context.state!=='closed')void c.context.close().catch(()=>{});
    c.pcm=new Float32Array(0);
  }
  private async saveChunks(c:Capture):Promise<void>{
    if(c.saving)return c.saving;
    const task=(async()=>{
      while(c.pending.length){
        const chunk=c.pending[0],draft=c.draft;
        if(!draft)throw new Error('The recording draft was not created.');
        const audio=await chunk.blob.arrayBuffer();
        await window.planner.appendDictation({draftId:draft.id,generation:draft.generation,sequence:chunk.sequence,audio,seconds:chunk.seconds});
        c.pending.shift();if(this.capture===c)this.update({unsaved:c.pending.length>0});
      }
    })();
    c.saving=task;
    try{await task;}finally{if(c.saving===task)c.saving=undefined;}
  }
  async start(prefix:string){
    if(active(this.state.phase))return;
    await this.metadata;
    if(this.capture?.pending.length){this.fail(new Error('Save the retained recording before starting another.'));return;}
    const c:Capture={started:performance.now(),stopping:false,pending:[],nextSequence:0,pcm:new Float32Array(0),frames:0,lastPreview:0,previewSequence:0,merger:new LiveTranscript()};
    this.capture=c;this.operation++;this.request=undefined;
    this.update({phase:'starting',caption:'Opening your microphone…',error:'',seconds:0,lag:0,finalProgress:'',draft:undefined,text:prefix,unsaved:false});
    void window.planner.startSpeech().catch(e=>{if(this.capture===c&&!c.stopping)this.fail(e,'Speech is unavailable. Your recording is still being saved.');});
    try{
      c.draft=await window.planner.createDictation({generation:this.generation,prefix});
    }catch(e){
      this.release(c);
      if(this.capture===c&&!c.stopping){this.update({phase:'failed'});this.fail(e,'Could not prepare the dictation draft.');}
      return;
    }
    if(c.stopping||this.capture!==c)return;
    this.update({draft:c.draft});void this.refresh();
    if(!MediaRecorder.isTypeSupported('audio/webm;codecs=opus')){this.release(c);if(this.capture===c&&!c.stopping){this.update({phase:'failed'});this.fail(new Error('WebM recording is unavailable.'),'WebM recording is unavailable. Reinstall MYMIND.');}return;}
    try{
      c.context=new AudioContext({sampleRate:16000});await c.context.resume();
    }catch(e){
      this.release(c);
      if(this.capture===c&&!c.stopping){this.update({phase:'failed'});this.fail(e,'Audio recording is unavailable in this environment.');}
      return;
    }
    if(c.stopping||this.capture!==c){this.release(c);return;}
    try{
      c.stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    }catch(e){
      this.release(c);
      if(this.capture===c&&!c.stopping){this.update({phase:'failed'});this.fail(e,'Could not open the microphone. Any existing draft is retained.');}
      return;
    }
    if(c.stopping||this.capture!==c){this.release(c);return;}
    try{
      const recorder=new MediaRecorder(c.stream,{mimeType:'audio/webm;codecs=opus',audioBitsPerSecond:64000});c.recorder=recorder;
      c.stopped=new Promise(resolve=>{recorder.onstop=()=>resolve();});
      recorder.ondataavailable=event=>{
        if(!event.data.size)return;
        this.update({unsaved:true});c.pending.push({sequence:c.nextSequence++,blob:event.data,seconds:(performance.now()-c.started)/1000});
        void this.saveChunks(c).catch(e=>{
          this.fail(e,'Could not save audio. Recording has stopped; unsaved chunks remain available to retry.');
          if(!c.stopping)void this.stop(false).then(()=>this.update({phase:'failed'}));
        });
      };
      recorder.onerror=event=>{const e=(event as Event&{error?:DOMException}).error||new Error('The recorder failed.');void this.recordingFailed(c,e);};
      for(const track of c.stream.getAudioTracks())track.onended=()=>{if(!c.stopping)void this.recordingFailed(c,new Error('Your microphone was disconnected.'));};
      c.source=c.context.createMediaStreamSource(c.stream);
      const analyser=c.context.createAnalyser(),mute=c.context.createGain();analyser.fftSize=256;mute.gain.value=0;
      c.source.connect(analyser);analyser.connect(mute);mute.connect(c.context.destination);
      recorder.start(1000);c.started=performance.now();
      this.update({phase:'listening',caption:'Recording… press Stop when you’re finished.'});
      const samples=new Float32Array(analyser.fftSize);
      c.timer=setInterval(()=>{
        if(c.stopping||this.capture!==c)return;
        analyser.getFloatTimeDomainData(samples);let sum=0;for(const value of samples)sum+=value*value;
        const seconds=Math.floor((performance.now()-c.started)/1000);
        this.update({seconds,level:Math.min(1,Math.sqrt(sum/samples.length)*10),lag:c.frames/16000-c.lastPreview});
        if(!c.previewPromise&&c.frames>=16000*2)void this.preview(c);
      },200);
      try{
        await c.context.audioWorklet.addModule(new URL('pcm-worklet.js',document.baseURI).href);
        if(c.stopping||this.capture!==c)return;
        c.worklet=new AudioWorkletNode(c.context,'dictation-pcm');
        c.worklet.port.onmessage=event=>{
          if(c.stopping||this.capture!==c)return;
          const data=new Float32Array(event.data),buffer=new Float32Array(Math.min(16000*24,c.pcm.length+data.length));
          const keep=Math.min(c.pcm.length,buffer.length-data.length);
          buffer.set(c.pcm.subarray(c.pcm.length-keep));buffer.set(data,keep);c.pcm=buffer;c.frames+=data.length;
        };
        c.source.connect(c.worklet);c.worklet.connect(c.context.destination);
      }catch(e){if(!c.stopping)this.fail(e,'Live text is unavailable. Your complete recording is still being saved.');}
    }catch(e){
      this.release(c);
      if(this.capture===c&&!c.stopping){this.update({phase:'failed'});this.fail(e,'The recorder could not start. Any existing draft is retained.');}
    }
  }
  private async preview(c:Capture){
    if(c.stopping||this.capture!==c||!c.draft||c.frames/16000-c.lastPreview<1)return;
    const draft=c.draft,end=c.frames/16000,offset=(c.frames-c.pcm.length)/16000;
    c.previewId=crypto.randomUUID();const id=c.previewId,sequence=++c.previewSequence;
    const pending=(async()=>{
      try{
        const result=await window.planner.previewSpeech({draftId:draft.id,generation:draft.generation,requestId:id,sequence,pcm:c.pcm.slice().buffer as ArrayBuffer,sampleRate:16000,offset});
        if(this.capture!==c||c.stopping||c.previewId!==id)return;
        const liveText=c.merger.merge(result.words,offset);
        c.lastPreview=end;
        if(liveText){
          const text=append(draft.prefix,liveText);
          this.update({draft:{...this.state.draft!,liveText,reviewText:text},caption:'Recording… press Stop when you’re finished.'});this.publish(text);
          await this.checkpoint({draftId:draft.id,generation:draft.generation,liveText,reviewText:text,seconds:end});
        }
      }catch(e){if(this.capture===c&&!c.stopping)this.fail(e,'Live text is behind or unavailable. Audio is still being saved.');}
      finally{if(c.previewId===id)c.previewId=undefined;}
    })();
    c.previewPromise=pending;await pending;if(c.previewPromise===pending)c.previewPromise=undefined;
  }
  async stop(transcribe=true){
    const c=this.capture;
    if(!c)return;
    if(c.stopping){await c.flushing?.catch(()=>{});return;}
    const operation=this.operation;
    c.stopping=true;clearInterval(c.timer);
    this.update({phase:'finishing',level:0,caption:'Saving the last audio chunk…'});
    const flushing=(async()=>{
      if(c.previewId)await window.planner.cancelSpeech(c.previewId);
      if(c.recorder&&c.recorder.state!=='inactive')c.recorder.stop();
      if(c.stopped)await c.stopped;
      this.release(c);await c.previewPromise;await this.saveChunks(c);await this.metadata;
      if(c.draft){
        const local=this.state.draft;
        if(local?.id===c.draft.id)await this.checkpoint({draftId:local.id,generation:local.generation,liveText:local.liveText,reviewText:this.state.textVersion?this.state.text:local.reviewText,seconds:(performance.now()-c.started)/1000});
        const draft=await window.planner.getDictation(c.draft.id);c.draft=draft;
        if(this.capture===c)this.update({draft});
      }
    })();
    c.flushing=flushing;
    try{
      await flushing;
      if(this.capture!==c)return;
      this.update({phase:'review',caption:'Draft saved locally. Review it or retry transcription.'});void this.refresh();
      if(transcribe&&operation===this.operation&&c.draft?.bytes)await this.transcribe();
    }catch(e){this.release(c);if(this.capture===c){this.update({phase:'failed'});this.fail(e,'Your recording is retained. Retry saving and transcription.');}}
  }
  private async recordingFailed(c:Capture,e:unknown){
    if(c.stopping||this.capture!==c)return;await this.stop(false);
    if(this.capture===c){this.update({phase:'failed'});this.fail(e,'Recording stopped unexpectedly. Captured audio and text are retained.');}
  }
  async transcribe(){
    if(this.request||this.state.phase==='listening'||this.state.phase==='starting')return;
    const draft=this.state.draft;if(!draft)return;
    const token=++this.operation,editVersion=this.edits,id=crypto.randomUUID(),sequence=++this.requestSequence;
    this.request=id;this.update({phase:'finishing',caption:'Transcribing your recording… Live text stays below.',finalProgress:'',error:''});
    try{
      if(this.capture?.pending.length)await this.saveChunks(this.capture);
      await this.metadata;
      const result=await window.planner.transcribeDictation({draftId:draft.id,generation:draft.generation,requestId:id,sequence});
      if(this.operation!==token||this.request!==id)return;
      const saved=await window.planner.getDictation(draft.id);
      if(this.operation!==token||this.request!==id)return;
      this.update({draft:saved,phase:result.text.trim()?'review':'failed',caption:result.text.trim()?'Transcript ready. Review it, then press Send.':'No speech found in the final pass. Your live text and recording are retained.'});
      if(result.text.trim()&&this.edits===editVersion)this.publish(saved.reviewText);
      void this.refresh();
    }catch(e){if(this.operation===token&&this.request===id){this.update({phase:'failed'});this.fail(e);}}
    finally{if(this.request===id)this.request=undefined;}
  }
  private progress(event:SpeechProgress){
    const draft=this.state.draft;
    if(this.request!==event.requestId||draft?.id!==event.draftId||draft.generation!==event.generation||event.sequence!==this.requestSequence)return;
    this.update({finalProgress:event.text,caption:'Transcribing… '+Math.floor(event.seconds)+' seconds processed. Live text is retained.'});
  }
  async cancel(){
    this.operation++;const id=this.request;this.request=undefined;if(id)await window.planner.cancelSpeech(id);
    if(this.capture&&!this.capture.stopping)await this.stop(false);
    else if(this.capture){await this.capture.flushing?.catch(()=>{});this.release(this.capture);if(this.capture.pending.length)try{await this.saveChunks(this.capture);}catch(e){this.fail(e,'Could not save the remaining audio. Retry saving this draft.');}}
    await this.metadata;
    this.update({phase:this.capture?.pending.length?'failed':this.state.draft?'review':'idle',level:0,caption:this.capture?.pending.length?'Audio could not be saved. Retained chunks are available to retry.':'Dictation stopped. Your draft is saved locally.'});void this.refresh();
  }
  async detach(){
    await this.cancel();if(this.capture?.pending.length)throw new Error('Some captured audio could not be saved. Retry saving before starting a new chat.');this.capture=undefined;this.generation=crypto.randomUUID();
    this.update({draft:undefined,phase:'idle',caption:'',finalProgress:'',seconds:0,error:''});void this.refresh();
  }
  async restore(id:string,currentText:string){
    if(active(this.state.phase))await this.cancel();
    if(this.state.draft)await this.detach();
    else if(currentText.trim()){
      const saved=await window.planner.createDictation({generation:crypto.randomUUID(),prefix:currentText});
      await window.planner.checkpointDictation({draftId:saved.id,generation:saved.generation,reviewText:currentText});
    }
    await this.metadata;this.generation=crypto.randomUUID();
    const draft=await window.planner.restoreDictation({draftId:id,generation:this.generation});
    this.capture=undefined;this.update({draft,phase:'review',caption:'Recovered draft. Review it before Send.',seconds:Math.floor(draft.seconds),error:'',finalProgress:''});this.publish(draft.reviewText||append(draft.prefix,draft.finalText||draft.liveText));void this.refresh();
  }
  async discard(id=this.state.draft?.id){
    if(!id)return;
    if(this.state.draft?.id===id){await this.cancel();this.capture=undefined;this.update({draft:undefined,phase:'idle',caption:'Draft discarded.',finalProgress:''});}
    await this.metadata;await window.planner.discardDictation(id);await this.refresh();
  }
  async sent(id:string,generation:string,text:string){await this.metadata;const saved=await window.planner.getDictation(id);if(saved.generation!==generation||saved.reviewText.trim()!==text.trim())return;if(this.state.draft?.id===id){this.capture=undefined;this.update({draft:undefined,phase:'idle',caption:'',finalProgress:''});}await window.planner.discardDictation(id);await this.refresh();}
  async useVersion(kind:'live'|'final'){
    await this.cancel();const draft=this.state.draft;if(!draft)return;
    const text=append(draft.prefix,kind==='live'?draft.liveText:draft.finalText);
    this.publish(text);this.edit(text);
  }
}
export const dictationSession=new DictationSession();
export const dictationActive=active;
