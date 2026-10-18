import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const previous=globalThis.document;globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
const {projectFileName,projectManifestTemplate,projectManifestCanCreate}=await import('../public/application-project.js');
if(previous)globalThis.document=previous;else delete globalThis.document;
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const fragment=source.slice(source.indexOf('async function editProjectManifest('),source.indexOf('async function reloadFileEditor('));
function harness({error,refreshFails=false}={}){
 const calls=[],opened=[],server={id:'node:actual-app',kind:'nodejs',status:'stopped'};let submit,saved=0;
 const context={projectFileName,projectManifestTemplate,projectManifestCanCreate,state:{servers:[server]},isApplication:row=>row?.kind==='nodejs',canWriteFiles:row=>row.status==='stopped',serverPath:row=>`/servers/${encodeURIComponent(row.id)}`,nodeText:en=>en,t:value=>value,e:value=>value,TextEncoder,editFile:async(...args)=>opened.push(args),openModal:async(title,name,markup,callback)=>{submit=callback;},toast(){},api:async(path,request)=>{calls.push({path,request});if(error)throw error;return{ok:true};}};
 vm.createContext(context);vm.runInContext(fragment+';this.invoke=editProjectManifest;',context);
 return{calls,opened,server,invoke:(name,present)=>context.invoke(name,present,server.id,async()=>{saved++;if(refreshFails)throw Error('Read failed');}),submit:values=>submit(values,{dataset:{dirty:'true'}}),get saved(){return saved;}};
}
test('existing manifests use the real revisioned file editor and exact owning server',async()=>{
 const h=harness();await h.invoke('package.json',true);assert.equal(h.opened[0][0],'package.json');assert.equal(h.opened[0][1],h.server.id);assert.equal(typeof h.opened[0][2],'function');assert.equal(h.calls.length,0);await assert.rejects(h.invoke('../package.json',true));
});
test('new manifest creation uses a fixed owned path once and a later inspection failure cannot replay it',async()=>{
 const h=harness({refreshFails:true});await h.invoke('package.json',false);assert.equal(await h.submit({content:'{"private":true}'}),true);assert.equal(h.calls.length,1);assert.equal(h.calls[0].path,'/servers/node%3Aactual-app/files/create');assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].request.body)),{path:'package.json',content:'{"private":true}'});await assert.rejects(h.submit({content:'{}'}));assert.equal(h.calls.length,1);assert.equal(h.saved,1);
});
test('unknown manifest create outcome and changed application state refuse another mutation',async()=>{
 const h=harness({error:Object.assign(Error('Lost connection'),{outcomeUnknown:true})});await h.invoke('requirements.txt',false);await assert.rejects(h.submit({content:''}));await assert.rejects(h.submit({content:''}));assert.equal(h.calls.length,1);
 const running=harness();await running.invoke('package.json',false);running.server.status='running';await assert.rejects(running.submit({content:'{}'}));assert.equal(running.calls.length,0);const lock=harness();await assert.rejects(lock.invoke('package-lock.json',false));assert.equal(lock.calls.length,0);
});
