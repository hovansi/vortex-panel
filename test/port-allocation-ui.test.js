import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const previousDocument=globalThis.document,hadDocument=Object.hasOwn(globalThis,'document');
const languageDocument={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];},dispatchEvent(){}};
globalThis.document=languageDocument;
let portAllocationFields,portAllocationFromValues,portAllocationState,syncPortAllocation,plainUI,setLanguage,isApplication,applicationRuntimeState,applicationStartupModeSupported;
try{
 ({portAllocationFields,portAllocationFromValues,portAllocationState,syncPortAllocation}=await import('../public/port-allocation.js'));
 ({plainUI,setLanguage}=await import('../public/i18n.js'));
 ({isApplication,applicationRuntimeState,applicationStartupModeSupported}=await import('../public/application-workspace.js'));
}finally{if(hadDocument)globalThis.document=previousDocument;else delete globalThis.document;}
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const section=(start,end)=>{const index=source.indexOf(start),last=source.indexOf(end,index);assert.ok(index>=0&&last>index);return source.slice(index,last);};
const createCode=section('async function createServer(', 'function fileDestinationField(');
const cloneCode=section('async function cloneServer(', '\nfunction ');
const automaticCapability={supported:true,schemaVersion:1,mode:'auto',authority:'node'};
const nodes=['local','worker-a','worker-b'].map(id=>({id,name:id,online:true,portAllocation:automaticCapability,capabilities:{resourceControl:{fixedSupported:true}}}));
const version={version:'1.26.52.3',channel:'stable',cached:true};

// These tests run the real submit callbacks up to the outgoing POST. The API
// sentinel intentionally stops execution there: no server or install is run.
async function submitHarness(action='createServer',availableNodes=nodes){
 let submit,markup,request;
 const sent=new Error('OUTGOING_POST_CAPTURED'),state={nodes:availableNodes,view:'servers',auth:{authenticated:true,user:{id:'owner'}},servers:[{id:'worker-a:source',nodeId:'worker-a',name:'Source world'}]};
 const context={state,requestContext:()=>()=>true,nodeCreationState:node=>({allowed:node?.online===true,capability:node?.capabilities?.resourceControl||{}}),isApplication,applicationRuntimeState,applicationStartupModeSupported,portAllocationFields,portAllocationFromValues,portAllocationState,resourceFromValues:()=>({mode:'shared'}),allocationRequestState:()=>({allowed:true}),storageCreationState:()=>({allowed:true}),readApplicationForm:(_form,{kind})=>({entrypoint:kind==='python'?'app.py':'server.js'}),versionIsReady:()=>true,versionPickerMarkup:()=>'',nodeText:en=>en,t:value=>value,e:value=>String(value??''),field:()=>'<input>',ht:(parts,...values)=>parts.map((part,index)=>part+(values[index]??'')).join(''),icon:()=>'',setTimeout(){},createNodeSync:null,serverPath:server=>`/servers/${encodeURIComponent(server.id)}`,
  openModal:async(_title,_description,body,callback)=>{markup=body;submit=callback;return false;},
  api:async(path,options={})=>{
   if(options.method==='POST'){request={path,body:JSON.parse(JSON.stringify(options.body))};throw sent;}
   if(path==='/nodes')return{nodes:availableNodes};
   if(path.endsWith('/application-runtimes'))return{applicationRuntime:{supported:true,managed:true,runtimes:[{kind:'nodejs',available:true,managedAvailable:true,latest:{version:'v26.0.0'},catalog:{status:'verified'},startupModes:['entrypoint','npm-script']},{kind:'python',available:true,managedAvailable:true,latest:{version:'3.15.0'},catalog:{status:'verified'},startupModes:['entrypoint','python-module']}]}};
   if(path.endsWith('/versions'))return{versions:[version]};
   throw Error('Unexpected fixture route');
  }};
 vm.runInNewContext((action==='createServer'?createCode:cloneCode)+`\nglobalThis.openAction=${action};`,context);
 await context.openAction(action==='cloneServer'?'worker-a:source':undefined);
 return{get markup(){return markup;},async submit(values){request=null;await assert.rejects(submit(values,{dataset:{},elements:{appStartupMode:{value:values.appStartupMode||'entrypoint'}}}),error=>error===sent);return request;},async rejectUnsupported(values){request=null;await assert.rejects(submit(values,{dataset:{},elements:{appStartupMode:{value:values.appStartupMode||'entrypoint'}}}),error=>plainUI(error.message).includes('Update this node to use automatic ports'));assert.equal(request,null);}};
}

