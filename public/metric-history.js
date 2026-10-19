// Browser session history only. Points are supplied measurements, never seeded
// data. A gap can be a missing measurement or a locally observed stale state.
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export function sampleTime(value){if(typeof value==='number')return Number.isFinite(value)&&value>=0?value:null;if(typeof value!=='string'||!value)return null;const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;}
export function createMetricHistory({maxPoints=120,maxEntities=128,gapAfterMs=45000,transientGraceMs=15000}={}){
 if(!Number.isInteger(maxPoints)||maxPoints<2||maxPoints>240||!Number.isInteger(maxEntities)||maxEntities<1||maxEntities>512||!Number.isFinite(gapAfterMs)||gapAfterMs<1000||!Number.isFinite(transientGraceMs)||transientGraceMs<0||transientGraceMs>45000)throw new TypeError('Invalid bounded metric history options');
 const entries=new Map();
 function touch(key){const found=entries.get(key);if(found){entries.delete(key);entries.set(key,found);}return found;}
 function record(key,channels,{observedAt=Date.now(),model=null}={}){
  if(typeof key!=='string'||!key||key.length>512)return false;
  let entry=touch(key);if(!entry){entry={frames:[],last:new Map(),model:null,modelTime:null};entries.set(key,entry);while(entries.size>maxEntities)entries.delete(entries.keys().next().value);}
  const modelTime=sampleTime(model?.sampledAt),observationTime=sampleTime(observedAt),changed={};
  // Independent clocks matter: a fresh disk result may accompany an older CPU
  // snapshot. Keep current numeric values and the chart on the same accepted
  // source samples, rather than replacing the entire model before validation.
  if(model){if(!entry.model)entry.model={...model};else if(modelTime!==null&&(entry.modelTime===null||modelTime>=entry.modelTime)){const{cpu,memory,storage,network,...metadata}=model;entry.model={...entry.model,...metadata};}if(modelTime!==null&&(entry.modelTime===null||modelTime>=entry.modelTime))entry.modelTime=modelTime;}
  const acceptModel=name=>{if(model?.[name])entry.model={...entry.model,[name]:model[name]};};
  for(const name of ['cpu','memory','storage','network']){
   const supplied=channels[name];if(!supplied)continue;const previous=entry.last.get(name),time=sampleTime(supplied.sampledAt),values=(supplied.values||[]).map(finite),transient=supplied.continuity==='transient',empty=values.length===0||values.every(value=>value===null),unavailable=supplied.stale===true||supplied.available===false||transient&&empty,context=String(supplied.context||'').slice(0,512),hardBreak=supplied.hardBreak===true;
   if(time!==null&&previous?.sampleTime!==undefined&&time<previous.sampleTime)continue;
   if(unavailable){
    if(previous?.unavailable){
     // A later terminal failure or identity change must never be hidden by an
     // earlier, apparently transient sampling delay.
     if(previous.pending&&(!transient||hardBreak||context!==previous.context))previous.pending.soft=false;
     if(time===null||previous.sampleTime===undefined||time>=previous.sampleTime){entry.last.set(name,{...previous,...(time===null?{}:{sampleTime:time}),context});acceptModel(name);}continue;
    }const gapAt=previous?.time??time;
    acceptModel(name);const pending={soft:Boolean(transient&&!hardBreak&&context&&context===previous?.context&&previous?.validTime!==undefined),observedAt:observationTime,point:null};
    entry.last.set(name,{...previous,...(time===null?{}:{sampleTime:time}),unavailable:true,context,pending});if(gapAt===null||gapAt===undefined)continue;
    // Anchor an availability gap to the source's last measurement, never to a
    // different computer's wall clock. It carries no fabricated numeric data.
    changed[name]={time:gapAt,values:values.map(()=>null),ceiling:finite(supplied.ceiling),gap:true,observation:true,observedAt:observationTime,context};pending.point=changed[name];continue;
   }
   if(time===null)continue;
   if(previous?.sampleTime!==undefined&&time===previous.sampleTime&&!previous.unavailable&&context===previous.context&&!hardBreak)continue;
   acceptModel(name);
   const pending=previous?.pending,bridge=Boolean(previous?.unavailable&&pending?.soft&&transient&&!hardBreak&&context===previous.context&&!empty&&previous.validTime!==undefined&&time>=previous.validTime&&time-previous.validTime<=gapAfterMs&&observationTime!==null&&pending.observedAt!==null&&observationTime>=pending.observedAt&&observationTime-pending.observedAt<=Math.min(transientGraceMs,gapAfterMs));
   // The marker remains an empty observation in history. Once a short known
   // sampling interruption recovers, connect only the two real measurements;
   // no replacement value, synthetic timestamp or zero measurement is added.
   if(bridge&&pending.point)pending.point.bridged=true;
   const breakBefore=hardBreak||Boolean(previous?.unavailable&&!bridge)||previous?.context!==undefined&&context!==previous.context;
   if(previous?.time===time&&previous.unavailable){
    // A fresh status can describe the very same cached measurement. Clear the
    // model's stale flag immediately without appending that measurement twice.
    // A hard interruption still has its original null marker in the series.
    entry.last.set(name,{sampleTime:time,time,validTime:empty?previous.validTime:time,unavailable:false,context});continue;
   }
   const point={time,values,ceiling:finite(supplied.ceiling),gap:empty,context,breakBefore};
   if(previous?.time!==undefined&&time-previous.time>gapAfterMs)point.breakBefore=true;
   changed[name]=point;entry.last.set(name,{sampleTime:time,time,validTime:empty?previous?.validTime:time,unavailable:false,context});
  }
  if(!Object.keys(changed).length)return false;
  entry.frames.push(changed);if(entry.frames.length>maxPoints)entry.frames.splice(0,entry.frames.length-maxPoints);return true;
 }
 function series(key,name){const entry=entries.get(key);return entry?entry.frames.flatMap(frame=>frame[name]?[{...frame[name],values:[...frame[name].values]}]:[]):[];}
 return{record,series,model:key=>entries.get(key)?.model||null,prune(keys){const allowed=new Set(keys);for(const key of entries.keys())if(!allowed.has(key))entries.delete(key);},clear(){entries.clear();},inspect(){return{entities:entries.size,maxEntities,maxPoints,frames:[...entries.values()].reduce((sum,entry)=>sum+entry.frames.length,0)};}};
}

