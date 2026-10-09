const {build,Platform,Arch}=require('electron-builder');
const {WineVmManager}=require('app-builder-lib/out/vm/WineVm');
const {UninstallerReader}=require('app-builder-lib/out/targets/nsis/nsisUtil');
const path=require('node:path');
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
build({targets:Platform.WINDOWS.createTarget('nsis',Arch.x64)}).catch(error=>{console.error(error);process.exit(1);});
