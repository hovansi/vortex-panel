// The visible console belongs to one server and one process run. Disk history
// is separate; a delayed response must never restore a previous run's output.
const stopped=status=>status==='stopped';
const identity=value=>typeof value==='string'&&value?value:null;
const rowKey=row=>row.id||`${row.time}|${row.level}|${row.message}`;
const rowBytes=row=>String(row.message||'').length*2+160;
function model(state){return state._console||(state._console={serverId:null,runId:null,status:null,epoch:0,received:0,retired:new Set(),arrivals:new Map()});}
function clear(state,current){state.logs=[];current.epoch++;current.received=0;current.arrivals.clear();}
function run(state,current,runId){
 if(current.runId===runId)return false;
 if(current.runId)current.retired.add(current.runId);
 while(current.retired.size>64)current.retired.delete(current.retired.values().next().value);
 current.runId=runId;clear(state,current);return true;
}
function bounded(rows){let size=0;const result=[];for(let index=rows.length-1;index>=0&&result.length<500;index--){const row=rows[index];size+=rowBytes(row);if(size>1024**2)break;result.push(row);}return result.reverse();}
function assign(state,current,rows){state.logs=bounded(rows);const retained=new Set(state.logs.map(rowKey));for(const key of current.arrivals.keys())if(!retained.has(key))current.arrivals.delete(key);}

export function syncConsoleServer(state,server){
 const current=model(state),serverId=server?.id||null,runId=identity(server?.consoleRunId);let changed=false;
 if(current.serverId!==serverId){current.serverId=serverId;current.runId=null;current.retired.clear();clear(state,current);changed=true;}
 if(runId&&current.retired.has(runId))return changed;
 if(runId&&run(state,current,runId))changed=true;
 const nextStatus=server?.status||null;
 if(stopped(nextStatus)&&(current.status!==nextStatus||state.logs.length)){clear(state,current);changed=true;}
 current.status=nextStatus;return changed;
}
export function resetConsoleRun(state,serverId,runId){
 const current=model(state),next=identity(runId);if(current.serverId!==serverId||!next||current.retired.has(next))return false;
 const changed=run(state,current,next);if(changed)current.status='starting';return changed;
}
export function consoleRequest(state){
 const current=model(state);return {serverId:current.serverId,runId:current.runId,epoch:current.epoch,received:current.received};
}
export function receiveConsoleLog(state,event){
 const current=model(state),row=event?.log,runId=identity(event?.runId||row?.runId);
 if(!row||current.serverId!==event.serverId||stopped(current.status)||!runId||runId!==current.runId||identity(row.runId)!==runId)return false;
 const key=rowKey(row);if(state.logs.some(item=>rowKey(item)===key))return false;
 current.arrivals.set(key,++current.received);assign(state,current,[...state.logs,row]);return true;
}
export function receiveConsoleSnapshot(state,response,request){
 const current=model(state),runId=identity(response?.runId);
 if(!request||request.serverId!==current.serverId||request.runId!==current.runId||request.epoch!==current.epoch||stopped(current.status)||!runId||runId!==current.runId)return false;
 const snapshot=(Array.isArray(response.logs)?response.logs:[]).filter(row=>row&&identity(row.runId)===runId),live=state.logs.filter(row=>(current.arrivals.get(rowKey(row))||0)>request.received),merged=new Map();
 for(const row of [...snapshot,...live])merged.set(rowKey(row),row);
 assign(state,current,[...merged.values()]);return true;
}
export function consoleCurrentRun(state){return model(state).runId;}
