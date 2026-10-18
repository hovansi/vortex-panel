import test from 'node:test';
import assert from 'node:assert/strict';
const savedDocument=globalThis.document;
globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
const memory=await import('../public/system-memory.js'),uninstall=await import('../public/node-uninstall.js'),{plainUI}=await import('../public/i18n.js'),{serviceDialogContext,clearServiceSecrets,protectServiceSecrets}=await import('../public/service-ui.js');
if(savedDocument)globalThis.document=savedDocument;else delete globalThis.document;
const nodeId='worker-a',node={id:nodeId,name:'Resource VPS',publicAddress:'192.0.2.4'};
const zram={nodeId,available:true,ownership:'none',physicalMemoryBytes:4*1024**3,configured:{enabled:false,profile:'auto'},effective:{enabled:false},recommended:{logicalSizeBytes:2*1024**3,residentLimitBytes:1024**3},revision:'memory-rev',busy:false,lastOperation:null};
const plan={schemaVersion:1,agentId:'worker-agent',revision:'remove-rev',status:'ready',serverCount:0,blockers:[],components:[{kind:'service',path:'vortex-node.service',action:'remove'}],sshRequired:true,legacyOwnership:false,fullyClean:false};
function fakeDOM(){
 const keys=['document','Node','NodeFilter','HTMLDialogElement','HTMLTemplateElement'],before=Object.fromEntries(keys.map(k=>[k,{present:Object.hasOwn(globalThis,k),value:globalThis[k]}]));
 const secret={value:'not-stored'},classes=new Set(),button={textContent:'',dataset:{},querySelectorAll:()=>[],classList:{add:v=>classes.add(v),remove:v=>classes.delete(v)}},form={isConnected:true,dataset:{},innerHTML:'',querySelectorAll:selector=>selector.includes('password')?[secret]:[],querySelector:()=>button,addEventListener(){},elements:{authMode:{value:'password'}}},modal={open:true,addEventListener(){}};
 globalThis.Node={ELEMENT_NODE:1};globalThis.NodeFilter={SHOW_TEXT:4};globalThis.HTMLDialogElement=class{};globalThis.HTMLTemplateElement=class{};
 globalThis.document={documentElement:{lang:'en'},querySelector:s=>s==='#modal'?modal:s==='#modal-form'?form:null,querySelectorAll:()=>[],createTreeWalker:()=>({nextNode:()=>false})};
 return {form,secret,modal,button,restore:()=>{for(const k of keys)if(before[k].present)globalThis[k]=before[k].value;else delete globalThis[k];}};
}
function context(api,dom){const calls=[],ctx={isAdmin:()=>true,actorId:()=> 'admin',isCurrent:()=>true,nodes:()=>[node],api,toast(){},refresh:async()=>{},openModal:async(...args)=>{calls.push(args);if(calls.length>1)return false;},rebase:()=>({...ctx,isCurrent:()=>dom.form.isConnected&&dom.modal.open})};return {ctx,calls};}
test('system memory state identity, ownership, availability and uncertain operations fail closed',()=>{
 assert.equal(memory.memoryState({nodeId,zram},nodeId),zram);assert.throws(()=>memory.memoryState({nodeId:'other',zram},nodeId));
 assert.equal(memory.memoryActionAllowed(zram),true);for(const change of [{available:false},{ownership:'external'},{ownership:'unknown'},{busy:true},{revision:''},{lastOperation:{status:'unknown'}}])assert.equal(memory.memoryActionAllowed({...zram,...change}),false);
 const markup=plainUI(memory.memoryControlsMarkup({...node,name:'<script>bad</script>'}));assert.match(markup,/does not increase the RAM/);assert.ok(markup.includes('&lt;script&gt;'));assert.doesNotMatch(markup,/<script>/);
});
test('opening system memory configuration is GET-only and stale origins cannot open it',async()=>{
 const dom=fakeDOM();try{const seen=[],{ctx,calls}=context(async(p,o={})=>{seen.push({p,o});return {nodeId,zram};},dom);await memory.handleMemoryAction('memory-config',{dataset:{nodeId}},ctx);assert.equal(calls.length,1);assert.equal(calls[0][6].intent,'positive');assert.equal(seen.length,1);assert.equal(seen[0].o.method,undefined);await memory.handleMemoryAction('memory-config',{dataset:{nodeId}},{...ctx,isCurrent:()=>false});assert.equal(calls.length,1);}finally{dom.restore();memory.resetMemoryClientState();}
});
test('uncertain memory POST clears the password, locks the form and never dispatches again',async()=>{
 const dom=fakeDOM();try{let posts=0;const {ctx,calls}=context(async(p,o={})=>{if(o.method==='POST'){posts++;assert.equal(o.body.password,'admin password');throw Error('Connection lost');}return {nodeId,zram};},dom);await memory.handleMemoryAction('memory-config',{dataset:{nodeId}},ctx);const submit=calls[0][3];await assert.rejects(submit({password:'admin password',acknowledged:'off'},dom.form));await submit({password:'admin password',acknowledged:'on'},dom.form);assert.equal(dom.secret.value,'');assert.equal(dom.form.dataset.committed,'true');assert.match(plainUI(dom.form.innerHTML),/Outcome unconfirmed/);await submit({password:'admin password',acknowledged:'on'},dom.form);assert.equal(posts,1);await assert.rejects(memory.handleMemoryAction('memory-config',{dataset:{nodeId}},ctx));assert.equal(posts,1);}finally{dom.restore();memory.resetMemoryClientState();}
});
test('a rejected old memory request cannot recreate pending state after authentication cleanup',async()=>{
 const dom=fakeDOM();try{let rejectPost;const gate=new Promise((_,reject)=>rejectPost=reject),{ctx,calls}=context(async(p,o={})=>o.method==='POST'?gate:{nodeId,zram},dom);await memory.handleMemoryAction('memory-config',{dataset:{nodeId}},ctx);const active=calls[0][3]({password:'admin password',acknowledged:'on'},dom.form);memory.resetMemoryClientState();rejectPost(Error('Old private error'));await active;dom.form.dataset={};await memory.handleMemoryAction('memory-config',{dataset:{nodeId}},ctx);assert.equal(calls.length,2);}finally{dom.restore();memory.resetMemoryClientState();}
});
test('uninstall plans reject wrong identities, the main VPS and nonempty or unknown inventories',()=>{
 assert.equal(uninstall.uninstallPlan({nodeId,plan},nodeId).plan,plan);assert.throws(()=>uninstall.uninstallPlan({nodeId:'other',plan},nodeId));assert.equal(uninstall.uninstallAllowed(plan,nodeId),true);
 for(const change of [{serverCount:1},{serverCount:null},{serverCount:'0'},{status:'blocked'},{blockers:[{code:'BUSY'}]}])assert.equal(uninstall.uninstallAllowed({...plan,...change},nodeId),false);assert.equal(uninstall.uninstallAllowed(plan,'local'),false);
 assert.equal(uninstall.uninstallObservation({status:'completed',verified:false}),'unknown');assert.equal(uninstall.uninstallObservation({status:'completed',verified:true}),'completed');assert.throws(()=>uninstall.uninstallJob({job:{id:'different',status:'running'}},'expected'));
});
test('verified completion still exposes retained legacy components and a bounded cleanup scope',()=>{
 const job={status:'completed',verified:true,cleanupScope:'active-worker-components',retainedComponents:[{kind:'legacy',path:'/opt/vortex-node/releases/<legacy>',action:'retain',reason:'Unrecorded files remain.'}]},markup=plainUI(uninstall.uninstallRetainedMarkup(job));
 assert.match(markup,/Shared operating-system tools/);assert.match(markup,/Components kept on the VPS/);assert.match(markup,/releases\/&lt;legacy&gt;/);assert.match(markup,/Unrecorded files remain/);assert.doesNotMatch(markup,/<legacy>/);
 assert.match(plainUI(uninstall.uninstallRetainedMarkup({...job,retainedComponents:undefined,retained:[{path:'/legacy-copy',action:'retain'}]})),/legacy-copy/);
});
test('uninstall progresses from credential-free discovery to pinned authentication and one confirmed request',async()=>{
 const dom=fakeDOM();try{const seen=[],job={id:'remove-job',nodeId,requestId:'accepted-id',status:'unknown',verified:false};const {ctx,calls}=context(async(p,o={})=>{seen.push({p,o});if(p===uninstall.uninstallPath(nodeId)&&!o.method)return {nodeId,name:node.name,address:node.publicAddress,plan};if(p==='/nodes/ssh/check')return {hostFingerprint:'SHA256:test-key',authenticated:Boolean(o.body.username),host:{root:true}};return {job};},dom);await uninstall.openNodeUninstall(node,ctx);assert.equal(seen.length,1);const submit=calls[0][3],values={host:node.publicAddress,port:22,username:'root',authMode:'password',password:'ssh secret',adminPassword:'admin secret',confirmationName:node.name,acknowledged:'on'};
 await submit({...values},dom.form);assert.deepEqual(seen[1].o.body,{host:node.publicAddress,port:22});await submit({...values},dom.form);assert.equal(seen[2].o.body.hostFingerprint,'SHA256:test-key');assert.equal(seen[2].o.body.adminPassword,undefined);assert.equal(dom.button.dataset.intent,'danger');
 await assert.rejects(submit({...values,confirmationName:'wrong'},dom.form));await submit({...values},dom.form);assert.equal(seen.filter(x=>x.p===uninstall.uninstallPath(nodeId)&&x.o.method==='POST').length,1);const sent=seen.at(-1).o.body;assert.equal(sent.revision,plan.revision);assert.equal(sent.adminPassword,'admin secret');assert.equal(sent.ssh.password,'ssh secret');assert.equal(sent.ssh.hostFingerprint,'SHA256:test-key');assert.equal(dom.secret.value,'');await submit({...values},dom.form);assert.equal(seen.length,4);
 }finally{dom.restore();}
});
test('recovery verification never dispatches the uninstall endpoint',async()=>{
 const dom=fakeDOM();try{const seen=[],job={id:'existing-job',nodeId,requestId:'original-request',status:'partial'};const {ctx,calls}=context(async(p,o={})=>{seen.push({p,o});return p==='/nodes/ssh/check'?{hostFingerprint:'SHA256:test',authenticated:Boolean(o.body.username),host:{root:true}}:{job};},dom);await uninstall.openNodeUninstall(node,ctx,{verifyJob:job});assert.equal(seen.length,0);const submit=calls[0][3],values={host:node.publicAddress,port:22,username:'root',authMode:'password',password:'ssh',adminPassword:'admin',confirmationName:node.name,acknowledged:'on'};await submit({...values},dom.form);await submit({...values},dom.form);await submit({...values},dom.form);assert.equal(seen.at(-1).p,`${uninstall.uninstallJobPath(job.id)}/verify`);assert.equal(seen.at(-1).o.body.requestId,'original-request');assert.equal(seen.some(x=>x.p===uninstall.uninstallPath(nodeId)),false);}finally{dom.restore();}
});
test('protected service dialog guards and secret cleanup survive close, replacement and actor changes',()=>{
 const dom=fakeDOM();try{let actor='admin';const ctx={actorId:()=>actor,isCurrent:()=>true},guard=serviceDialogContext(ctx,dom.form);assert.equal(guard.isCurrent(),true);dom.modal.open=false;assert.equal(guard.isCurrent(),false);dom.modal.open=true;actor='viewer';assert.equal(guard.isCurrent(),false);clearServiceSecrets(dom.form);assert.equal(dom.secret.value,'');}finally{dom.restore();}
});
test('a queued previous-dialog close cannot consume the current form secret-cleanup listener',()=>{
 const handlers=new Set(),secret={value:'inert private key'},form={isConnected:true,querySelectorAll:()=>[secret]},modal={open:true,addEventListener:(_,fn)=>handlers.add(fn),removeEventListener:(_,fn)=>handlers.delete(fn)},root={querySelector:()=>modal};
 protectServiceSecrets(form,root);for(const fn of [...handlers])fn();assert.equal(secret.value,'inert private key');assert.equal(handlers.size,1);
 modal.open=false;for(const fn of [...handlers])fn();assert.equal(secret.value,'');assert.equal(handlers.size,0);
 secret.value='inert password';modal.open=true;form.isConnected=false;protectServiceSecrets(form,root);for(const fn of [...handlers])fn();assert.equal(secret.value,'');assert.equal(handlers.size,0);
});
