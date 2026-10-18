import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const previous=globalThis.document;
globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
const {applicationProjectMarkup,projectFileName,projectManifestTemplate,projectManifestCanCreate,bindApplicationProject}=await import('../public/application-project.js');
const {applicationFromValues,applicationRuntimeState,applicationFields,applicationRuntimeMarkup,applicationStartupModeSupported}=await import('../public/application-workspace.js');
const {plainUI}=await import('../public/i18n.js');
if(previous)globalThis.document=previous;else delete globalThis.document;
const server={id:'remote:app',kind:'nodejs',status:'stopped',runtime:{mode:'managed',version:'26.0.0',source:'nodejs.org',method:'binary'}};
const data={server,project:{runtime:server.runtime,manifests:[{name:'package.json',present:true,packageManager:'npm',dependencies:2,devDependencies:1,scripts:[{name:'start',command:'node server.js'},{name:'<build>',command:'<script>redacted</script>'}]},{name:'package-lock.json',present:false}],dependencyState:{status:'installed',manifest:'package.json',installedAt:'2026-10-18T02:00:00Z'},packages:[{name:'<actual-package>',version:'1.2.3'}]}};
const render=(value=data,options={})=>plainUI(applicationProjectMarkup(value,{canManage:()=>true,...options}));

test('project inspection shows actual pinned runtime, manifest counts, scripts and installed package metadata safely',()=>{
 const html=render();assert.match(html,/Pinned official runtime/);assert.match(html,/26\.0\.0/);assert.match(html,/2 dependencies/);assert.match(html,/1 development dependencies/);assert.match(html,/node server\.js/);assert.match(html,/&lt;actual-package&gt;/);assert.match(html,/&lt;script&gt;redacted/);assert.doesNotMatch(html,/<script>|<actual-package>/);assert.match(html,/data-app-project-file="package-lock.json" data-present="false" disabled/);assert.doesNotMatch(html,/PRIVATE|Environment values/);
});
test('old nodes expose no fake project controls and missing metadata never claims dependency-free success',()=>{
 assert.match(render({server}),/Update its agent/);assert.doesNotMatch(render({server}),/data-app-project-file=/);
 const html=render({server,project:{manifests:[{name:'requirements.txt',present:false}],dependencyState:{status:'unknown'},packages:[]}});assert.match(html,/Not verified/);assert.match(html,/does not confirm/);assert.match(html,/Create file/);assert.doesNotMatch(html,/Installed<\/span>/);
});
test('manifest paths are fixed allowlisted filenames; running apps, offline nodes and viewers cannot edit',()=>{
 for(const name of ['package.json','package-lock.json','npm-shrinkwrap.json','requirements.txt'])assert.equal(projectFileName(name),name);
 for(const name of ['package-lock.json','npm-shrinkwrap.json']){assert.equal(projectManifestCanCreate(name),false);assert.throws(()=>projectManifestTemplate(name));}
 for(const name of ['../package.json','/etc/passwd','server.js','PACKAGE.JSON'])assert.throws(()=>projectFileName(name));
 assert.equal(JSON.parse(projectManifestTemplate('package.json')).scripts.start,'node server.js');assert.match(projectManifestTemplate('requirements.txt'),/^#/);
 for(const state of [{status:'running'},{busy:true},{nodeOnline:false},{recoveryRequired:true}])assert.match(render({...data,server:{...server,...state}}),/data-app-project-file="package.json" data-present="true" disabled/);
 assert.match(render(data,{canManage:()=>false}),/data-app-project-file="package.json" data-present="true" disabled/);
});
test('package lists remain bounded and truncation is explicit rather than claiming full inspection',()=>{
 const value={...data,project:{...data.project,packages:Array.from({length:205},(_,index)=>({name:`package-${index}`,version:'1'})),packagesTruncated:true}},html=render(value);assert.match(html,/200 \/ 205\+/);assert.match(html,/omits additional package records/);assert.match(html,/Showing 200 of 205 reported/);assert.doesNotMatch(html,/package-200<\/dt>/);
 const local=render({...value,project:{...value.project,packagesTruncated:false}});assert.match(local,/Showing 200 of 205 reported/);assert.match(local,/200 \/ 205</);assert.doesNotMatch(local,/205\+/);
});
test('an existing npm shrinkwrap is inspectable/editable but absent lockfiles have no manual create action',()=>{
 const present=render({...data,project:{...data.project,manifests:[{name:'npm-shrinkwrap.json',present:true}]}});assert.match(present,/data-app-project-file="npm-shrinkwrap.json" data-present="true" >/);
 const absent=render({...data,project:{...data.project,manifests:[{name:'npm-shrinkwrap.json',present:false}]}});assert.match(absent,/data-app-project-file="npm-shrinkwrap.json" data-present="false" disabled/);
});
test('managed latest creation availability is separate from a legacy host runtime and requires prerequisites',()=>{
 const caps={supported:true,managed:true,runtimes:[{kind:'python',available:false,managedAvailable:true,latest:{version:'3.15.0'},catalog:{status:'verified'}}]};
 assert.equal(applicationRuntimeState(caps,'python').available,false);assert.equal(applicationRuntimeState(caps,'python',{creating:true}).available,true);assert.equal(applicationRuntimeState({...caps,runtimes:[{...caps.runtimes[0],available:true,managedAvailable:false}]},'python',{creating:true}).available,false);assert.equal(applicationRuntimeState({...caps,supported:false},'python',{creating:true}).available,false);
 const legacy={supported:true,runtimes:[{kind:'nodejs',available:true}]};assert.equal(applicationRuntimeState(legacy,'nodejs').available,true);const blocked=applicationRuntimeState(legacy,'nodejs',{creating:true});assert.equal(blocked.available,false);assert.match(plainUI(blocked.reason),/Update this node/);
});
test('publisher failures clear stale latest and block only that kind of new creation while existing runtimes remain usable',()=>{
 const caps={supported:true,managed:true,runtimes:[{kind:'nodejs',available:true,managedAvailable:true,latest:{version:'v26.0.0'},catalog:{status:'unavailable',reason:'Publisher unavailable'}},{kind:'python',available:true,managedAvailable:true,latest:{version:'3.15.0'},catalog:{status:'verified'}}]};
 const blocked=applicationRuntimeState(caps,'nodejs',{creating:true});assert.equal(blocked.available,false);const html=plainUI(applicationRuntimeMarkup('nodejs',blocked));assert.match(html,/Publisher unavailable/);assert.doesNotMatch(html,/v26\.0\.0/);assert.match(html,/data-app-runtime-refresh/);assert.equal(applicationRuntimeState(caps,'python',{creating:true}).available,true);assert.equal(applicationRuntimeState(caps,'nodejs').available,true);
 const pinned={runtime:{mode:'managed',version:'v26.0.0'}};assert.equal(applicationRuntimeState(caps,'nodejs',{server:pinned,runtimeAvailability:{mode:'managed',kind:'nodejs',version:'v26.0.0',available:true}}).available,true);
});
test('async startup-mode control upgrade replaces only its slot and preserves typed arguments/environment on node changes',async()=>{
 const source=await readFile(new URL('../public/application-workspace.js',import.meta.url),'utf8'),start=source.indexOf('function startupModeMarkup('),end=source.indexOf('export function applicationFields(',start),code=source.slice(start,end).replace('export function syncApplicationStartupModes','function syncApplicationStartupModes');let replaced,cleaned=0;
 const control={id:'create-app-startup-mode',value:'npm-script'},slot={querySelector:()=>control,replaceWith:value=>{replaced=value;}},draftArgs={value:'["typed --literal", "hello world"]'},draftEnvironment={value:'[{"name":"API_KEY","value":"typed-secret","secret":true}]'},root={matches:()=>true,dataset:{applicationDisabled:'false'},querySelector:selector=>selector==='[data-app-startup-mode-slot]'?slot:null,ownerDocument:{createElement:()=>({content:{firstElementChild:{}}})},draftArgs,draftEnvironment};
 const context={text:en=>en,escape:value=>String(value),uiHTML:(template,markup)=>{template.content.firstElementChild={markup};}};vm.createContext(context);vm.runInContext(code+';this.upgrade=syncApplicationStartupModes;',context);
 assert.equal(context.upgrade(root,['entrypoint','npm-script'],{beforeReplace:value=>{assert.strictEqual(value,slot);cleaned++;}}),true);assert.match(replaced.markup,/<option value="npm-script" selected/);assert.equal(root.draftArgs.value,'["typed --literal", "hello world"]');assert.match(root.draftEnvironment.value,/typed-secret/);assert.strictEqual(root.draftArgs,draftArgs);assert.equal(cleaned,1);
 context.upgrade(root,['entrypoint']);assert.match(replaced.markup,/<option value="npm-script" selected disabled/);assert.match(replaced.markup,/Unavailable on this VPS/);assert.equal(control.value,'npm-script');assert.equal(applicationStartupModeSupported({startupModes:['entrypoint']},control.value),false);assert.equal(applicationStartupModeSupported({startupModes:['entrypoint','npm-script']},control.value),true);
});
test('changed manifests are labeled as an outdated last installation rather than claiming installed packages are current',()=>{
 const html=render({...data,project:{...data.project,dependencyState:{status:'outdated',manifestChanged:true,manifest:'package.json'}}});assert.match(html,/Last installation/);assert.match(html,/Manifest changed · reinstall/);assert.doesNotMatch(html,/Manifest unchanged since install/);
});
test('an existing managed Python pin uses exact cache availability without borrowing the host venv or new build prerequisites',()=>{
 const caps={supported:true,managed:true,runtimes:[{kind:'python',available:false,managedAvailable:false,prerequisites:{ready:false}}]},pinned={kind:'python',runtime:{mode:'managed',kind:'python',version:'3.15.0'}},selected={mode:'managed',kind:'python',version:'3.15.0',available:true};
 assert.equal(applicationRuntimeState(caps,'python',{server:pinned,runtimeAvailability:selected}).available,true);assert.equal(applicationRuntimeState(caps,'python',{creating:true}).available,false);assert.equal(applicationRuntimeState(caps,'python',{server:{kind:'python'},runtimeAvailability:selected}).available,false);
 for(const change of [{available:false},{version:'3.14.0'},{kind:'nodejs'},{mode:'legacy'}])assert.equal(applicationRuntimeState(caps,'python',{server:pinned,runtimeAvailability:{...selected,...change}}).available,false);
 assert.equal(applicationRuntimeState(caps,'python',{server:pinned}).available,false);
});
test('startup serialization keeps legacy entrypoint payloads while scripts and modules remain explicit data',()=>{
 const base={entrypoint:'server.js',args:['--label','hello world'],environment:[],dependencies:'none'};
 assert.equal(Object.hasOwn(applicationFromValues(base,{kind:'nodejs'}),'startup'),false);
 assert.deepEqual(applicationFromValues({...base,appStartupMode:'npm-script',appStartupScript:'start:prod'},{kind:'nodejs'}).startup,{mode:'npm-script',script:'start:prod'});
 assert.deepEqual(applicationFromValues({...base,entrypoint:'app.py',appStartupMode:'python-module',appStartupModule:'my_project.worker'},{kind:'python'}).startup,{mode:'python-module',module:'my_project.worker'});
 assert.equal(applicationFromValues({...base,appEntrypoint:'',appStartupMode:'npm-script',appStartupScript:'start'},{kind:'nodejs',previous:{entrypoint:'src/main.js'}}).entrypoint,'src/main.js');
 assert.deepEqual(applicationFromValues(base,{kind:'nodejs',previous:{startup:{mode:'npm-script',script:'start'}}}).startup,{mode:'npm-script',script:'start'});
 for(const script of ['-start','start;id','hello world','a'.repeat(81),'$(cmd)'])assert.throws(()=>applicationFromValues({...base,appStartupMode:'npm-script',appStartupScript:script},{kind:'nodejs'}));
 for(const module of ['../worker','my-project.worker','.worker','hello;id','é','a'.repeat(201)])assert.throws(()=>applicationFromValues({...base,entrypoint:'app.py',appStartupMode:'python-module',appStartupModule:module},{kind:'python'}));
 assert.throws(()=>applicationFromValues({...base,appStartupMode:'python-module',appStartupModule:'worker'},{kind:'nodejs'}));
});
test('startup controls follow the selected runtime capability; persisted modes do not silently downgrade',()=>{
 const legacy=plainUI(applicationFields({kind:'nodejs'}));assert.match(legacy,/type="hidden" name="appStartupMode" value="entrypoint"/);assert.doesNotMatch(legacy,/<option value="npm-script"/);
 const modern=plainUI(applicationFields({kind:'nodejs',startupModes:['entrypoint','npm-script'],application:{startup:{mode:'npm-script',script:'start'}}}));assert.match(modern,/<option value="npm-script" selected/);assert.doesNotMatch(modern,/<option value="python-module"/);assert.match(modern,/data-app-startup-for="entrypoint" hidden/);
 const persisted=plainUI(applicationFields({kind:'python',application:{startup:{mode:'python-module',module:'worker'}}}));assert.match(persisted,/<option value="python-module" selected/);assert.match(persisted,/value="worker"/);
});
test('real project binding only opens a reported owned manifest and respects current runtime state',async()=>{
 let listener,opened;const button={dataset:{appProjectFile:'package.json',present:'true'},disabled:false,hasAttribute:()=>false},refresh={disabled:false};const root={querySelectorAll:selector=>selector==='[data-app-project-file]'?[button]:[],querySelector:selector=>selector==='[data-app-project-refresh]'?refresh:null,contains:target=>target===button,addEventListener:(name,callback)=>{listener=callback;},removeEventListener(){}};const panel={isConnected:true,querySelector:()=>root};let current={...server};
 const binding=bindApplicationProject(panel,data,{canManage:()=>true,findServer:()=>current,editProjectFile:async(name,present)=>{opened={name,present};}});
 await listener({target:{closest:()=>button}});assert.deepEqual(opened,{name:'package.json',present:true});opened=null;current={...server,status:'running'};binding.sync();await listener({target:{closest:()=>button}});assert.equal(opened,null);current={...server};binding.sync();panel.isConnected=false;await listener({target:{closest:()=>button}});assert.equal(opened,null);binding.destroy();
});

const projectBindingSource=await readFile(new URL('../public/application-project.js',import.meta.url),'utf8');
function freshnessHarness(){
 const inspectedAt='2026-10-18T04:31:28.597Z',fixture={...data,server:{...server,consoleRunId:'run-1'},project:{...data.project,inspectionAvailable:true,inspectedAt}};
 let actual={...fixture.server},listener,metadataWrites=0,slotWrites=0,details=[{dataset:{appProjectDetails:'packages'},open:true},{dataset:{appProjectDetails:'package.json'},open:true},{dataset:{appProjectDetails:'untrusted'},open:true}];
 const slot={markup:''},message={},file={dataset:{appProjectFile:'package.json',present:'true'},disabled:false},refresh={disabled:false,hasAttribute:name=>name==='data-app-project-refresh'};
 const startupDraft={value:'["unsaved argument"]'},calls=[];
 let respond=async()=>fresh('2026-10-18T04:40:00.000Z');
 const root={querySelector:selector=>selector==='[data-app-project-freshness]'?slot:selector==='[data-app-project-refresh]'?refresh:selector==='[data-app-project-message]'?message:null,querySelectorAll:selector=>selector==='[data-app-project-file]'?[file]:selector==='details[data-app-project-details]'?details:[],contains:button=>button===refresh||button===file,addEventListener:(name,callback)=>{if(name==='click')listener=callback;},removeEventListener(){}};
 const panel={isConnected:true,querySelector:selector=>selector==='[data-app-project]'?root:null};
 const context={wireText:(value,metadata)=>metadata.en,formatUI:(value,formatter)=>formatter('en-US',value),beginButtonBusy:()=>()=>{},uiText:(element,value)=>{if(element)element.textContent=value;},uiHTML:(element,markup)=>{if(element===slot){slotWrites++;slot.markup=markup;}else if(element===root){metadataWrites++;details=details.map(detail=>({dataset:{...detail.dataset},open:false}));}else throw Error('Unexpected DOM target');}};
 vm.createContext(context);vm.runInContext(projectBindingSource.replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'')+';this.bind=bindApplicationProject;',context);
 const binding=context.bind(panel,fixture,{canManage:()=>true,findServer:()=>actual,api:async(...args)=>{calls.push(args);return respond();}});
 function fresh(at){return{...fixture,server:{...actual},project:{...fixture.project,inspectionAvailable:true,inspectedAt:at}};}
 return{binding,slot,file,refresh,panel,startupDraft,calls,message,fresh,inspectedAt,get details(){return details;},get metadataWrites(){return metadataWrites;},get slotWrites(){return slotWrites;},setServer:patch=>{actual={...fixture.server,...patch};},setResponse:callback=>{respond=callback;},clickRefresh:()=>listener({target:{closest:()=>refresh}})};
}

