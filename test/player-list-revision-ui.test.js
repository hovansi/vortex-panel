import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a))),revision='a'.repeat(64);
const t=value=>value,ht=(chunks,...values)=>chunks.map((part,index)=>part+(values[index]??'')).join('');
function fixture(players){const requests=[],callbacks=[];const context={state:{players,selected:'bedrock',servers:[{id:'bedrock',status:'stopped'}]},structuredClone,t,ht,hStatic:t,nodeText:en=>en,field:()=>'',canEditData:()=>true,openModal:(_a,_b,_c,callback)=>callbacks.push(callback),confirmAction:(_a,_b,callback)=>callbacks.push(callback),api:async(path,options)=>{requests.push({path,...options});return{ok:true,revision:'b'.repeat(64)};},toast(){},renderView(){}};vm.runInNewContext(section('async function savePlayerLists(', '\nasync function showActivity(')+'\nglobalThis.add=addPlayer;globalThis.edit=editPlayer;globalThis.save=savePlayerLists;',context);return{context,requests,callbacks};}

test('add and edit submit the opening revision even when another operator changes the live list',async()=>{
 for(const edit of [false,true]){const opening={revision,allowlist:[{name:'Original',xuid:'123'}],permissions:[]},f=fixture(opening);if(edit)f.context.edit('allowlist',{xuid:'123'},'bedrock');else f.context.add(false,'bedrock');f.context.state.players={revision:'b'.repeat(64),allowlist:[...opening.allowlist,{name:'Concurrent'}],permissions:[]};await f.callbacks[0]({name:'My change',xuid:edit?'123':'',ignoresPlayerLimit:'on'});assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.revision,revision);assert.equal(f.requests[0].method,'PUT');}
});

test('delete submits the opening revision rather than authorizing a stale whole-list replacement',async()=>{
 const f=fixture({revision,allowlist:[{name:'Keep'},{name:'Remove'}],permissions:[]});Object.assign(f.context,{action:'delete-player',target:{dataset:{list:'allowlist',index:'1'}},instanceId:'bedrock',instancePath:'/servers/bedrock'});
 const start=source.indexOf("if(action==='delete-player'){"),end=source.indexOf("\n    if(action==='refresh-diagnostics')",start);await vm.runInNewContext('(async()=>{'+source.slice(start,end)+'})()',f.context);f.context.state.players={revision:'b'.repeat(64),allowlist:[{name:'Concurrent'}],permissions:[]};await f.callbacks[0]();assert.equal(f.requests[0].body.revision,revision);assert.equal(f.requests[0].body.allowlist[0].name,'Keep');
});

test('missing revisions refuse to mutate and server conflicts retain their actionable identity',async()=>{
 const f=fixture({allowlist:[],permissions:[]});await assert.rejects(f.context.save('bedrock',{allowlist:[],permissions:[]},undefined),error=>error.code==='PLAYER_LIST_CONFLICT'&&error.playerServerId==='bedrock');assert.equal(f.requests.length,0);
 f.context.api=async()=>{throw Object.assign(new Error('Concurrent list changed'),{status:409,code:'PLAYER_LIST_CONFLICT'});};await assert.rejects(f.context.save('bedrock',{allowlist:[],permissions:[]},revision),error=>error.code==='PLAYER_LIST_CONFLICT'&&error.playerServerId==='bedrock');
});
