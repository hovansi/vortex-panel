// Decode a deep-link ID once, then require an exact match in the authorized
// inventory. Encoded path separators must never create a different route.
export function resolveServerRouteId(value,servers){
 let id;try{id=decodeURIComponent(String(value??''));}catch{return null;}
 if(!id||/[\\/\s?#\u0000-\u001f\u007f]/.test(id))return null;
 return (servers||[]).some(server=>server.id===id)?id:null;
}