test('automatic creation fields are selected by default, hide custom ports and localize authority without a guessed port',()=>{
 const id='create-"<bad>',markup=portAllocationFields({id});
 for(const [language,phrase] of [['en','The selected VPS assigns and reserves random available ports'],['vi','VPS đã chọn cấp và giữ các cổng trống ngẫu nhiên']]){
  globalThis.document=languageDocument;try{setLanguage(language);const html=plainUI(markup);assert.ok(html.includes(phrase));assert.match(html,/<option value="auto" selected>/);assert.match(html,/data-port-allocation-manual hidden/);assert.match(html,/name="port"[^>]*disabled/);assert.match(html,/name="portV6"[^>]*disabled/);assert.doesNotMatch(html,/value="(?:19132|19133|30000)"/);assert.doesNotMatch(html,/<bad>/);}finally{if(hadDocument)globalThis.document=previousDocument;else delete globalThis.document;}
 }
 globalThis.document=languageDocument;try{setLanguage('en');}finally{if(hadDocument)globalThis.document=previousDocument;else delete globalThis.document;}
});

test('automatic serializer ignores stale manual numbers and emits only the authoritative allocation request',()=>{
 for(const application of [false,true])for(const values of [{},{portAllocation:'auto'},{portAllocation:'auto',port:'19132',portV6:'19133',udpPorts:'20000-21000',debugPort:'39999'}]){
  const before=structuredClone(values);assert.deepEqual(portAllocationFromValues(values,{application}),{portAllocation:'auto'});assert.deepEqual(values,before);
 }
});

test('manual serialization requires valid integers and application payloads never contain Bedrock-only fields',()=>{
 assert.deepEqual(portAllocationFromValues({portAllocation:'manual',port:'42000',portV6:'42001'}),{portAllocation:'manual',port:42000,portV6:42001});
 for(const kind of ['nodejs','python'])assert.deepEqual(portAllocationFromValues({portAllocation:'manual',port:'42000',portV6:'broken',udpPorts:'bad'},{application:isApplication(kind)}),{portAllocation:'manual',port:42000});
 for(const value of ['',null,undefined,'1023','65536','3.5','invalid'])assert.throws(()=>portAllocationFromValues({portAllocation:'manual',port:value,portV6:'42001'}));
 assert.throws(()=>portAllocationFromValues({portAllocation:'manual',port:'42000',portV6:''}));assert.throws(()=>portAllocationFromValues({portAllocation:'unexpected'}));
});

test('automatic availability requires the chosen node capability and keeps custom ports usable on older agents',()=>{
 assert.equal(portAllocationState(nodes[0]).allowed,true);
 for(const capability of [undefined,null,{}, {...automaticCapability,supported:false},{...automaticCapability,schemaVersion:2},{...automaticCapability,mode:'manual'},{...automaticCapability,authority:'controller'}]){
  const node={portAllocation:capability};assert.equal(portAllocationState(node).allowed,false);assert.match(plainUI(portAllocationState(node).reason),/Update this node/);assert.equal(portAllocationState(node,{mode:'manual'}).allowed,true);
 }
 assert.equal(portAllocationState(null).allowed,false);
});

test('actual control synchronization excludes hidden fields and never changes port values on node/runtime transitions',()=>{
 const blocks=Object.fromEntries(['auto','manual','v6'].map(key=>[`[data-port-allocation-${key}]`,{hidden:false}]));
 const form={elements:{portAllocation:{value:'auto'},port:{value:''},portV6:{value:''},nodeId:{value:'local'}},querySelector:selector=>blocks[selector]||null};
 for(const node of nodes){form.elements.nodeId.value=node.id;for(const application of [false,true]){syncPortAllocation(form,{application});assert.equal(form.elements.port.disabled,true);assert.equal(form.elements.port.required,false);assert.equal(form.elements.portV6.disabled,true);assert.equal(blocks['[data-port-allocation-manual]'].hidden,true);assert.equal(form.elements.port.value,'');assert.equal(form.elements.portV6.value,'');}}
 form.elements.portAllocation.value='manual';form.elements.port.value='42000';form.elements.portV6.value='42001';syncPortAllocation(form);assert.equal(form.elements.port.required,true);assert.equal(form.elements.portV6.required,true);assert.equal(blocks['[data-port-allocation-auto]'].hidden,true);
 syncPortAllocation(form,{application:true});assert.equal(form.elements.port.required,true);assert.equal(form.elements.portV6.disabled,true);assert.equal(form.elements.portV6.required,false);assert.equal(blocks['[data-port-allocation-v6]'].hidden,true);
 syncPortAllocation(form,{disabled:true});assert.equal(form.elements.portAllocation.disabled,true);assert.equal(form.elements.port.required,false);assert.equal(form.elements.portV6.required,false);
 form.elements.portAllocation.value='auto';syncPortAllocation(form);assert.equal(form.elements.port.value,'42000');assert.equal(form.elements.portV6.value,'42001');assert.equal(form.elements.port.disabled,true);assert.deepEqual(portAllocationFromValues({portAllocation:'auto',port:form.elements.port.value,portV6:form.elements.portV6.value}),{portAllocation:'auto'});
});

