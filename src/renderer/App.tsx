import React from 'react';
import Workspace from './Workspace';

export function Icon({name,size=18,stroke=1.8}:{name:string;size?:number;stroke?:number}) {
  const paths:Record<string,React.ReactNode> = {
    plus:<path d="M12 5v14M5 12h14"/>, close:<path d="M5 5l14 14M19 5 5 19"/>, left:<path d="m14 5-7 7 7 7"/>, right:<path d="m10 5 7 7-7 7"/>, down:<path d="m6 9 6 6 6-6"/>, up:<path d="m6 15 6-6 6 6"/>,
    undo:<path d="M9 4 4 9l5 5M4 9h9a7 7 0 0 1 0 14"/>,
    calendar:<><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M7.5 3v4M16.5 3v4M3.5 10h17M8 14h3v3H8z"/></>,
    tasks:<><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m7.5 9 1.5 1.5 2.5-3M13 9h4M7.5 15l1.5 1.5 2.5-3M13 15h4"/></>,
    spark:<path d="m12 2 2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2Z"/>,
    arrow:<path d="M5 12h14m-6-6 6 6-6 6"/>, pause:<path d="M9 5v14m6-14v14"/>, send:<path d="m3 11 18-8-8 18-2-8-8-2ZM11 13l10-10"/>, edit:<path d="M12 20h9M16 4l4 4-11 11-5 1 1-5L16 4Z"/>,
    trash:<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>, check:<path d="m4 12 5 5L20 6"/>,
    grip:<><circle cx="9" cy="6" r=".8"/><circle cx="15" cy="6" r=".8"/><circle cx="9" cy="12" r=".8"/><circle cx="15" cy="12" r=".8"/><circle cx="9" cy="18" r=".8"/><circle cx="15" cy="18" r=".8"/></>,
    clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></>,
    filter:<><path d="M4 7h16M7 12h10M10 17h4"/><circle cx="8" cy="7" r="2" fill="currentColor" stroke="none"/></>,
    mic:<><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></>,
    more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    link:<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/>,
    flower:<><circle cx="12" cy="12" r="2"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/></>,
    settings:<><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2.1 2.1M16.9 16.9 19 19M19 5l-2.1 2.1M7.1 16.9 5 19"/></>,
    folder:<path d="M3 7V5h7l2 2h9v12H3V7Z"/>, chevron:<path d="m9 5 7 7-7 7"/>,
    chat:<path d="M4 5h16v11H9l-5 4V5Z"/>, info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.spark}</svg>;
}

export default Workspace;
