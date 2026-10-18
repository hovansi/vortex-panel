import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {resetWorkspaceNavigation} from '../public/async-context.js';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),start=source.indexOf('function updateServerContext(){'),end=source.indexOf('\nfunction noServer(',start),updateSource=source.slice(start,end);

test('live server context refresh tolerates the empty shell during relogin from every contextual tab',()=>{
 for(const serverTab of ['files','settings','worlds','backups']){
  const queries=[],state={view:'server',serverTab,servers:[],selected:null};
  const update=vm.runInNewContext(`(${updateSource})`,{rendering:false,state,$:(selector,root)=>{queries.push(selector);if(selector==='#server-picker')return {open:false};if(selector==='.server-workspace')return null;if(root===null)throw Error('null workspace queried');throw Error(`Unexpected query: ${selector}`);}});
  assert.doesNotThrow(()=>update());assert.deepEqual(queries,['#server-picker','.server-workspace']);
 }
});

test('authentication cleanup resets navigation before the next dashboard initializes',()=>{
 for(const serverTab of ['files','settings','worlds','backups','console']){
  const auth={authenticated:false},state={view:'server',serverTab,selected:'previous-admin-server',path:'private/world',currentRoute:'server/previous-admin-server/files',auth};resetWorkspaceNavigation(state);
  assert.deepEqual(state,{view:'overview',serverTab:'console',selected:null,path:'',currentRoute:'',auth});assert.strictEqual(state.auth,auth);
 }
});
