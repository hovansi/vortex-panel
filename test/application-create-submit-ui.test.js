import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const prior=globalThis.document;
globalThis.document={documentElement:{lang:'en'},addEventListener(){},querySelectorAll(){return[];}};
const {readApplicationForm,applicationRuntimeState,applicationStartupModeSupported,isApplication}=await import('../public/application-workspace.js');
const {plainUI}=await import('../public/i18n.js');
if(prior)globalThis.document=prior;else delete globalThis.document;
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('async(values,form)=>{',source.indexOf('async function createServer(')),end=source.indexOf("},nodeText('Create'",start);
assert.ok(start>0&&end>start);
const callbackSource=source.slice(start,end+1);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

function harness(kind,{mode='entrypoint',supportedModes=['entrypoint','npm-script','python-module']}={}){
 const fields={name:'Accepted project',nodeId:'local',kind,appEntrypoint:kind==='python'?'app.py':'server.js',appArgs:'["accepted-argument"]',appEnvironment:'[{"name":"APP_GREETING","value":"accepted-value","secret":false}]',appDependencies:'none',appReadiness:'tcp',appStartupMode:mode,appStartupScript:'start',appStartupModule:'app'};
 const values={...fields,portAllocation:'auto',storageDiskGiB:'1',resourceMode:'fixed',resourceCpu:'.2',resourceMemory:'256'};
 const form={dataset:{},elements:{namedItem:name=>Object.hasOwn(fields,name)?{value:fields[name]}:null},querySelector(){return null;}};
 const nodes=deferred(),runtime=deferred(),runtimeRequested=deferred(),calls=[];
 let post,serializations=0;
 const boundary=Error('INERT_POST_BOUNDARY');
 const context={
  isApplication,applicationRuntimeState,applicationStartupModeSupported,
  readApplicationForm:(...args)=>{serializations++;return readApplicationForm(...args);},
  api:async(path,request)=>{calls.push({path,method:request?.method||'GET'});if(path==='/nodes')return nodes.promise;if(path.endsWith('/application-runtimes')){runtimeRequested.resolve();return runtime.promise;}post=JSON.parse(JSON.stringify(request.body));throw boundary;},
  nodeCreationState:()=>({allowed:true,capability:{fixedSupported:true}}),portAllocationState:()=>({allowed:true}),
  resourceFromValues:draft=>({mode:draft.resourceMode,cpuCores:Number(draft.resourceCpu),memoryMiB:Number(draft.resourceMemory)}),allocationRequestState:()=>({allowed:true}),storageCreationState:()=>({allowed:true}),portAllocationFromValues:()=>({portAllocation:'auto'}),
  state:{auth:{user:{id:'inert-owner'}}},chosenChannel:'stable',nodeText:en=>en,wireText:value=>value,setTimeout(){},
 };
 vm.createContext(context);
 const submit=vm.runInContext(`(${callbackSource})`,context);
 return{fields,values,form,calls,submit:()=>submit(values,form),boundary,get post(){return post;},get serializations(){return serializations;},
  releaseNodes:()=>nodes.resolve({nodes:[{id:'local'}]}),runtimeRequested:runtimeRequested.promise,
  releaseRuntime:()=>runtime.resolve({applicationRuntime:{supported:true,managed:true,runtimes:[{kind,managedAvailable:true,latest:{version:kind==='python'?'3.15.0':'v26.0.0'},catalog:{status:'verified'},startupModes:supportedModes}]}}),
 };
}

for(const [kind,mode] of [['nodejs','npm-script'],['python','python-module']])test(`actual ${kind} submit snapshots all application fields before both awaited validations`,async()=>{
 const h=harness(kind,{mode}),pending=h.submit();
 assert.equal(h.serializations,1);assert.deepEqual(h.calls,[{path:'/nodes',method:'GET'}]);
 Object.assign(h.fields,{name:'Later project',nodeId:'other-vps',kind:kind==='nodejs'?'python':'nodejs',appEntrypoint:'later.py',appArgs:'["during-nodes"]',appEnvironment:'[]',appReadiness:'process',appDependencies:'auto',appStartupMode:'entrypoint',appStartupScript:'later',appStartupModule:'later'});
 h.releaseNodes();await h.runtimeRequested;
 Object.assign(h.fields,{appArgs:'["during-catalog"]',appStartupMode:kind==='python'?'npm-script':'python-module',appStartupScript:'different',appStartupModule:'different'});
 h.releaseRuntime();await assert.rejects(pending,error=>error===h.boundary);
 assert.equal(h.serializations,1);assert.equal(h.post.name,'Accepted project');assert.equal(h.post.nodeId,'local');assert.equal(h.post.kind,kind);
 assert.deepEqual(h.post.application,{entrypoint:kind==='python'?'app.py':'server.js',args:['accepted-argument'],environment:[{name:'APP_GREETING',value:'accepted-value',secret:false}],dependencies:'none',readiness:'tcp',startup:kind==='python'?{mode:'python-module',module:'app'}:{mode:'npm-script',script:'start'}});
 assert.deepEqual(h.post.resourcePolicy,{mode:'fixed',cpuCores:.2,memoryMiB:256});assert.deepEqual(h.post.storagePolicy,{mode:'fixed',diskGiB:1});
});

test('fresh startup capability validates the captured mode even if the visible form changes to a supported mode',async()=>{
 const h=harness('nodejs',{mode:'npm-script',supportedModes:['entrypoint']}),pending=h.submit();
 h.fields.appStartupMode='entrypoint';h.releaseNodes();await h.runtimeRequested;h.releaseRuntime();
 await assert.rejects(pending,error=>plainUI(error.message).includes('Choose a startup mode supported by this VPS'));
 assert.equal(h.post,undefined);assert.equal(h.serializations,1);assert.equal(h.calls.some(call=>call.method==='POST'),false);
});

test('an entrypoint snapshot stays valid when a later visible draft selects an unsupported mode',async()=>{
 const h=harness('nodejs',{supportedModes:['entrypoint']}),pending=h.submit();
 h.fields.appStartupMode='npm-script';h.fields.appStartupScript='later';h.releaseNodes();await h.runtimeRequested;h.releaseRuntime();
 await assert.rejects(pending,error=>error===h.boundary);
 assert.equal(h.post.application.entrypoint,'server.js');assert.equal(Object.hasOwn(h.post.application,'startup'),false);assert.deepEqual(h.post.application.args,['accepted-argument']);
});

test('an invalid application snapshot is rejected synchronously before capability requests or mutation',async()=>{
 const h=harness('python');h.fields.appArgs='invalid JSON';
 await assert.rejects(h.submit());assert.equal(h.serializations,1);assert.equal(h.calls.length,0);assert.equal(h.post,undefined);
});
