import test from 'node:test';
import assert from 'node:assert/strict';

const previousDocument=globalThis.document;
globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];},dispatchEvent(){}};
const {applicationKind,isApplication,applicationName,applicationTabs,applicationDefaults,applicationRuntimeState,applicationFromValues,applicationFields,applicationSettingsMarkup,applicationConsoleAside,validateApplicationResponse}=await import('../public/application-workspace.js');
const {plainUI}=await import('../public/i18n.js');
if(previousDocument)globalThis.document=previousDocument;else delete globalThis.document;
const application={entrypoint:'server.js',args:[],environment:[],dependencies:'none'};
const parse=(values={},options={})=>applicationFromValues({...application,...values},{kind:'nodejs',...options});

test('legacy Bedrock remains Bedrock while apps have a separate tab set without game actions',()=>{
 assert.equal(applicationKind({id:'legacy'}),'bedrock');assert.equal(isApplication({id:'legacy'}),false);
 assert.equal(applicationName({kind:'nodejs'}),'Node.js');assert.equal(applicationName({kind:'python'}),'Python');
 assert.deepEqual(applicationTabs({kind:'python'}),['console','files','settings','backups','activity']);
 assert.ok(applicationTabs({}).includes('worlds'));assert.equal(isApplication('unknown'),false);
 assert.deepEqual(applicationDefaults('python'),{entrypoint:'app.py',args:[],environment:[],dependencies:'none',readiness:'tcp'});
});

test('runtime availability requires both supported isolation and a detected matching runtime',()=>{
 const capabilities={supported:true,engine:'bubblewrap',runtimes:[{kind:'nodejs',available:true,version:'v22.20.0'},{kind:'python',available:false}]};
 assert.equal(applicationRuntimeState(capabilities,'nodejs').available,true);assert.equal(applicationRuntimeState(capabilities,'python').available,false);
 assert.equal(applicationRuntimeState({...capabilities,supported:false},'nodejs').available,false);
 assert.equal(applicationRuntimeState({},'nodejs').available,false);
 assert.equal(applicationRuntimeState(capabilities,'nodejs').runtime.version,'v22.20.0');
});

test('arguments preserve literal spaces, empty arguments, quotes and shell-like text as data',()=>{
 const args=['--label','hello world','','$(touch ignored)','"quoted"','a;b'];
 const result=parse({args});assert.deepEqual(result.args,args);assert.notStrictEqual(result.args,args);
 assert.deepEqual(applicationFromValues({appEntrypoint:'src/server.js',appArgs:JSON.stringify(args),appEnvironment:'[]',appDependencies:'auto'},{kind:'nodejs'}),{entrypoint:'src/server.js',args,environment:[],dependencies:'auto',readiness:'tcp'});
 for(const args of [['line\nbreak'],['\t'],['\u0085'],['\u2028'],['\ud800'],[5],Array(33).fill('x'),['x'.repeat(1025)]])assert.throws(()=>parse({args}));
 assert.throws(()=>parse({appArgs:'not-json'}));
});

test('entrypoint rejects host paths, traversal and invalid control characters before submission',()=>{
 assert.equal(parse({entrypoint:'src/server.js'}).entrypoint,'src/server.js');
 for(const entrypoint of ['/etc/passwd','../server.js','src/../server.js','./server.js','C:/server.js','src\\server.js','src//server.js','server.js\0','node_modules/main.js','.home/main.js','server.sh','a'.repeat(81)+'/main.js'])assert.throws(()=>parse({entrypoint}));
 assert.throws(()=>parse({}, {kind:'bedrock'}));assert.throws(()=>parse({dependencies:'shell'}));
});

test('unchanged masked secrets omit value; explicit empty values clear rather than retain',()=>{
 const previous={environment:[{name:'API_KEY',value:null,secret:true,hasValue:true}]};
 assert.deepEqual(parse({environment:[{name:'API_KEY',value:null,secret:true}]},{previous}).environment,[{name:'API_KEY',secret:true}]);
 assert.deepEqual(parse({environment:[{name:'API_KEY',value:'',secret:true}]},{previous}).environment,[{name:'API_KEY',value:'',secret:true}]);
 assert.deepEqual(parse({environment:[]},{previous}).environment,[]);
 for(const row of [{name:'OTHER_KEY',value:null,secret:true,originalName:'API_KEY'},{name:'API_KEY',value:null,secret:false},{name:'API_KEY',value:null,secret:true,originalName:'OTHER_KEY'}])assert.throws(()=>parse({environment:[row]},{previous}));
 assert.throws(()=>parse({environment:[{name:'API_KEY',value:null,secret:true}]}));
});