test('real create submit callbacks target the selected VPS and omit numeric fields for all three automatic runtimes',async()=>{
 const harness=await submitHarness();assert.match(harness.markup,/name="portAllocation"/);
 for(const [index,kind] of ['bedrock','nodejs','python'].entries()){
  const request=await harness.submit({nodeId:nodes[index].id,kind,name:'QA',portAllocation:'auto',port:'stale',portV6:'stale',storageDiskGiB:'1',version:version.version,versionChannel:'stable',maxPlayers:'8',eula:'on'});
  assert.equal(request.path,'/servers');assert.equal(request.body.nodeId,nodes[index].id);assert.equal(request.body.kind,kind);assert.equal(request.body.portAllocation,'auto');for(const key of ['port','portV6','udpPorts','debugPort'])assert.equal(Object.hasOwn(request.body,key),false);
  if(kind==='bedrock'){assert.equal(request.body.version,version.version);assert.equal(request.body.maxPlayers,8);}else{assert.equal(request.body.application.entrypoint,kind==='python'?'app.py':'server.js');for(const key of ['version','channel','maxPlayers','eula'])assert.equal(Object.hasOwn(request.body,key),false);}
 }
});

test('real create submit callbacks preserve explicit custom ports only when manual allocation is selected',async()=>{
 const harness=await submitHarness();
 for(const kind of ['bedrock','nodejs','python']){
  const request=await harness.submit({nodeId:'worker-b',kind,name:'QA',portAllocation:'manual',port:'42000',portV6:'42001',storageDiskGiB:'1',version:version.version,maxPlayers:'8',eula:'on'});
  assert.equal(request.body.portAllocation,'manual');assert.equal(request.body.port,42000);assert.equal(Object.hasOwn(request.body,'portV6'),kind==='bedrock');if(kind==='bedrock')assert.equal(request.body.portV6,42001);
 }
});

test('real clone submit callback requests fresh automatic ports on the source VPS and supports an explicit manual override',async()=>{
 const harness=await submitHarness('cloneServer');assert.match(harness.markup,/clone-port-allocation/);assert.match(harness.markup,/<option value="auto" selected>/);
 const auto=await harness.submit({name:'Clone',portAllocation:'auto',port:'19132',portV6:'19133',eula:'on'});assert.equal(auto.path,'/servers/worker-a%3Asource/clone');assert.deepEqual(auto.body,{name:'Clone',portAllocation:'auto',eula:true});
 const manual=await harness.submit({name:'Clone',portAllocation:'manual',port:'42100',portV6:'42101',eula:'on'});assert.deepEqual(manual.body,{name:'Clone',portAllocation:'manual',port:42100,portV6:42101,eula:true});assert.doesNotMatch(cloneCode,/nextPort|Number\(data\.port/);
});

test('real create and clone submit callbacks reject missing old-agent support before any POST, with manual override still available',async()=>{
 const oldNodes=nodes.map(node=>({...node,portAllocation:null}));
 for(const action of ['createServer','cloneServer']){
  const harness=await submitHarness(action,oldNodes),values={nodeId:'worker-a',name:'QA',kind:'bedrock',portAllocation:'auto',version:version.version,maxPlayers:'8',storageDiskGiB:'1',eula:'on'};
  await harness.rejectUnsupported(values);const manual=await harness.submit({...values,portAllocation:'manual',port:'42000',portV6:'42001'});assert.equal(manual.body.portAllocation,'manual');assert.equal(manual.body.port,42000);
 }
});