test('project freshness always has its own slot, and active or cached snapshots cannot claim a fresh inspection',()=>{
 assert.match(render({server}),/<div data-app-project-freshness><\/div>/);
 const project={...data.project,inspectionAvailable:true,inspectedAt:'2026-10-18T04:31:28.597Z'};
 assert.match(render({...data,project}),/class="application-project-freshness">Inspected /);
 assert.match(render({...data,server:{...server,status:'running'},project}),/application-project-freshness is-cached/);
 assert.match(render({...data,project:{...project,inspectionAvailable:false}}),/Cached inspection\. Refresh/);
 const noSample=render({...data,server:{...server,status:'running'},project:{...project,inspectedAt:'not-a-date'}});assert.match(noSample,/Stop the application to inspect/);assert.doesNotMatch(noSample,/<time datetime="not-a-date"/);
 const neverSampled=render({...data,project:{...project,inspectionAvailable:false,inspectedAt:null}});assert.match(neverSampled,/Refresh to inspect project files/);assert.doesNotMatch(neverSampled,/Cached inspection\.|>Inspected /);
});

test('real project sync marks external starts cached and stays cached after stop without replacing drafts or expanded details',()=>{
 const h=freshnessHarness(),draft=h.startupDraft,details=[...h.details];assert.match(h.slot.markup,/>Inspected /);
 h.setServer({status:'running'});h.binding.sync();assert.match(h.slot.markup,/is-cached/);assert.match(h.slot.markup,/Last inspected while stopped/);assert.match(h.slot.markup,new RegExp(h.inspectedAt.replaceAll('.','\\.')));assert.equal(h.file.disabled,true);
 h.setServer({status:'stopped'});h.binding.sync();assert.match(h.slot.markup,/Cached inspection\. Refresh/);assert.equal(h.file.disabled,false);
 assert.strictEqual(h.startupDraft,draft);assert.equal(draft.value,'["unsaved argument"]');for(let index=0;index<details.length;index++){assert.strictEqual(h.details[index],details[index]);assert.equal(h.details[index].open,true);}
 const writes=h.slotWrites;h.binding.sync();h.binding.sync();assert.equal(h.slotWrites,writes);assert.equal(h.metadataWrites,0);assert.equal(h.calls.length,0);h.binding.destroy();
});

