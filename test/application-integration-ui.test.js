import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const prior=globalThis.document;globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
const {isApplication,applicationName,applicationVersionLabel,applicationTabs}=await import('../public/application-workspace.js'),{plainUI}=await import('../public/i18n.js');if(prior)globalThis.document=prior;else delete globalThis.document;
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const escaped=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function renderer(code,extra={}){const state={servers:[],auth:{user:{role:'admin'}},view:'server',serverTab:'console',selected:'test'},context={isApplication,applicationName,applicationVersionLabel,applicationTabs,plainUI,state,e:escaped,icon:name=>`<svg data-icon="${name}"></svg>`,nodeText:en=>en,t:value=>value,lm:(value,key)=>value?.[key],ht:(chunks,...values)=>chunks.map((chunk,index)=>chunk+(values[index]??'')).join(''),serverNodeUnavailable:()=>false,serverAddress:()=>'',status:()=>'<span>running</span>',canManage:()=>true,canEditData:server=>server.status==='stopped',powerAttributes:()=>'',telemetryMarkup:()=>'<div>metrics</div>',btn:label=>`<button>${escaped(label)}</button>`,duration:()=>'',number:value=>value,countRatioUI:(players,max)=>`${players}/${max} players`,resourceChanged:()=>false,...extra};vm.createContext(context);vm.runInContext(code,context);return context;}
const server={id:'test',name:'<My app>',status:'stopped',kind:'nodejs',port:3000,version:'22.20.0',nodeName:'Node 001'};

test('actual app card renderer distinguishes apps from legacy Bedrock and escapes project names',()=>{
 const context=renderer(section('function runtimeLabel(', 'const consolePreferences='));context.server=server;const html=vm.runInContext('serverCard(server,0)',context);
 assert.match(html,/Node\.js 22\.20\.0/);assert.match(html,/&lt;My app&gt;/);assert.doesNotMatch(html,/Bedrock|Stable|data-icon="users"|<My app>/);
 context.server={...server,kind:undefined,version:'1.26.52.3',players:0,maxPlayers:10};const legacy=vm.runInContext('serverCard(server,0)',context);assert.match(legacy,/Minecraft Bedrock 1\.26\.52\.3/);assert.match(legacy,/Stable/);assert.match(legacy,/data-icon="users"/);
});

test('actual workspace context and command palette use only the permitted runtime tabs',()=>{
 const tabs={console:['Console','terminal'],worlds:['Worlds','cube'],gameplay:['World rules','spark'],files:['Files','folder'],settings:['Settings','settings'],players:['Players','users'],packs:['Add-ons','layers'],backups:['Backups','backup'],activity:['Activity','activity']};
 const context=renderer(section('function runtimeLabel(', 'const consolePreferences=')+section('function contextSignature(', 'function updateServerContext('),{serverTabs:tabs,findServer:()=>server});context.server=server;
 const html=vm.runInContext('context(server)',context);assert.match(html,/Node\.js 22\.20\.0.*Port 3000 TCP/);for(const tab of ['console','files','settings','backups','activity'])assert.match(html,new RegExp(`data-tab="${tab}"`));for(const tab of ['worlds','gameplay','players','packs'])assert.doesNotMatch(html,new RegExp(`data-tab="${tab}"`));
 const palette=source.slice(source.indexOf('const s=findServer(),items='));assert.match(palette,/Object\.entries\(serverTabs\)\.filter\(\(\[tab\]\)=>applicationTabs\(s\)\.includes\(tab\)\)/);
});

test('actual file and backup guards stop application filesystem access but keep saved backup downloads available',()=>{
 const context=renderer(section('function canWriteFiles(', 'function fileWritable('),{fileWorkspace:{operation:null}});context.server=server;
 assert.equal(vm.runInContext('canWriteFiles(server)',context),true);context.server={...server,status:'running'};assert.equal(vm.runInContext('canWriteFiles(server)',context),false);context.server={...server,kind:undefined,status:'running'};assert.equal(vm.runInContext('canWriteFiles(server)',context),true);
 const guard=renderer(section('function operationBlock(', 'function operationButton('),{recoveryReason:()=>'',state:{worlds:{},backups:{}},fileWorkspace:{operation:null}});guard.server={...server,status:'running'};
 assert.match(vm.runInContext("operationBlock(server,'create-backup')",guard),/Stop the application/);assert.equal(vm.runInContext("operationBlock(server,'download-backup',{})",guard),'');
 const files=section("if(tab==='files')", "if(tab==='worlds')");assert.ok(files.indexOf("isApplication(s)&&s.status!=='stopped'")<files.indexOf('data=await api'));
});

test('application wizard checks selected-node runtime capability and does not put Minecraft fields in its app payload',()=>{
 const create=section('async function createServer(', 'function fileDestinationField(');
 assert.match(create,/application-runtimes/);assert.match(create,/applicationRuntimeState\(runtime\.applicationRuntime,kind,\{creating:true\}\)/);assert.match(create,/if\(!support\.available\)throw/);
 assert.match(create,/application=app\?readApplicationForm\(form,\{kind\}\):null,startupMode=application\?\.startup\?\.mode\|\|'entrypoint',fresh=await api/);assert.match(create,/if\(app\)body\.application=application;else Object\.assign\(body,\{version:/);
 const base=create.match(/const body=\{([^\n]+)\};/)[1];assert.doesNotMatch(base,/eula|version|maxPlayers|portV6/);assert.match(base,/kind/);assert.match(base,/resourcePolicy,storagePolicy/);
 assert.match(create,/form\.elements\.eula\.disabled=isApp/);assert.match(create,/form\.elements\.eula\.required=!isApp/);
});

test('application creation delegates port assignment to the selected VPS without browser suggestions',()=>{
 const create=section('async function createServer(', 'function fileDestinationField(');
 assert.match(create,/\.\.\.portAllocationFromValues\(values,\{application:app\}\)/);
 assert.match(create,/syncPortAllocation\(form,\{application:isApp,disabled:!available\.allowed,node\}\)/);
 assert.doesNotMatch(create,/nextApplicationPort|nextPortsForNode|nextPort\(|portTouched|portV6Touched/);
 assert.doesNotMatch(create,/form\.elements\.port(?:V6)?\.value\s*=/);
});

test('application source restore dialog keeps startup settings separate and leaves Bedrock safeguards on Bedrock',()=>{
 const branch=section("if(action==='restore-backup')","if(action==='delete-backup')");assert.match(branch,/const app=isApplication/);assert.match(branch,/will replace the current project files/);assert.match(branch,/Startup and environment settings stay in the panel/);assert.match(branch,/generated dependencies must be installed again/);assert.match(branch,/Phiên bản Bedrock phải khớp/);assert.match(branch,/openOperationModal\(instanceId,'restore-backup'.*description/);
});
