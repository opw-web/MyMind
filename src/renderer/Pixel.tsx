/** Pixel-art mascots from the Bloom design language. Crisp edges are intentional. */
export function PixelFlower({size=34,className}:{size?:number;className?:string}){
  return <svg className={className} width={size} height={size} viewBox="0 0 32 32" shapeRendering="crispEdges" aria-hidden="true">
    <path fill="#548066" d="M15 18h3v12h-3zM10 25h5v3h-5zM18 22h6v3h-6z"/>
    <path fill="#F1B6C0" d="M13 2h7v5h-7zM7 8h6v6H7zM20 8h6v6h-6zM11 15h11v5H11z"/>
    <path fill="#D98E9A" d="M10 5h4v4h-4zM19 5h4v4h-4zM5 12h6v5H5zM22 12h5v5h-5z"/>
    <rect x="13" y="9" width="7" height="7" fill="#FFE8A5"/>
    <rect x="16" y="11" width="2" height="2" fill="#C78D56"/>
  </svg>;
}

export function PixelCat({size=48,happy=false,label,className}:{size?:number;happy?:boolean;label?:string;className?:string}){
  return <svg className={className} width={size} height={size} viewBox="0 0 48 48" shapeRendering="crispEdges" role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:true}>
    <path d="M6 12h6V6h7v6h10V6h7v6h6v22h-5v6H11v-6H6z" fill="#E6A16D"/>
    <path d="M9 10h5v7H9zm23 0h4v7h-4z" fill="#F5D0B5"/>
    <path d="M8 28h32v7H8z" fill="#F2BC90"/>
    <path d="M15 13h4v4h-4zm14 0h4v4h-4zM22 8h4v6h-4z" fill="#B96F48"/>
    <path d="M15 23h5v4h-5zm14 0h5v4h-5z" fill="#553F35"/>
    <path d="M22 27h5v3h-5z" fill="#D27E81"/>
    <path d={happy?'M17 32h4v2h-4zm11 0h4v2h-4z':'M19 32h3v2h-3zm6 0h3v2h-3z'} fill="#A66A53"/>
    <rect x="8" y="27" width="5" height="3" fill="#ECA6A0"/>
    <rect x="36" y="27" width="5" height="3" fill="#ECA6A0"/>
    <path d="M3 29h10m23 0h9M4 32h9m23 0h8" stroke="#91614D" strokeWidth="1"/>
  </svg>;
}
