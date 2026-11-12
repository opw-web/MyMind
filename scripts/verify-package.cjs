const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),target=process.env.MYMIND_PACKAGE_ROOT||path.join(root,'release','win-unpacked');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
function files(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):[path.join(directory,entry.name)]);}
async function hash(file){const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
(async()=>{
  let verified=0;
  for(const [source,destination] of [[path.join(root,'dist'),path.join(target,'resources','app','dist')],[path.join(root,'speech-runtime'),path.join(target,'resources','speech')]]){
    const sources=files(source),destinations=files(destination);assert.equal(destinations.length,sources.length);
    for(const file of sources){const copied=path.join(destination,path.relative(source,file));assert.equal(await hash(copied),await hash(file),`Mismatched ${path.relative(source,file)}`);verified++;}
  }
  assert.equal(await hash(path.join(target,'MYMIND.exe')),await hash(path.join(root,'node_modules','electron','dist','electron.exe')));
  assert.equal(await hash(path.join(target,'resources','speech','python','python.exe')),await hash(path.join(process.env.LOCALAPPDATA,'Programs','Python','Python312','python.exe')));
  assert.equal(fs.existsSync(path.join(target,'resources','speech','preview-model')),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target,'resources','app','package.json'),'utf8')).version,version);
  const manifest=JSON.parse(fs.readFileSync(path.join(target,'resources','speech','manifest.json'),'utf8'));
  assert.equal(manifest.models.length,2);assert.equal(manifest.models[0].repo,'vokasug/faster-whisper-large-v3-turbo-int8');
  const report={passed:true,target,verifiedFiles:verified,version,electronUnmodified:true,pythonUnmodified:true,previewModelBundled:true};
  fs.writeFileSync(path.join(root,'test-results','manual-package-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
