import test from 'node:test';
import assert from 'node:assert/strict';
const previousDocument=globalThis.document,hadDocument=Object.hasOwn(globalThis,'document');
globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
let versionPickerModel,versionIsReady,telemetryModel,metricBytes,storageGrowthModel,storageCreationState,allocationRequestState,resourceFields,openStorageGrow;
try{({versionPickerModel,versionIsReady}=await import('../public/version-picker.js'));({telemetryModel,metricBytes}=await import('../public/telemetry-view.js'));({storageGrowthModel,storageCreationState,allocationRequestState,openStorageGrow}=await import('../public/storage-fields.js'));({resourceFields}=await import('../public/resource-fields.js'));}
finally{if(hadDocument)globalThis.document=previousDocument;else delete globalThis.document;}

test('version picker retains the full396-entry node catalog rather than only cached or checked packages',()=>{
 const rows=Array.from({length:396},(_,index)=>({version:`1.21.${index}.1`,channel:index%2?'preview':'stable',cached:index===0,availability:index===0?'cached':index===395?'unavailable':'unchecked'}));
 const original=structuredClone(rows),first=versionPickerModel(rows),last=versionPickerModel(rows,{page:40});
 assert.equal(first.total,396);assert.equal(first.pages,40);assert.equal(first.rows.length,10);assert.equal(last.rows.length,6);assert.equal(last.rows.at(-1).availability,'unavailable');assert.deepEqual(rows,original);
});
test('version search/channel pagination clamps after filtering and keeps stable/preview package identities separate',()=>{
 const rows=[{version:'1.21.50.10',channel:'stable'},{version:'1.21.50.10',channel:'preview'},{version:'1.21.50.10',channel:'stable'},...Array.from({length:23},(_,i)=>({version:`1.26.${i}.3`,channel:'stable'}))];
 assert.equal(versionPickerModel(rows).total,25);const filtered=versionPickerModel(rows,{query:'1.21.50',channel:'preview',page:99});assert.equal(filtered.page,1);assert.equal(filtered.rows.length,1);assert.equal(filtered.rows[0].channel,'preview');assert.equal(versionPickerModel(rows,{query:'missing',page:8}).start,0);
});
test('unchecked catalog presence does not mean an installable official link',()=>{
 assert.equal(versionIsReady({availability:'unchecked',available:true}),false);assert.equal(versionIsReady({availability:'unavailable',available:false}),false);assert.equal(versionIsReady({availability:'available',available:true}),true);assert.equal(versionIsReady({cached:true,available:false}),true);assert.equal(versionIsReady(null),false);
});
test('host telemetry uses used/total cores and total-minus-available RAM rather than a fabricated zero',()=>{
 const result=telemetryModel({cpu:{usedCores:1.5,totalCores:4},memory:{usedBytes:3*1024**3,totalBytes:8*1024**3},disk:{usedBytes:20*1024**3,totalBytes:100*1024**3},network:{supported:true,scope:'host-network-namespace',rxBytes:100,txBytes:200,rxBytesPerSecond:null,txBytesPerSecond:null}});
 assert.equal(result.cpu.percent,37.5);assert.equal(result.memory.percent,37.5);assert.equal(result.network.rxRate,null);assert.equal(result.network.rxBytes,100);assert.equal(result.network.available,true);assert.equal(telemetryModel({}).cpu.used,null);assert.equal(telemetryModel({}).memory.total,null);assert.equal(metricBytes(null),'—');
});
test('per-server telemetry honors fixed ceilings and shared-pool denominator without turning processCPU into hostpercent',()=>{
 const fixed=telemetryModel({telemetry:{cpu:{usedCores:0.25,totalCores:0.5,limitSource:'fixed'},memory:{usedBytes:256*1024**2,totalBytes:768*1024**2,limitSource:'fixed'}}},'server');assert.equal(fixed.cpu.percent,50);assert.equal(fixed.cpu.total,0.5);assert.equal(fixed.memory.total,768*1024**2);
 const shared=telemetryModel({telemetry:{cpu:{usedCores:1.5,totalCores:3.6,limitSource:'shared-pool'},memory:{usedBytes:1,totalBytes:100,limitSource:'shared-pool'}}},'server');assert.equal(shared.cpu.source,'shared-pool');assert.equal(shared.cpu.total,3.6);
});
test('offline remote metrics remain unknown even when last-known numbers exist',()=>{
 const result=telemetryModel({nodeOnline:false,cpuPercent:250,memoryMB:100,telemetry:{cpu:{usedCores:2.5,totalCores:4},memory:{usedBytes:100,totalBytes:1000},network:{available:true,rxBytes:123,txBytes:456}}},'server');assert.equal(result.cpu.used,null);assert.equal(result.memory.used,null);assert.equal(result.storage.used,null);assert.equal(result.network.available,false);
});
test('missing legacy fixed RAM ceiling remains unknown instead of null multiplication becoming zero',()=>{
 const result=telemetryModel({resourcePolicy:{mode:'fixed'},cpuPercent:50,memoryMB:128},'server');assert.equal(result.memory.used,128*1024**2);assert.equal(result.memory.total,null);assert.equal(result.cpu.total,null);
});
test('explicit rich unknown or warming samples never fall back to legacy zero aliases',()=>{
 const rich={cpuPercent:0,cpus:4,memoryUsed:0,memoryTotal:10,memoryMB:0,resourcePolicy:{mode:'fixed',cpuCores:1,memoryMiB:512},cpu:{usedCores:null,totalCores:null},memory:{usedBytes:null,totalBytes:null}};
 assert.equal(telemetryModel(rich).cpu.used,null);assert.equal(telemetryModel(rich).cpu.total,null);assert.equal(telemetryModel(rich).memory.used,null);assert.equal(telemetryModel(rich).memory.total,null);
 const server=telemetryModel({...rich,telemetry:{cpu:rich.cpu,memory:rich.memory}},'server');assert.equal(server.cpu.used,null);assert.equal(server.cpu.total,null);assert.equal(server.memory.used,null);assert.equal(server.memory.total,null);
});
test('legacy host CPU fallback scales percent by actual core count while process CPU keeps its one-core definition',()=>{
 assert.equal(telemetryModel({cpus:4,cpuPercent:50}).cpu.used,2);assert.equal(telemetryModel({cpuPercent:50},'server').cpu.used,0.5);assert.equal(telemetryModel({cpuPercent:50}).cpu.used,null);
});
test('server traffic cannot borrow host counters and stale host snapshots never claim live rates',()=>{
 const host={cpu:{usedCores:0.5,totalCores:1},network:{supported:true,available:true,scope:'host-network-namespace',rxBytes:123,txBytes:456,rxBytesPerSecond:100,txBytesPerSecond:50}};
 assert.equal(telemetryModel({telemetry:host},'server').network.available,false);const stale=telemetryModel({...host,stale:true});assert.equal(stale.cpu.used,0.5);assert.equal(stale.stale,true);assert.equal(stale.network.available,false);assert.equal(stale.network.rxRate,null);
});
test('creation admission uses shared reservations and server disk capacity without subtracting allocated disk twice',()=>{
 const node={capabilities:{storageControl:{supported:true,minDiskGiB:1,maxDiskGiB:65536}},host:{capacity:{cpu:{availableCores:0.5},memory:{availableBytes:512*1024**2},storage:{maxNewDiskGiB:7,allocatedBytes:100*1024**3},sharedReservation:{cpuCores:0.1,memoryMiB:512}}}};
 assert.equal(allocationRequestState({mode:'shared'},node).allowed,true);assert.equal(allocationRequestState({mode:'fixed',cpuCores:0.6,memoryMiB:256},node).allowed,false);assert.equal(storageCreationState(node,7).allowed,true);assert.equal(storageCreationState(node,8).allowed,false);assert.equal(storageCreationState({...node,capabilities:{}},1).allowed,false);
});
test('growth budget credits actual image size after a failed larger reservation and never offers unknown larger growth',()=>{
 const server={status:'stopped',storagePolicy:{mode:'fixed',diskGiB:10},telemetry:{storage:{limitBytes:5*1024**3}}},configuration={storageControl:{supported:true,maxDiskGiB:65536},hostCapacity:{storage:{maxNewDiskGiB:3}}};
 const failed=storageGrowthModel(server,configuration);assert.equal(failed.maximum,10);assert.equal(failed.retry,true);assert.equal(failed.initial,10);
 const current=storageGrowthModel({...server,storagePolicy:{mode:'fixed',diskGiB:5}},configuration);assert.equal(current.maximum,8);assert.equal(current.initial,6);
 const unknown=storageGrowthModel({...server,telemetry:{}},configuration);assert.equal(unknown.maximum,10);assert.equal(unknown.retry,true);assert.equal(unknown.initial,10);
 assert.equal(storageGrowthModel({...server,status:'running'},configuration).allowed,false);assert.equal(storageGrowthModel({...server,storagePolicy:{mode:'unlimited'}},configuration).allowed,false);
});
test('uncached package staging keeps an additional three GiB outside the server volume without lowering its requested size',()=>{
 const node={capabilities:{storageControl:{supported:true,minDiskGiB:1,maxDiskGiB:65536}},host:{capacity:{storage:{maxNewDiskGiB:7}}}};
 assert.equal(storageCreationState(node,5,{packageWorkspaceBytes:3*1024**3}).allowed,false);
 assert.equal(storageCreationState(node,4,{packageWorkspaceBytes:3*1024**3}).maximum,4);
 assert.equal(storageCreationState(node,4,{packageWorkspaceBytes:3*1024**3}).allowed,true);
 assert.equal(storageCreationState(node,7,{packageWorkspaceBytes:0}).allowed,true);
 assert.equal(storageCreationState(node,2.5,{packageWorkspaceBytes:0}).allowed,false);
});
test('late storage configuration cannot open a growth dialog after its origin was replaced',async()=>{
 const server={id:'s',name:'World',status:'stopped',storagePolicy:{mode:'fixed',diskGiB:5},telemetry:{storage:{limitBytes:5*1024**3}}};let finish,opened=0,current=true;
 const waiting=new Promise(resolve=>{finish=resolve;}),run=openStorageGrow('s',{findServer:()=>server,canManage:()=>true,isDirty:()=>false,api:()=>waiting,isCurrent:()=>current,openModal:()=>{opened++;}});
 current=false;finish({server,storageControl:{supported:true,maxDiskGiB:65536},hostCapacity:{storage:{maxNewDiskGiB:2}}});await run;assert.equal(opened,0);
});
test('growth submit rechecks the selected context after fresh capacity returns and never posts from a closed modal',async()=>{
 const server={id:'s',name:'World',status:'stopped',storagePolicy:{mode:'fixed',diskGiB:5},telemetry:{storage:{limitBytes:5*1024**3}}},config={server,storageControl:{supported:true,maxDiskGiB:65536},hostCapacity:{storage:{maxNewDiskGiB:2}}};let callback,finish,gets=0,posts=0,selected=true;
 const waiting=new Promise(resolve=>{finish=resolve;});await openStorageGrow('s',{findServer:()=>server,canManage:()=>true,isDirty:()=>false,isCurrent:()=>true,isSelected:()=>selected,api:async(_path,options)=>{if(options?.method==='POST'){posts++;return{};}return ++gets===1?config:waiting;},openModal:async(_title,_description,_body,submit)=>{callback=submit;}});
 const submit=callback({diskGiB:'6'},{isConnected:true,dataset:{}});selected=false;finish(config);await assert.rejects(submit);assert.equal(posts,0);
});
test('unchanged legacy configured limits stay representable above a reduced host ceiling while new allocations remain bounded',()=>{
 const caps={fixedSupported:true,cpu:{maxCores:0.9},memory:{maxMiB:900}},capacity={cpu:{availableCores:0},memory:{availableBytes:0}},policy={mode:'fixed',cpuCores:1,memoryMiB:1024};
 const existing=resourceFields(policy,caps,false,{capacity,credit:{cpuCores:1,memoryMiB:1024}}),fresh=resourceFields(policy,caps,false,{capacity});
 assert.match(existing,/name="resourceCpu"[^>]*max="1"/);assert.match(existing,/name="resourceMemory"[^>]*max="1024"/);assert.match(existing,/resource-overcommitted/);assert.match(fresh,/name="resourceCpu"[^>]*max="0"/);
});
