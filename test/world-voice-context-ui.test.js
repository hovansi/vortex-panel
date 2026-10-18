import test from 'node:test';
import assert from 'node:assert/strict';
const previous=globalThis.document;globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
const {openWorldVoiceDialog}=await import('../public/world-voice-dialog.js');if(previous)globalThis.document=previous;else delete globalThis.document;
const server={id:'fixture',name:'Fixture world',status:'running'};
test('a delayed announcement read cannot open after navigation or another modal replaces its origin',async()=>{
 for(const replacement of ['view','modal']){let resolve,current=true,opened=0;const waiting=new Promise(done=>resolve=done),work=openWorldVoiceDialog(server.id,{api:()=>waiting,isCurrent:()=>current,openModal:async()=>{opened++;},canManage:()=>true,icon:()=>''});current=false;resolve({server,properties:{}});await work;assert.equal(opened,0,replacement);}
});
test('the current announcement origin still opens the composer for its named server',async()=>{
 let opened=0;await openWorldVoiceDialog(server.id,{api:async()=>({server,properties:{}}),isCurrent:()=>true,canManage:()=>true,icon:()=>'',openModal:async(_title,description)=>{opened++;assert.equal(description,server.name);return false;}});assert.equal(opened,1);
});
