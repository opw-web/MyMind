const fs=require('node:fs'),crypto=require('node:crypto');
function wavData(file){
  const wav=fs.readFileSync(file);let sampleRate=0,bytesPerSecond=0;
  for(let at=12;at+8<=wav.length;){
    const size=wav.readUInt32LE(at+4),kind=wav.toString('ascii',at,at+4);
    if(kind==='fmt '){sampleRate=wav.readUInt32LE(at+12);bytesPerSecond=wav.readUInt32LE(at+16);}
    if(kind==='data')return {wav,pcm:wav.subarray(at+8,at+8+size),sampleRate,seconds:size/bytesPerSecond};
    at+=8+size+(size%2);
  }
  throw new Error('No WAV audio');
}
function audioInput(file){const data=fs.readFileSync(file);return {audio:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),mimeType:'audio/wav',requestId:crypto.randomUUID()};}
function silentInput(){
  const data=Buffer.alloc(44+32000);data.write('RIFF',0);data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(16000,24);data.writeUInt32LE(32000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(32000,40);
  return {audio:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),mimeType:'audio/wav',requestId:crypto.randomUUID()};
}
module.exports={audioInput,silentInput,wavData};