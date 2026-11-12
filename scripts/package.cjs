const {build,Platform,Arch}=require('electron-builder');
const {WineVmManager}=require('app-builder-lib/out/vm/WineVm');
const {UninstallerReader}=require('app-builder-lib/out/targets/nsis/nsisUtil');
const path=require('node:path');
const MsiTarget=require('app-builder-lib/out/targets/MsiTarget').default;
// LZX maximum compression is disproportionately slow for gigabytes of neural
// weights. MSZIP keeps a standard embedded-cab MSI with the same payload.
const originalMsiOptions=MsiTarget.prototype.getBaseOptions;
MsiTarget.prototype.getBaseOptions=async function(options){return {...await originalMsiOptions.call(this,options),compressionLevel:'mszip'};};
// Keep the Windows environment when the builder runs its temporary NSIS stub.
// If Windows cannot spawn that stub, use the builder's own static NSIS reader
// (also used for macOS packaging) to extract the same uninstaller artifact.
const original=WineVmManager.prototype.execWine;
WineVmManager.prototype.execWine=async function(input){
  if(process.platform==='win32'&&input.options?.env)input={...input,options:{...input.options,env:{...process.env,...input.options.env}}};
  try{return await original.call(this,input);}catch(error){
    if(process.platform!=='win32'||input.options?.env?.__COMPAT_LAYER!=='RunAsInvoker'||error.code!=='UNKNOWN')throw error;
    const uninstaller=path.join(path.dirname(input.file),`${path.basename(input.file,'exe')}__uninstaller.exe`);
    console.log('Extracting the NSIS uninstaller with electron-builder’s static reader.');
    await UninstallerReader.exec(input.file,uninstaller);
    return '';
  }
};
const target=process.argv[2]==='msi'?'msi':'nsis';
build({
  targets:Platform.WINDOWS.createTarget(target,Arch.x64),
  config:{
    afterPack({appOutDir}){
      // Check the packaged path directly so the workspace copy cannot hide a missing binary.
      const nativeModule=path.resolve(appOutDir,'resources/app/node_modules/@koromix/koffi-win32-x64');
      require(nativeModule);
    }
  }
}).catch(error=>{console.error(error);process.exit(1);});
