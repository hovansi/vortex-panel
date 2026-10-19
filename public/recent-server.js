const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);

// Store one server ID per account. Every lookup still uses the current inventory.
export function createRecentServer({storage}={}){
 let actor=null,recent=null;
 const key=userId=>`vortex-recent-server:${encodeURIComponent(userId)}`;
 function load(userId){
  if(!identifier(userId)){actor=null;recent=null;return false;}
  if(actor!==userId){actor=userId;try{recent=storage?.get(key(userId));}catch{recent=null;}if(!identifier(recent)){if(recent!==null&&recent!==undefined)try{storage?.remove(key(userId));}catch{}recent=null;}}
  return true;
 }
 return {
  remember(userId,serverId,servers){
   if(!load(userId)||!identifier(serverId)||!servers.some(server=>server.id===serverId))return false;
   recent=serverId;try{storage?.set(key(userId),serverId);}catch{}return true;
  },
  resolve(userId,servers){
   if(!load(userId))return servers[0]||null;
   const server=servers.find(item=>item.id===recent);
   if(server)return server;
   if(recent!==null){recent=null;try{storage?.remove(key(userId));}catch{}}
   return servers[0]||null;
  },
  reset(){actor=null;recent=null;},
 };
}