test('busy, recovery, unreachable and changed run identities invalidate the sample until actual inspection',()=>{
 for(const patch of [{status:'starting'},{busy:true},{recoveryRequired:true},{nodeOnline:false},{consoleRunId:'run-2'}]){
  const h=freshnessHarness();h.setServer(patch);h.binding.sync();assert.match(h.slot.markup,/is-cached/);assert.equal(h.refresh.disabled,patch.nodeOnline===false);
  h.setServer({status:'stopped'});h.binding.sync();assert.match(h.slot.markup,/Cached inspection\. Refresh/);assert.equal(h.calls.length,0);h.binding.destroy();
 }
});

test('an explicit successful inspection clears cached state and retains only vetted expanded detail keys and startup draft',async()=>{
 const h=freshnessHarness(),draft=h.startupDraft;h.setServer({status:'running'});h.binding.sync();h.setServer({status:'stopped'});h.binding.sync();
 await h.clickRefresh();assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'/servers/remote%3Aapp/application');assert.match(h.slot.markup,/>Inspected /);assert.doesNotMatch(h.slot.markup,/is-cached/);assert.match(h.slot.markup,/2026-10-18T04:40:00.000Z/);
 assert.equal(h.metadataWrites,1);assert.strictEqual(h.startupDraft,draft);assert.equal(draft.value,'["unsaved argument"]');assert.equal(h.details.find(row=>row.dataset.appProjectDetails==='packages').open,true);assert.equal(h.details.find(row=>row.dataset.appProjectDetails==='package.json').open,true);assert.equal(h.details.find(row=>row.dataset.appProjectDetails==='untrusted').open,false);h.binding.destroy();
});

