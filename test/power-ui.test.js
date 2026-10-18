import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const previousDocument=globalThis.document,hadDocument=Object.hasOwn(globalThis,'document');
globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
let powerPath,powerState,powerActionAllowed,powerObservation,powerImpact,powerControlsMarkup,handlePowerAction,panelVersionLabel,refreshPanelVersion,resetPowerClientState,plainUI;
try{({powerPath,powerState,powerActionAllowed,powerObservation,powerImpact,powerControlsMarkup,handlePowerAction,panelVersionLabel,refreshPanelVersion,resetPowerClientState}=await import('../public/power-controls.js'));({plainUI}=await import('../public/i18n.js'));}
finally{if(hadDocument)globalThis.document=previousDocument;else delete globalThis.document;}

const power={nodeId:'worker',role:'worker',instanceId:'service-before',bootId:'boot-before',revision:'revision-before',available:true,actions:['restart-service','reboot']};

test('runtime version is validated and public UI never embeds a release literal',async()=>{
 assert.equal(panelVersionLabel('0.12.0'),'v0.12.0');assert.equal(panelVersionLabel('1.2.3-beta.1'),'v1.2.3-beta.1');
 for(const value of [undefined,null,'','latest','<img src=x>','v1.2.3'])assert.equal(plainUI(panelVersionLabel(value)),'Version unavailable');
 for(const file of ['index.html','app.js']){const content=await readFile(new URL(`../public/${file}`,import.meta.url),'utf8');assert.doesNotMatch(content,/v\d+\.\d+\.\d+/);assert.match(content,/data-panel-version/);}
});

test('version refresh reads healthz without caching and clears stale version if unavailable',async()=>{
 const seen=[],root={querySelectorAll:()=>[]};
 assert.equal(await refreshPanelVersion(async(path,options)=>{seen.push({path,options});return {ok:true,json:async()=>({version:'0.12.0'})};},root),'0.12.0');
 assert.equal(seen[0].path,'/healthz');assert.equal(seen[0].options.cache,'no-store');assert.equal(panelVersionLabel(),'v0.12.0');
 await refreshPanelVersion(async()=>({ok:false}),root);assert.equal(plainUI(panelVersionLabel()),'Version unavailable');
});

test('power availability fails closed and response identity is checked',()=>{
 assert.equal(powerPath('local'),'/host/power');assert.equal(powerPath('node / one'),'/nodes/node%20%2F%20one/power');
 assert.strictEqual(powerState({nodeId:'worker',power},'worker'),power);
 for(const response of [{power},{nodeId:'other',power},{nodeId:'worker',power:{...power,nodeId:'other'}}])assert.throws(()=>powerState(response,'worker'));
 for(const action of power.actions)assert.equal(powerActionAllowed(power,action),true);
 for(const change of [{available:false},{role:'unknown'},{revision:null},{revision:''},{actions:[]},{actions:['shell']}])assert.equal(powerActionAllowed({...power,...change},'restart-service'),false);
 assert.equal(powerActionAllowed(power,'delete'),false);
});

test('accepted and completed response labels do not prove a service restart without a new instance',()=>{
 const request={requestId:'restart',action:'restart-service',baseline:{instanceId:power.instanceId,bootId:power.bootId}};
 assert.equal(powerObservation({...power,lastOperation:{requestId:'restart',status:'accepted'}},request).status,'accepted');
 assert.equal(powerObservation({...power,lastOperation:{requestId:'restart',status:'completed'}},request).status,'unknown');
 assert.equal(powerObservation({...power,instanceId:'service-after'},request).status,'completed');
 assert.equal(powerObservation({...power,bootId:'boot-after'},request).status,'unknown');
 assert.equal(powerObservation({...power,lastOperation:{requestId:'different',status:'failed'}},request).status,'unknown');
 assert.equal(powerObservation({...power,lastOperation:{requestId:'restart',status:'failed',error:'Unit rejected'}},request).error,'Unit rejected');
});

test('reboot completion requires a changed boot identity rather than a service-only restart',()=>{
 const request={requestId:'reboot',action:'reboot',baseline:{instanceId:power.instanceId,bootId:power.bootId}};
 assert.equal(powerObservation({...power,instanceId:'service-after'},request).status,'unknown');
 assert.equal(powerObservation({...power,bootId:'boot-after'},request).status,'completed');
 assert.equal(powerObservation({...power,bootId:null},request).status,'unknown');
 assert.equal(powerObservation({...power,bootId:'boot-after'},{...request,baseline:{bootId:null}}).status,'unknown');
});

