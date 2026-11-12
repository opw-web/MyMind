import {PixelCat} from './Pixel';

export type OrbState='breathing'|'listening'|'working'|'composing'|'solving'|'searching'|'weaving';

/** The assistant's presence: the Bloom pixel cat, animated by CSS per state. */
export default function CommandOrb({state='breathing',size=28,label}:{state?:OrbState;size?:number;label?:string}){
  return <span className={'command-orb orb-'+state} role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:true}><PixelCat size={size} happy={state==='composing'||state==='breathing'}/></span>;
}
