import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {validatePrettyHostname} from '../server/hostname.js';
const previous=globalThis.document;
globalThis.document={documentElement:{lang:''},addEventListener(){},querySelectorAll(){return[];}};
const {hostnameCandidate,hostnameChangeCandidate,hostnameEditorMarkup}=await import('../public/nodes-workspace.js');
const {plainUI,wireText}=await import('../public/i18n.js');
if(previous)globalThis.document=previous;else delete globalThis.document;
const source=await readFile(new URL('../public/nodes-workspace.js',import.meta.url),'utf8');
const editSource=source.slice(source.indexOf('async function editHostname('),source.indexOf('async function editNode('));
const node={id:'remote-node',name:'Display name <unchanged>'};
const initial={current:'old-node',static:'old-node',transient:'old-node',pretty:'Existing Friendly',editable:true,prettyEditable:true,revision:'a'.repeat(64)};
async function harness(values,options={}){
 const calls=[],confirmations=[],resultNode={textContent:''},form={isConnected:true,dataset:{dirty:'true'},elements:{hostname:{value:values.hostname,disabled:false},changePretty:{checked:values.changePretty===true||values.changePretty==='on',disabled:false},prettyHostname:{value:values.prettyHostname??'',disabled:false}},querySelector(selector){return selector==='[data-node-hostname]'?{dataset:{nodeHostname:node.id}}:resultNode;}};
 let submit;
 const api=async(path,request)=>{calls.push({path,request});if(request?.method==='PATCH'){if(options.error)throw options.error;return{hostname:{...initial,current:values.hostname.toLowerCase(),static:values.hostname.toLowerCase(),transient:values.hostname.toLowerCase(),pretty:Object.hasOwn(request.body,'prettyHostname')?request.body.prettyHostname:initial.pretty},warnings:[]};}return{hostname:{...initial,...options.info}};};
 const context={api,isCurrent:()=>true,openModal:async(title,description,markup,callback)=>{submit=callback;return false;},panelConfirm:async details=>{confirmations.push(details);options.afterConfirm?.(form);return options.confirmed!==false;},toast(){},refresh:async()=>{}};
 const globals={hostnameCandidate,hostnameChangeCandidate,hostnameEditorMarkup,nodeText:en=>en,wireText,document:{querySelector:()=>({open:true})},uiText:(element,text)=>{element.textContent=plainUI(text);}};vm.createContext(globals);vm.runInContext(editSource+';this.invoke=editHostname;',globals);await globals.invoke(node,context);
 return{calls,confirmations,form,resultNode,submit:()=>submit(values,form)};
}

test('uppercase input has a reviewed lowercase DNS value without silently changing the requested text',()=>{
 assert.deepEqual(hostnameCandidate('VortexPanel'),{requested:'VortexPanel',canonical:'vortexpanel',normalized:true});assert.throws(()=>hostnameCandidate('Vortex Panel'));assert.throws(()=>hostnameCandidate('LOCALHOST'));
 const candidate=hostnameChangeCandidate({hostname:'VortexPanel',prettyHostname:'ignored'},initial);assert.equal(candidate.prettyRequested,false);assert.equal(Object.hasOwn(candidate,'prettyHostname'),false);
});
test('friendly hostname frontend shares backend bounds, case/Unicode semantics and explicit clearing',()=>{
 for(const value of ['Vortex Panel · Việt Nam','','a'.repeat(128),'é'.repeat(128)]){assert.equal(validatePrettyHostname(value),value);assert.equal(hostnameChangeCandidate({hostname:'VortexPanel',changePretty:'on',prettyHostname:value},initial).prettyHostname,value);}
 for(const value of [' leading','trailing ','bad\nname','bad\x7fname','bad\x85name','bad\u2028name','bad\u2029name','😀'.repeat(65),'中'.repeat(100),'\ud800']){assert.throws(()=>validatePrettyHostname(value));assert.throws(()=>hostnameChangeCandidate({hostname:'VortexPanel',changePretty:true,prettyHostname:value},initial));}
 assert.throws(()=>hostnameChangeCandidate({hostname:'vortex',changePretty:true,prettyHostname:'Friendly'},{prettyEditable:false}));
});
test('hostname facts, optional friendly fields and escaped values distinguish absent capability and unset names',()=>{
 const html=plainUI(hostnameEditorMarkup({...initial,pretty:'<Friendly>'},node));assert.match(html,/Static DNS hostname/);assert.match(html,/Transient hostname/);assert.match(html,/&lt;Friendly&gt;/);assert.doesNotMatch(html,/<Friendly>/);assert.match(html,/data-hostname-pretty-field hidden/);assert.doesNotMatch(html,/name="changePretty" checked/);
 const old=plainUI(hostnameEditorMarkup({...initial,prettyEditable:undefined,pretty:''},node));assert.match(old,/name="changePretty" disabled/);assert.match(old,/Update the node agent/);assert.match(old,/Not set/);
});
test('real dialog callback forwards original DNS case and omits unchecked friendly name',async()=>{
 const h=await harness({hostname:'VortexPanel',prettyHostname:'Should not be sent'});await h.submit();const patch=h.calls.find(row=>row.request?.method==='PATCH');assert.equal(patch.path,'/nodes/remote-node/hostname');assert.deepEqual(JSON.parse(JSON.stringify(patch.request.body)),{hostname:'VortexPanel',revision:initial.revision,confirmed:true});assert.match(plainUI(h.confirmations[0].description),/DNS will use vortexpanel/);assert.match(plainUI(h.confirmations[0].description),/will be preserved/);assert.equal(h.form.elements.hostname.value,'vortexpanel');
});
test('real dialog callback requires opt-in, fresh capability and confirms friendly rename/clear',async()=>{
 for(const prettyHostname of ['Vortex Panel','']){const h=await harness({hostname:'VortexPanel',changePretty:'on',prettyHostname});await h.submit();const patch=h.calls.find(row=>row.request?.method==='PATCH');assert.equal(patch.request.body.prettyHostname,prettyHostname);assert.match(plainUI(h.confirmations[0].description),prettyHostname?/Friendly hostname: Vortex Panel/:/will be cleared/);}
 const old=await harness({hostname:'VortexPanel',changePretty:'on',prettyHostname:'Friendly'},{info:{prettyEditable:false}});await assert.rejects(old.submit());assert.equal(old.calls.filter(row=>row.request).length,0);
});
test('changed draft or declined confirmation cannot mutate; unknown result locks this form against replay',async()=>{
 const changed=await harness({hostname:'VortexPanel'},{afterConfirm:form=>{form.elements.hostname.value='different';}});await changed.submit();assert.equal(changed.calls.filter(row=>row.request).length,0);
 const declined=await harness({hostname:'VortexPanel'},{confirmed:false});await declined.submit();assert.equal(declined.calls.filter(row=>row.request).length,0);
 const unknown=await harness({hostname:'VortexPanel'},{error:Object.assign(Error('Connection lost'),{outcomeUnknown:true})});await assert.rejects(unknown.submit());await assert.rejects(unknown.submit());assert.equal(unknown.calls.filter(row=>row.request).length,1);assert.equal(unknown.form.elements.hostname.disabled,true);assert.match(unknown.resultNode.textContent,/result is unknown/);
});