const round=value=>Math.round(value*100)/100;
function curved(points){if(!points.length)return'';let result=`M ${round(points[0].x)} ${round(points[0].y)}`;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],step=(b.x-a.x)*.4;result+=` C ${round(a.x+step)} ${round(a.y)} ${round(b.x-step)} ${round(b.y)} ${round(b.x)} ${round(b.y)}`;}return result;}
export function metricChart(points,{seriesCount=1,capacity=false,width=240,height=48,padding=4}={}){
 const measured=points.filter(point=>Number.isFinite(point.time)),finiteValues=measured.flatMap(point=>point.values).filter(value=>finite(value)!==null),latestCapacity=[...measured].reverse().find(point=>finite(point.ceiling)!==null&&point.ceiling>0)?.ceiling??null;
 const maximum=Math.max(0,...finiteValues),scale=capacity&&latestCapacity!==null?Math.max(latestCapacity,maximum):maximum>0?maximum*1.12:1;
 const start=measured[0]?.time??null,end=measured.at(-1)?.time??null,span=end===start?1:end-start,plotWidth=width-padding*2,plotHeight=height-padding*2;
 const x=time=>padding+(end===start?plotWidth:Math.max(0,Math.min(1,(time-start)/span))*plotWidth),y=value=>height-padding-value/scale*plotHeight;
 const lines=[];
 for(let index=0;index<seriesCount;index++){
  const segments=[];let current=[];
  const close=()=>{if(current.length)segments.push(current);current=[];};
  for(const point of measured){if(point.observation&&point.bridged)continue;const value=finite(point.values[index]);if(point.breakBefore)close();if(value===null||point.gap){close();continue;}current.push({x:x(point.time),y:y(value),value,time:point.time});}close();
  const last=segments.at(-1)?.at(-1)||null;
  lines.push({path:segments.filter(segment=>segment.length>1).map(curved).join(' '),dot:last?{x:round(last.x),y:round(last.y)}:null,points:segments.reduce((sum,segment)=>sum+segment.length,0)});
 }
 return{lines,scale,capacity:latestCapacity,start,end,samples:measured.filter(point=>!point.gap&&point.values.some(value=>finite(value)!==null)).length,empty:finiteValues.length===0,width,height};
}