test('environment validation rejects duplicate names, launcher injection and bounded oversized values',()=>{
 assert.equal(parse({environment:[{name:'NODE_ENV',value:'production',secret:false}]}).environment[0].value,'production');
 for(const name of ['port','API-KEY','PORT','PATH','NODE_OPTIONS','PYTHONPATH','VORTEX_TOKEN','BEDROCK_TOKEN','LD_PRELOAD','DYLD_LIBRARY_PATH','A'.repeat(65)])assert.throws(()=>parse({environment:[{name,value:'x'}]}));
 assert.throws(()=>parse({environment:[{name:'A',value:'x'},{name:'A',value:'y'}]}));
 for(const value of ['a\nb','a\rb','\0','x'.repeat(4097),5])assert.throws(()=>parse({environment:[{name:'A',value}]}));
 assert.throws(()=>parse({environment:Array.from({length:9},(_,i)=>({name:`KEY_${i}`,value:'é'.repeat(2048)}))}));
 assert.throws(()=>parse({environment:Array.from({length:65},(_,i)=>({name:`KEY_${i}`,value:''}))}));
});

test('rendered secret rows never contain a saved value even if a caller accidentally supplies it',()=>{
 const markup=plainUI(applicationFields({kind:'nodejs',application:{...application,environment:[{name:'API_KEY',value:'PRIVATE_SENTINEL',secret:true,hasValue:true},{name:'NODE_ENV',value:'production',secret:false}]}}));
 assert.doesNotMatch(markup,/PRIVATE_SENTINEL/);assert.match(markup,/Stored securely/);assert.match(markup,/type="password"/);assert.match(markup,/production/);assert.match(markup,/Clear value/);
 assert.equal(applicationFields({kind:'bedrock'}),'');
});

test('application content is escaped and Python fields use actual requirements semantics',()=>{
 const markup=plainUI(applicationFields({kind:'python',application:{entrypoint:'<script>bad</script>',args:['"><img src=x>'],environment:[{name:'PUBLIC_VALUE',value:'<script>bad</script>'}]}}));
 assert.doesNotMatch(markup,/<script>|<img/);assert.match(markup,/&lt;script&gt;/);assert.match(markup,/requirements\.txt/);assert.doesNotMatch(markup,/package-lock\.json/);
 assert.match(markup,/One field is one argument/);assert.match(markup,/PORT is supplied automatically/);
});

test('settings disable mutations for running apps, viewers and unsupported runtimes',()=>{
 const server={id:'remote:app',kind:'nodejs',status:'running',application};
 const running=plainUI(applicationSettingsMarkup({server},{canManage:()=>true,runtime:{available:true}}));
 assert.match(running,/Stop the application/);assert.match(running,/data-app-install-dependencies[^>]*disabled/);assert.doesNotMatch(running,/world|player|Minecraft EULA/i);
 const viewer=plainUI(applicationSettingsMarkup({server:{...server,status:'stopped'}},{canManage:()=>false,runtime:{available:true}}));assert.match(viewer,/data-application-disabled="true"/);
 const noRuntime=plainUI(applicationSettingsMarkup({server:{...server,status:'stopped'}},{canManage:()=>true,runtime:{available:false}}));assert.match(noRuntime,/data-app-install-dependencies[^>]*disabled/);
 const ready=plainUI(applicationSettingsMarkup({server:{...server,status:'stopped'}},{canManage:()=>true,runtime:{available:true}}));assert.doesNotMatch(ready,/data-app-install-dependencies[^>]*disabled/);
});

test('console app metadata avoids Minecraft protocols and never prints environment values',()=>{
 const markup=plainUI(applicationConsoleAside({id:'app',kind:'python',port:34000,application:{...application,entrypoint:'<app.py>',environment:[{name:'TOKEN',value:'PRIVATE_SENTINEL',secret:true}]}}));
 assert.match(markup,/Python/);assert.match(markup,/34000/);assert.match(markup,/&lt;app\.py&gt;/);assert.match(markup,/standard input/);assert.doesNotMatch(markup,/PRIVATE_SENTINEL|RakNet|NetherNet|Players|Bedrock/);
});

test('TCP and background-process readiness stay explicit without a false web-readiness claim',()=>{
 assert.equal(parse({readiness:'process'}).readiness,'process');assert.equal(parse().readiness,'tcp');assert.throws(()=>parse({readiness:'regex'}));
 const html=plainUI(applicationFields({kind:'python',application:{entrypoint:'app.py',readiness:'process'}}));assert.match(html,/value="process" selected/);assert.match(html,/does not verify a web endpoint/);assert.match(html,/TCP port accepts connections/);
});

test('application responses are bound to the selected server, runtime kind and revision',()=>{
 const data={server:{id:'remote:app',kind:'python'},application:{entrypoint:'app.py'},revision:'revision'};
 assert.strictEqual(validateApplicationResponse(data,'remote:app','python'),data);
 for(const change of [{server:{id:'other',kind:'python'}},{server:{id:'remote:app',kind:'nodejs'}},{revision:''},{application:null}])assert.throws(()=>validateApplicationResponse({...data,...change},'remote:app','python'));
});
