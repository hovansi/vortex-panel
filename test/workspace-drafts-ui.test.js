import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('async function allowDiscardForms('),end=source.indexOf('\nasync function closeModal(',start),guard=source.slice(start,end);

test('canceling navigation keeps every unsaved application settings draft guarded',async()=>{
 const forms=[{dataset:{dirty:'true'},isConnected:true},{dataset:{dirty:'true'},isConnected:true}];let prompts=0;
 const context={t:value=>value,panelConfirm:async()=>{prompts++;return false;}};
 vm.runInNewContext(guard+'\nglobalThis.discard=allowDiscardForms;',context);
 assert.equal(await context.discard(forms),false);assert.equal(prompts,1);assert.deepEqual(forms.map(form=>form.dataset.dirty),['true','true']);
 forms[1].dataset.dirty='false';assert.equal(await context.discard(forms),false);assert.equal(prompts,2);assert.equal(forms[0].dataset.dirty,'true');
});

test('one accepted discard clears all connected drafts and clean forms need no prompt',async()=>{
 const forms=[{dataset:{dirty:'true'},isConnected:true},{dataset:{dirty:'true'},isConnected:true}];let prompts=0;
 const context={t:value=>value,panelConfirm:async()=>{prompts++;return true;}};
 vm.runInNewContext(guard+'\nglobalThis.discard=allowDiscardForms;',context);
 assert.equal(await context.discard([...forms,null]),true);assert.equal(prompts,1);assert.deepEqual(forms.map(form=>form.dataset.dirty),['false','false']);
 assert.equal(await context.discard(forms),true);assert.equal(prompts,1);
});

test('application general reset preserves the separate startup draft and synchronizes restored controls',async()=>{
 const start=source.indexOf("if(action==='reset-config'){"),end=source.indexOf("\n    if(action==='server-filter')",start),startup={dataset:{dirty:'true'},entrypoint:'unsaved.py'},form={dataset:{dirty:'true'},name:'Unsaved',reset(){this.name='Saved';}};
 let renders=0;const synchronized=[],context={action:'reset-config',state:{configuration:{server:{kind:'python'}}},$:()=>form,allowDiscard:async current=>{current.dataset.dirty='false';return true;},isApplication:()=>true,viewResourceControls:{sync(){synchronized.push('resources');}},syncConfigNetwork(){synchronized.push('configuration');},syncSelects(current){assert.equal(current,form);synchronized.push('selects');},updateConfigDirty(){synchronized.push('dirty');},renderView:async()=>{renders++;}};
 await vm.runInNewContext('(async()=>{'+source.slice(start,end)+'})()',context);assert.equal(form.name,'Saved');assert.equal(form.dataset.dirty,'false');assert.equal(startup.dataset.dirty,'true');assert.equal(startup.entrypoint,'unsaved.py');assert.equal(renders,0);assert.deepEqual(synchronized,['resources','configuration','selects','dirty']);
 form.name='Kept draft';context.allowDiscard=async()=>false;await vm.runInNewContext('(async()=>{'+source.slice(start,end)+'})()',context);assert.equal(form.name,'Kept draft');
});
