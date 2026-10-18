import {uiHTML,getLanguage} from './i18n.js';
const snapshots=new WeakMap();
let frame=0,timer=0,latest=null,lastPaint=0;
// At most 20 DOM commits/second, even when Bedrock floods stdout. The latest
// bounded model is rendered; intermediate network events do not become a queue.
export function queueConsolePaint(callback){
  latest=callback;if(frame||timer)return;
  const paint=()=>{timer=0;frame=requestAnimationFrame(()=>{frame=0;lastPaint=performance.now();const next=latest;latest=null;next?.();});};
  const delay=Math.max(0,50-(performance.now()-lastPaint));if(delay)timer=setTimeout(paint,delay);else paint();
}
export function paintConsole(element,rows,markup,{preview,follow,filter,serverId,runId}){
  const previous=snapshots.get(element),language=getLanguage(),top=element.scrollTop,nearBottom=element.scrollHeight-element.clientHeight-top<60;
  const occurrences=new Map(),keys=rows.map(row=>{const base=row.id||`${row.time}|${row.level}|${row.message}`;const index=occurrences.get(base)||0;occurrences.set(base,index+1);return `${base}|${index}`;});
  const reset=!previous||!previous.keys.length||previous.language!==language||previous.serverId!==serverId||previous.runId!==runId||previous.preview!==preview||previous.filter!==filter;
  if(reset||!rows.length){uiHTML(element,markup(rows));snapshots.set(element,{keys,language,serverId,runId,preview,filter});}
  else{
    const oldNodes=new Map(previous.keys.map((key,index)=>[key,element.children[index]])),wanted=new Set(keys);
    for(const [key,node] of oldNodes)if(!wanted.has(key))node?.remove();
    const missing=keys.map((key,index)=>({key,row:rows[index]})).filter(({key})=>!oldNodes.has(key));
    if(missing.length){const holder=document.createElement('div');uiHTML(holder,markup(missing.map(({row})=>row)));for(let index=0;index<missing.length;index++)oldNodes.set(missing[index].key,holder.children[index]);}
    let cursor=element.firstElementChild;
    for(let index=0;index<keys.length;index++){
      const key=keys[index],node=oldNodes.get(key);
      if(node===cursor)cursor=cursor.nextElementSibling;else element.insertBefore(node,cursor);
    }
    snapshots.set(element,{keys,language,serverId,runId,preview,filter});
  }
  if(preview||follow&&nearBottom)element.scrollTop=element.scrollHeight;else element.scrollTop=top;
}
export function appendBoundedLog(state,row){
  if(state._logArray!==state.logs){state._logArray=state.logs;state._logBytes=state.logs.reduce((sum,item)=>sum+String(item.message||'').length*2+160,0);}
  state.logs.push(row);state._logBytes+=String(row.message||'').length*2+160;
  while(state.logs.length>500||state._logBytes>1024**2){const removed=state.logs.shift();state._logBytes-=String(removed.message||'').length*2+160;}
}
