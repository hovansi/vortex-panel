import test from 'node:test';
import assert from 'node:assert/strict';
import {syncConsoleServer,resetConsoleRun,consoleRequest,receiveConsoleLog,receiveConsoleSnapshot,consoleCurrentRun} from '../public/console-state.js';
import {createViewGuard,clearPrivateDialogs,runInSession} from '../public/async-context.js';

const server=(runId='run-a',status='running',id='server-a')=>({id,status,consoleRunId:runId});
const line=(id,runId='run-a',message=id)=>({id,runId,time:'2026-10-16T00:00:00Z',level:'info',message});
function fixture(){const state={logs:[]};syncConsoleServer(state,server());return state;}
const emit=(state,row,serverId='server-a')=>receiveConsoleLog(state,{serverId,runId:row.runId,log:row});

test('new console runs retire previous output and invalidate delayed snapshots and WebSocket events',()=>{
 const state=fixture(),old=consoleRequest(state);emit(state,line('old'));assert.equal(resetConsoleRun(state,'server-a','run-b'),true);assert.deepEqual(state.logs,[]);
 assert.equal(receiveConsoleSnapshot(state,{runId:'run-a',logs:[line('late')]},old),false);assert.equal(emit(state,line('late')),false);
 assert.equal(emit(state,line('new','run-b')),true);assert.equal(resetConsoleRun(state,'server-a','run-a'),false);
 syncConsoleServer(state,server('run-a','stopped'));assert.equal(consoleCurrentRun(state),'run-b');assert.deepEqual(state.logs.map(row=>row.id),['new']);
});

test('stopping clears visible console and blocks old output after polling, reload and reconnect',()=>{
 const state=fixture();emit(state,line('old'));syncConsoleServer(state,server('run-a','stopped'));assert.deepEqual(state.logs,[]);
 assert.equal(receiveConsoleSnapshot(state,{runId:'run-a',logs:[line('persisted')]},consoleRequest(state)),false);assert.equal(emit(state,line('late-close')),false);
 const reloaded={logs:[]};syncConsoleServer(reloaded,server('run-a','stopped'));assert.equal(receiveConsoleSnapshot(reloaded,{runId:'run-a',logs:[line('disk')]},consoleRequest(reloaded)),false);
 assert.equal(resetConsoleRun(state,'server-a','run-b'),true);assert.equal(emit(state,line('started','run-b')),true);
});

test('crash diagnostics remain available until the next admitted start',()=>{
 const state=fixture();emit(state,line('crash'));syncConsoleServer(state,server('run-a','crashed'));assert.equal(state.logs[0].id,'crash');
 assert.equal(receiveConsoleSnapshot(state,{runId:'run-a',logs:[line('error')]},consoleRequest(state)),true);assert.equal(state.logs[0].id,'error');
 syncConsoleServer(state,server('run-b','starting'));assert.deepEqual(state.logs,[]);
});

test('a log fetch merges concurrent streamed lines exactly once rather than overwriting them',()=>{
 const state=fixture();emit(state,line('before'));const request=consoleRequest(state);emit(state,line('during'));emit(state,line('also-during'));
 assert.equal(receiveConsoleSnapshot(state,{runId:'run-a',logs:[line('before'),line('during')]},request),true);assert.deepEqual(state.logs.map(row=>row.id),['before','during','also-during']);
 assert.equal(emit(state,line('during')),false);assert.equal(state.logs.length,3);
});

test('switching servers rejects pending responses even when both servers use the same run label',()=>{
 const state=fixture(),request=consoleRequest(state);emit(state,line('a'));syncConsoleServer(state,server('run-a','running','server-b'));
 assert.deepEqual(state.logs,[]);assert.equal(receiveConsoleSnapshot(state,{runId:'run-a',logs:[line('a')]},request),false);assert.equal(emit(state,line('wrong-server')),false);
 assert.equal(emit(state,line('b'),'server-b'),true);
});

