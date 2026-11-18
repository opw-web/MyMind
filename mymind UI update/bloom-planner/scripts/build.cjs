const fs=require('fs');const path=require('path');
let ts;try{ts=require('typescript')}catch(e){try{ts=require('/usr/local/slides_js/node_modules/typescript')}catch(x){console.error('Install typescript with npm install to rebuild source.');process.exit(1)}}
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'src/app.tsx'),'utf8');
const result=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2019,module:ts.ModuleKind.None,removeComments:false,strict:false},reportDiagnostics:true});
if(result.diagnostics?.some(x=>x.category===1)){console.log(ts.formatDiagnosticsWithColorAndContext(result.diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:x=>x,getNewLine:()=> '\n'}));process.exit(1)}
fs.writeFileSync(path.join(root,'dist/app.js'),result.outputText);
fs.copyFileSync(path.join(root,'src/style.css'),path.join(root,'dist/style.css'));
// Also emit a self-contained HTML file for sharing with agents or opening offline.
const css=fs.readFileSync(path.join(root,'dist/style.css'),'utf8');
const react=fs.readFileSync(path.join(root,'dist/vendor/react.min.js'),'utf8');
const reactDOM=fs.readFileSync(path.join(root,'dist/vendor/react-dom.min.js'),'utf8');
const app=fs.readFileSync(path.join(root,'dist/app.js'),'utf8');
const escapeScript=(x)=>x.replace(/<\/script/gi,'<\\/script');
const html='<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#FFF8F0"><meta name="description" content="Bloom Planner: one calendar, hierarchical tasks and simulated local AI, entirely offline"><title>Bloom Planner · One calendar</title><style>'+css+'</style></head><body><div id="root"></div><script>'+escapeScript(react)+'</script><script>'+escapeScript(reactDOM)+'</script><script>'+escapeScript(app)+'</script></body></html>';
fs.writeFileSync(path.join(root,'Bloom-Planner-Demo.html'),html);
console.log('Bloom Planner compiled successfully. Open Bloom-Planner-Demo.html or dist/index.html offline.');
