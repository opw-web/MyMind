class DictationPCM extends AudioWorkletProcessor {
  constructor(){super();this.phase=0;this.sum=0;this.count=0;this.block=new Float32Array(1600);this.at=0;}
  process(inputs,outputs){
    const samples=inputs[0]?.[0];
    if(samples)for(const sample of samples){
      this.sum+=sample;this.count++;this.phase+=16000;
      if(this.phase>=sampleRate){
        this.phase-=sampleRate;this.block[this.at++]=this.sum/this.count;this.sum=0;this.count=0;
        if(this.at===this.block.length){this.port.postMessage(this.block,[this.block.buffer]);this.block=new Float32Array(1600);this.at=0;}
      }
    }
    for(const output of outputs)for(const channel of output)channel.fill(0);
    return true;
  }
}
registerProcessor('dictation-pcm',DictationPCM);