test('running summaries, missing inspection samples and failed refreshes never clear a cached inspection',async()=>{
 for(const result of ['running','missing-sample','failed']){
  const h=freshnessHarness();h.setServer({status:'running'});h.binding.sync();h.setServer({status:'stopped'});h.binding.sync();
  h.setResponse(async()=>{if(result==='failed')throw Error('Inspection unavailable');const response=h.fresh('2026-10-18T04:45:00.000Z');if(result==='running'){response.server.status='running';response.project.inspectionAvailable=false;}else delete response.project.inspectedAt;return response;});
  await h.clickRefresh();assert.match(h.slot.markup,/is-cached/);assert.equal(h.calls.length,1);if(result==='failed'){assert.equal(h.message.textContent,'Inspection unavailable');assert.equal(h.metadataWrites,0);}h.binding.destroy();
 }
});

test('an inspection response cannot erase a newer start-stop observation while its request was in flight',async()=>{
 const h=freshnessHarness();let release;h.setResponse(()=>new Promise(resolve=>{release=resolve;}));const pending=h.clickRefresh();assert.equal(h.calls.length,1);
 h.setServer({status:'running'});h.binding.sync();h.setServer({status:'stopped'});h.binding.sync();release(h.fresh('2026-10-18T04:45:00.000Z'));await pending;
 assert.match(h.slot.markup,/Cached inspection\. Refresh/);assert.match(h.slot.markup,/2026-10-18T04:45:00.000Z/);
 h.setResponse(async()=>h.fresh('2026-10-18T04:46:00.000Z'));await h.clickRefresh();assert.doesNotMatch(h.slot.markup,/is-cached/);assert.equal(h.calls.length,2);h.binding.destroy();
});

test('current active state is rechecked when an inspection resolves even if dashboard sync has not run yet',async()=>{
 const h=freshnessHarness();let release;h.setResponse(()=>new Promise(resolve=>{release=resolve;}));const pending=h.clickRefresh();const response=h.fresh('2026-10-18T04:45:00.000Z');h.setServer({status:'running'});release(response);await pending;
 assert.match(h.slot.markup,/is-cached/);assert.match(h.slot.markup,/Stop the application and refresh/);assert.equal(h.file.disabled,true);h.binding.destroy();
});

test('identity-mismatched refreshes and disposed bindings cannot replace project evidence or schedule more requests',async()=>{
 const h=freshnessHarness();h.setResponse(async()=>({...h.fresh('2026-10-18T04:45:00.000Z'),server:{...server,id:'other-server'}}));await h.clickRefresh();assert.match(h.message.textContent,/Project identity changed/);assert.equal(h.metadataWrites,0);assert.match(h.slot.markup,/is-cached/);
 const writes=h.slotWrites;h.binding.destroy();h.setServer({status:'running'});h.binding.sync();await h.clickRefresh();assert.equal(h.calls.length,1);assert.equal(h.slotWrites,writes);
});
