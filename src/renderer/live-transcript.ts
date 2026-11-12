import {SpeechWord} from '../shared/model';
const normalized=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
// Absolute word times let overlapping windows revise the tail without repeating
// the complete transcript, including genuine repeated words.
export class LiveTranscript {
  words:SpeechWord[]=[];
  merge(incoming:SpeechWord[],offset:number):string{
    if(!incoming.length)return this.text;
    let best:{old:number;next:number;length:number;distance:number}|undefined;
    const first=this.words.findIndex(w=>w.end>=offset-1),start=Math.max(0,first);
    for(let i=start;i<this.words.length;i++)for(let j=0;j<Math.min(15,incoming.length);j++){
      const distance=Math.abs(this.words[i].start-incoming[j].start);
      if(distance>1.2||!normalized(incoming[j].text))continue;
      let length=0;while(i+length<this.words.length&&j+length<incoming.length&&normalized(this.words[i+length].text)===normalized(incoming[j+length].text))length++;
      if(length>=2&&(!best||length>best.length||length===best.length&&distance<best.distance))best={old:i,next:j,length,distance};
    }
    if(best)this.words=[...this.words.slice(0,best.old),...incoming.slice(best.next)];
    else{
      const prefix=this.words.filter(w=>w.end<=incoming[0].start+0.05);
      this.words=[...prefix,...incoming];
    }
    return this.text;
  }
  get text(){return this.words.map(w=>w.text.trim()).filter(Boolean).join(' ');}
}