test('power controls escape VPS names and distinguish panel, worker and reboot impact',()=>{
 const markup=plainUI(powerControlsMarkup({id:'<worker>',name:'<script>unsafe</script>'}));assert.ok(markup.includes('&lt;worker&gt;'));assert.ok(markup.includes('&lt;script&gt;unsafe&lt;/script&gt;'));assert.equal(markup.includes('<script>'),false);assert.match(markup,/data-power-action="restart-service" disabled/);assert.match(markup,/data-power-action="reboot" disabled/);
 assert.match(plainUI(powerImpact('panel','restart-service')),/other VPS stay running/);assert.match(plainUI(powerImpact('worker','restart-service')),/startup settings/);assert.match(plainUI(powerImpact('panel','reboot')),/Players on this VPS will be disconnected/);assert.match(plainUI(powerImpact('worker','reboot')),/main panel and other VPS stay available/);
});

test('a stale origin or non-admin cannot open a power confirmation',async()=>{
 let opened=0,calls=0;
 const context={isAdmin:()=>true,isCurrent:()=>false,nodes:()=>[],api:async()=>{calls++;return {nodeId:'worker',power};},openModal:async()=>{opened++;}};
 const target={dataset:{nodeId:'worker',powerAction:'reboot'},closest:()=>null};
 assert.equal(await handlePowerAction('vps-power',target,context),true);assert.equal(calls,1);assert.equal(opened,0);
 await assert.rejects(handlePowerAction('vps-power',target,{...context,isAdmin:()=>false}));assert.equal(calls,1);
});

test('reboot requires exact VPS name and acknowledgement before one POST; uncertain outcome is never retried',async()=>{
 const nodeId='test-reboot-once',current={...power,nodeId},calls=[];let submit,body;
 const context={isAdmin:()=>true,isCurrent:()=>true,nodes:()=>[{id:nodeId,name:'VPS A'}],api:async(path,options={})=>{calls.push({path,options});if(options.method==='POST'){const error=Error('Connection lost');error.outcomeUnknown=true;throw error;}return {nodeId,power:current};},openModal:async(title,description,markup,onSubmit)=>{body=plainUI(markup);submit=onSubmit;}};
 const target={dataset:{nodeId,powerAction:'reboot'},closest:()=>null};await handlePowerAction('vps-power',target,context);assert.match(body,/Type the VPS name/);
 const form={dataset:{},isConnected:false};await assert.rejects(submit({acknowledged:'on',confirmName:'wrong'},form));await assert.rejects(submit({confirmName:'VPS A'},form));assert.equal(calls.length,1);
 assert.equal(await submit({acknowledged:'on',confirmName:'VPS A'},form),false);assert.equal(form.dataset.committed,'true');assert.equal(calls.length,2);
 const sent=calls[1].options.body;assert.deepEqual({...sent,requestId:'id'},{nodeId,action:'reboot',confirmed:true,revision:current.revision,requestId:'id'});assert.match(sent.requestId,/^[a-f\d-]{36}$/);
 await assert.rejects(handlePowerAction('vps-power',target,context),error=>/still being checked/.test(plainUI(error.message)));assert.equal(calls.filter(call=>call.options.method==='POST').length,1);
});

test('session cleanup clears client-only pending requests and invalidates stale confirmation callbacks',async()=>{
 const nodeId='session-power',current={...power,nodeId};let submit,posts=0;
 const context={isAdmin:()=>true,isCurrent:()=>true,nodes:()=>[{id:nodeId,name:'VPS Session'}],api:async(path,options={})=>{if(options.method==='POST'){posts++;throw Error('Response unavailable');}return {nodeId,power:current};},openModal:async(title,description,markup,onSubmit)=>{submit=onSubmit;}};
 const target={dataset:{nodeId,powerAction:'restart-service'},closest:()=>null};await handlePowerAction('vps-power',target,context);await submit({acknowledged:'on'},{dataset:{},isConnected:false});assert.equal(posts,1);
 resetPowerClientState();await handlePowerAction('vps-power',target,context);const stale=submit;resetPowerClientState();await stale({acknowledged:'on'},{dataset:{},isConnected:false});assert.equal(posts,1);
 current.lastOperation={requestId:'server-accepted',action:'restart-service',status:'accepted',baseline:{instanceId:current.instanceId,bootId:current.bootId}};
 await assert.rejects(handlePowerAction('vps-power',target,context));assert.equal(posts,1,'backend accepted state still blocks a duplicate after client cleanup');
});
