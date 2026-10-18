import test from 'node:test';
import assert from 'node:assert/strict';
import {createJobTracker} from '../public/job-tracker.js';
const previous=globalThis.document;
globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
const {jobDetailModel,jobDetailMarkup}=await import('../public/job-details.js');
const {progressModel,operationPhaseLabel}=await import('../public/operation-progress.js');
const {plainUI}=await import('../public/i18n.js');
if(previous)globalThis.document=previous;else delete globalThis.document;
const id='44444444-5555-4666-8777-888888888888:6d08ac54-3cd6-4db8-adc2-02b898c38355';
const server={id:'node:server',kind:'python',name:'Renamed application',nodeId:id.split(':')[0],nodeName:'Vortex Node 001'};
const job={id,serverId:server.id,type:'install',status:'queued',progress:0,createdAt:'2026-10-18T00:00:00Z',subject:{name:'Original application',kind:'python'}};
const render=(value=job,options={})=>plainUI(jobDetailMarkup(value,{server,canManage:()=>true,...options}));

test('accepted remote task ID is visible and copyable before polling or completion, with immutable subject context',()=>{
 const html=render();assert.match(html,new RegExp(`<code data-job-visible-id>${id}</code>`));assert.match(html,new RegExp(`data-job-id="${id}"`));assert.doesNotMatch(html,/<details[^>]*>\s*<summary>Task ID/);
 assert.match(html,/Original application/);assert.doesNotMatch(html,/Renamed application/);assert.match(html,/Vortex Node 001/);assert.match(html,/Created/);assert.doesNotMatch(html,/Started|Finished/);
});
test('actual start and bounded phase history are distinct from queue time and output remains escaped',()=>{
 const html=render({...job,status:'completed',startedAt:'2026-10-18T00:00:03Z',finishedAt:'2026-10-18T00:00:08Z',phaseHistory:Array.from({length:20},(_,index)=>({phase:index%2?'runtime-build':'runtime-resolve',at:`2026-10-18T00:00:${index}Z`,message:`stage ${index}`})),output:{lines:['<script>PRIVATE_TOKEN=redacted</script>','complete'],truncated:true},result:{runtime:{version:'3.15.0',source:'python.org'},exitCode:0}});
 assert.match(html,/Started/);assert.match(html,/Finished/);assert.match(html,/Recorded stages/);assert.equal((html.match(/<li>/g)||[]).length,16);assert.doesNotMatch(html,/<script>|stage 0</);assert.match(html,/&lt;script&gt;/);assert.match(html,/truncated/);assert.match(html,/3\.15\.0/);
});
test('failed and committed-warning records do not imply success or suggest repeating a completed write',()=>{
 const html=render({...job,status:'failed',error:'No space <left>',errorCode:'STORAGE_FULL',operationCompleted:true,warnings:['Output <bounded>']});
 assert.match(html,/No space &lt;left&gt;/);assert.match(html,/STORAGE_FULL/);assert.match(html,/committed its data/);assert.match(html,/Output &lt;bounded&gt;/);
 const model=jobDetailModel({...job,status:'failed'});assert.equal(model.failed,true);assert.equal(model.operationCompleted,false);assert.deepEqual(model.tabs,[]);
});
test('job result facts deduplicate the runtime pin and identify the actual script/module launch target',()=>{
 const model=jobDetailModel({...job,result:{version:'v26.0.0',runtime:{version:'26.0.0'},entrypoint:'unused.js',startup:{mode:'npm-script',script:'start:prod'}}});
 assert.equal(model.facts.filter(([,value])=>value==='26.0.0'||value==='v26.0.0').length,1);assert.ok(model.facts.some(([,value])=>value==='start:prod'));assert.equal(model.facts.some(([,value])=>value==='unused.js'),false);
 const html=render({...job,result:{entrypoint:'unused.py',startup:{mode:'python-module',module:'my_project.worker'}}});assert.match(html,/my_project\.worker/);assert.doesNotMatch(html,/unused\.py/);
});
test('backup result actions are authorized by the current server and never trust result URLs',()=>{
 const value={...job,type:'backup',status:'completed',result:{backup:{id:'backup-id',name:'Archive',size:1024,sha256:'a'.repeat(64),integrity:{status:'verified'},downloadUrl:'https://untrusted.invalid'}}};
 assert.match(render(value),/data-action="job-download-backup"/);assert.doesNotMatch(render(value),/untrusted/);assert.doesNotMatch(render(value,{canManage:()=>false}),/data-action="job-download-backup"/);
 assert.doesNotMatch(render({...value,result:{backup:{...value.result.backup,integrity:{status:'failed'}}}}),/data-action="job-download-backup"/);assert.doesNotMatch(render(value,{server:null}),/job-open-workspace|job-download-backup/);
});
test('world selection evidence and application actions respect the actual result/runtime',()=>{
 const imported=render({...job,result:{world:{name:'World <one>'},selected:false}},{server:{...server,kind:'bedrock'}});assert.match(imported,/Imported into the library/);assert.match(imported,/World &lt;one&gt;/);assert.match(imported,/data-tab="worlds"/);
 const app=render();assert.match(app,/data-tab="files"/);assert.doesNotMatch(app,/data-tab="worlds"|data-tab="players"/);
 const output=jobDetailModel({...job,output:{lines:['x'.repeat(100000)]}});assert.equal(output.output.length,65536);assert.equal(output.outputTruncated,true);
});
test('interrupted/cancelled historical jobs stop tracking and cannot turn into 100 percent completion',()=>{
 for(const status of ['interrupted','cancelled']){let reads=0,seen;const tracker=createJobTracker({id,seed:{...job,status,progress:73},read:()=>{reads++;},onJob:value=>{seen=value;}});tracker.start();assert.equal(reads,0);assert.equal(seen.status,status);const model=progressModel(seen);assert.equal(model.active,false);assert.equal(model.completed,false);assert.equal(model.progress,73);}
 assert.equal(plainUI(operationPhaseLabel('runtime-build')),'Building Python runtime');assert.equal(progressModel({...job,status:'running',phase:'runtime-download',transfer:{loadedBytes:50,totalBytes:100}}).downloadPercent,50);
});
