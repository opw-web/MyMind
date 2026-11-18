import {useCallback,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {DEFAULT_ASSISTANT_CONTEXT,type RuntimeStatus} from '../shared/model';

type ModelSettings=Awaited<ReturnType<Window['planner']['runtimeSettings']>>;
const contextSteps=[4096,8192,16384,32768,65536,131072,262144];
const formatContext=(tokens:number)=>`${(tokens/1024).toLocaleString(undefined,{maximumFractionDigits:1})}k`;
const errorMessage=(error:unknown)=>(error instanceof Error?error.message:String(error))
  .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');

export default function BloomSettings({status,chatBusy,children}:{status:RuntimeStatus|null;chatBusy:boolean;children:ReactNode}){
  const [settings,setSettings]=useState<ModelSettings>();
  const [modelDraft,setModelDraft]=useState<string>();
  const [contextDraft,setContextDraft]=useState<number>();
  const [working,setWorking]=useState<'refresh'|'apply'>();
  const [error,setError]=useState('');
  const [verificationFailed,setVerificationFailed]=useState(false);
  const inFlight=useRef(false);
  const heading=useRef<HTMLHeadingElement>(null);
  const contextId=useId();
  const loading=status?.state==='starting'||status?.state==='loading';
  const model=modelDraft??settings?.model??status?.model??'';
  const context=contextDraft??settings?.context??DEFAULT_ASSISTANT_CONTEXT;
  const closestStep=contextSteps.reduce((best,value,index)=>Math.abs(Math.log2(context/value))<Math.abs(Math.log2(context/contextSteps[best]))?index:best,0);

  const refresh=useCallback(async()=>{
    if(inFlight.current)return;
    inFlight.current=true;
    setWorking('refresh');setError('');
    try{
      setSettings(await window.planner.runtimeSettings());
      setVerificationFailed(false);
    }catch(error){setVerificationFailed(true);setError(errorMessage(error));}
    finally{inFlight.current=false;setWorking(undefined);}
  },[]);

  useEffect(()=>{heading.current?.focus();},[]);
  useEffect(()=>{if(!loading)void refresh();},[loading,status?.model,refresh]);

  async function apply(){
    if(inFlight.current||chatBusy||loading||!settings?.models.includes(model))return;
    inFlight.current=true;
    setWorking('apply');setError('');
    try{
      await window.planner.configureRuntime({model,context});
      setModelDraft(undefined);setContextDraft(undefined);
      setSettings(await window.planner.runtimeSettings());
      setVerificationFailed(false);
    }catch(error){
      setError(errorMessage(error));
      try{setSettings(await window.planner.runtimeSettings());setVerificationFailed(false);}
      catch{setVerificationFailed(true);}
    }
    finally{inFlight.current=false;setWorking(undefined);}
  }

  const loadedContext=settings?.activeContext;
  const loaded=!loading&&!verificationFailed&&status?.state==='ready'&&status.model===settings?.model&&loadedContext!=null;
  const statusLabel=working==='apply'?'Reloading':loading?'Loading':status?.state==='error'||status?.state==='stopped'?'Not loaded':verificationFailed?'Status unavailable':loaded?'Loaded':settings?'Not loaded':'Checking';
  const disabled=!!working||loading||chatBusy;
  return <section className="bloom-local-settings" id="bloom-local-settings" role="dialog" aria-label="Settings">
    <h2 tabIndex={-1} ref={heading}>Settings</h2>
    <div className="bloom-model-status" role="status">
      <span className={loaded?'model-state model-loaded':'model-state'}>{statusLabel}</span>
      {loaded&&<span>{settings?.model} · {loadedContext.toLocaleString()} active tokens</span>}
      {!loaded&&status?.state==='error'&&!error&&<span>{status.message}</span>}
    </div>
    <label className="bloom-model-field">Ollama model
      <select value={model} disabled={disabled||!settings?.models.length} onChange={event=>setModelDraft(event.target.value)}>
        {!settings?.models.includes(model)&&<option value={model} disabled>{model||'Select an installed model'}</option>}
        {settings?.models.map(name=><option key={name} value={name}>{name}</option>)}
      </select>
    </label>
    {settings&&!settings.models.length&&<p className="bloom-settings-hint">No installed local models with tool support were found.</p>}
    <div className="bloom-context-setting">
      <label htmlFor={contextId}>Context length</label><output htmlFor={contextId}>{formatContext(context)}</output>
      <p className="bloom-settings-hint" id={`${contextId}-hint`}>How much of the conversation Ollama can use. Larger windows use more memory.</p>
      <input id={contextId} type="range" min={0} max={contextSteps.length-1} step={1} value={closestStep}
        aria-valuetext={`${contextSteps[closestStep].toLocaleString()} tokens`} aria-describedby={`${contextId}-hint`} disabled={disabled||!settings}
        onChange={event=>setContextDraft(contextSteps[Number(event.target.value)])}/>
      <div className="bloom-context-scale" aria-hidden="true">{contextSteps.map(value=><span key={value}>{formatContext(value)}</span>)}</div>
    </div>
    {error&&!loading&&<p className="bloom-settings-error" role="alert">{error}</p>}
    <div className="bloom-settings-actions">
      <button type="button" className="btn btn-outline" disabled={!!working} onClick={()=>void refresh()}>{working==='refresh'?'Refreshing…':'Refresh'}</button>
      <button type="button" className="btn btn-primary" disabled={disabled||!settings?.models.includes(model)} onClick={()=>void apply()}>{working==='apply'?'Reloading…':'Apply and reload'}</button>
    </div>
    {children}
  </section>;
}