test('malformed and mismatched run identities fail closed without clearing valid current logs',()=>{
 const state=fixture();emit(state,line('safe'));const request=consoleRequest(state);
 for(const response of [{logs:[line('missing')]},{runId:'run-b',logs:[line('wrong','run-b')]}])assert.equal(receiveConsoleSnapshot(state,response,request),false);
 assert.equal(receiveConsoleLog(state,{serverId:'server-a',runId:'run-a',log:line('bad-row','run-b')}),false);
 assert.equal(receiveConsoleSnapshot(state,{runId:'run-a',logs:[line('valid'),line('foreign','run-b')]},request),true);assert.deepEqual(state.logs.map(row=>row.id),['valid']);
});

test('console memory is bounded under a stream flood and oversized individual messages',()=>{
 const state=fixture();for(let i=0;i<700;i++)emit(state,line(String(i)));assert.equal(state.logs.length,500);assert.equal(state.logs[0].id,'200');
 emit(state,line('oversized','run-a','x'.repeat(1024**2)));assert.equal(state.logs.length,0);
 emit(state,line('after'));assert.deepEqual(state.logs.map(row=>row.id),['after']);
});

test('a newer snapshot may replace earlier rows but keeps only stream arrivals after its request',()=>{
 const state=fixture();emit(state,line('before'));const request=consoleRequest(state);emit(state,line('after'));
 receiveConsoleSnapshot(state,{runId:'run-a',logs:[line('snapshot')]},request);assert.deepEqual(state.logs.map(row=>row.id),['snapshot','after']);
});

test('async UI guards distinguish a replaced open modal and a changed actor or view',()=>{
 let state={render:1,view:'nodes',actor:'admin-a',modalOpen:true,modalRevision:4};const read=()=>state,valid=createViewGuard(read);assert.equal(valid(),true);
 for(const change of [{modalRevision:5},{render:2},{view:'settings'},{actor:'admin-b'},{modalOpen:false}]){state={render:1,view:'nodes',actor:'admin-a',modalOpen:true,modalRevision:4,...change};assert.equal(valid(),false);}
});

test('authentication cleanup removes private content from every open and closed overlay',()=>{
 const dialogs=['modal','server-picker','file-actions','file-folder-picker','confirmation','palette','drawer'].map((id,index)=>({id,open:index%2===0,returnValue:'private/path',dataset:{path:'private/path',serverId:'private-server',signature:'private-signature',vxI18nAriaLabel:'Chọn máy chủ'},children:['password','MFA QR','file content'],close(){this.open=false;this.closed=true;},replaceChildren(){this.children=[];}}));
 clearPrivateDialogs({querySelectorAll(selector){assert.equal(selector,'dialog');return dialogs;}});
 for(const dialog of dialogs){assert.equal(dialog.open,false);assert.equal(dialog.returnValue,'');assert.deepEqual(dialog.children,[]);assert.deepEqual(dialog.dataset,{vxI18nAriaLabel:'Chọn máy chủ'});}
 clearPrivateDialogs({querySelectorAll:()=>[]});
});

test('both fulfilled and rejected old-session requests lose their private result and error',async()=>{
 for(const rejectResult of [false,true]){let session=1,finish;const response=new Promise((resolve,reject)=>finish=()=>rejectResult?reject(Error('private/file.txt server error')):resolve({private:'file contents'}));
  const work=runInSession(()=>session,()=>response,()=>Object.assign(Error('Session changed'),{code:'UI_SESSION_CHANGED'}));session=2;finish();
  await assert.rejects(work,error=>error.code==='UI_SESSION_CHANGED'&&!error.message.includes('private'));
 }
});

test('a current session retains useful successful results and errors',async()=>{
 const result={job:'accepted'};assert.strictEqual(await runInSession(()=>1,async()=>result,()=>Error('changed')),result);
 const expected=Error('Connection unavailable');await assert.rejects(runInSession(()=>1,async()=>{throw expected;},()=>Error('changed')),error=>error===expected);
});

test('connection guards reject old socket callbacks after reconnect or authentication changes',()=>{
 const first={},second={};let state={socket:first,session:1,authenticated:true};const current=createViewGuard(()=>state);assert.equal(current(),true);
 state={...state,socket:second};assert.equal(current(),false);
 state={socket:first,session:2,authenticated:true};assert.equal(current(),false);
 state={socket:first,session:1,authenticated:false};assert.equal(current(),false);
});
