import test from 'node:test';import assert from 'node:assert/strict';
import {createViewGuard} from '../public/async-context.js';
const previous=globalThis.document,had=Object.hasOwn(globalThis,'document');globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
let showNodeProvisionJob,nodeModalContext;try{({showNodeProvisionJob,nodeModalContext}=await import('../public/nodes-workspace.js'));}finally{if(had)globalThis.document=previous;else delete globalThis.document;}
test('an incorrectly identified VPS setup job is rejected before opening any dialog',async()=>{
 let opened=false;await assert.rejects(showNodeProvisionJob('requested-job',{api:async()=>({job:{id:'other-job',status:'running'}}),openModal:()=>{opened=true;}}));assert.equal(opened,false);
});
test('a delayed VPS setup read cannot replace a newer dialog or actor',async()=>{
 let resolve,current=true,opened=false;const request=new Promise(done=>resolve=done),pending=showNodeProvisionJob('requested-job',{api:()=>request,isCurrent:()=>current,openModal:()=>{opened=true;}});current=false;resolve({job:{id:'requested-job',status:'running'}});await pending;assert.equal(opened,false);
});

test('an accepted SSH setup uses its active wizard context rather than the stale pre-open click context',async()=>{
 let revision=0,actor='admin',view='nodes',opened=0;const read=()=>({revision,actor,view}),before=createViewGuard(read),form={isConnected:true},modal={open:true},root={querySelector:selector=>selector==='#modal'?modal:form};
 const context={isCurrent:before,actorId:()=>actor,icon:()=>'<svg></svg>',openModal:async()=>{opened++;return false;},rebase:()=>({...context,isCurrent:createViewGuard(read)})};
 revision=1;assert.equal(context.isCurrent(),false);const wizard=nodeModalContext(context,form,{root});assert.equal(wizard.isCurrent(),true);
 await showNodeProvisionJob('accepted-job',wizard,{id:'accepted-job',status:'running',progress:50});assert.equal(opened,1);
 modal.open=false;assert.equal(wizard.isCurrent(),false);await showNodeProvisionJob('accepted-job',wizard,{id:'accepted-job',status:'running'});assert.equal(opened,1);
 modal.open=true;view='settings';assert.equal(wizard.isCurrent(),false);
});

test('retained detail DOM cannot reopen after closing or replacement and remains bound to its actor',()=>{
 let actor='admin-a',active,revision=1;const detail={isConnected:true},replacement={isConnected:true},modal={open:true},root={querySelector:selector=>selector==='#modal'?modal:active},read=()=>({actor,revision});active=detail;
 const context={actorId:()=>actor,rebase:()=>({...context,isCurrent:createViewGuard(read)})},scoped=nodeModalContext(context,detail,{root,selector:'[data-node-detail]'});
 assert.equal(scoped.isCurrent(),true);modal.open=false;assert.equal(scoped.isCurrent(),false);assert.equal(detail.isConnected,true);
 modal.open=true;active=replacement;assert.equal(scoped.isCurrent(),false);active=detail;actor='admin-b';assert.equal(scoped.isCurrent(),false);
});
