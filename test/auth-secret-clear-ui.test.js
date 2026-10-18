import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {runInSession} from '../public/async-context.js';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf("document.addEventListener('submit',async event=>{if(!['auth-form','mfa-form']"),end=source.indexOf('\n\nvoid refreshPanelVersion();',start);
assert.ok(start>0&&end>start,'authentication submit handler must exist');
const helperStart=source.indexOf('function clearAuthSecrets('),helper=helperStart<0?'':source.slice(helperStart,start);
const apiStart=source.indexOf('async function api(path,options={})'),apiEnd=source.indexOf('\nfunction sessionChangedError()',apiStart),apiSource=source.slice(apiStart,apiEnd);
assert.ok(apiStart>0&&apiEnd>apiStart);
const authSource=await readFile(new URL('../server/auth.js',import.meta.url),'utf8'),responseStart=authSource.indexOf('const response = session => '),responseEnd=authSource.indexOf('\n  function rateLimit',responseStart);
assert.ok(responseStart>0&&responseEnd>responseStart);
const sessionResponse=vm.runInNewContext(authSource.slice(responseStart,responseEnd)+'\nresponse;',{demo:false,store:{data:{users:[{}]}}})({user:{id:'fixture-user'},csrfToken:'fixture-csrf'});
const challengeMatch=authSource.match(/return res\.json\((\{[^;\n]*mfaRequired: true[^;\n]*\})\);/);assert.ok(challengeMatch);
const challengeResponse=vm.runInNewContext('('+challengeMatch[1]+')',{challengeToken:'fixture-next-challenge',demo:false});
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
function harness(kind,{apiGate=null,launchGate=null,error=null,launchError=null,mfaRequired=false,code='fixture-recovery-code',wire=null,language='en'}={}){
 const fields=kind==='mfa'?{code:{value:code}}:{username:{value:'fixture-user'},password:{value:'fixture-password'},...(kind==='setup'?{token:{value:'fixture-setup-token'}}:{})};
 const original=Object.fromEntries(Object.entries(fields).map(([name,input])=>[name,input.value]));
 Object.defineProperty(fields,'namedItem',{value:name=>fields[name]||null});
 const form={id:kind==='mfa'?'mfa-form':'auth-form',dataset:{setup:String(kind==='setup')},elements:fields,isConnected:true},button={disabled:false},errorBox={},seen={launchCalls:0,transitions:0,apiCalls:0},secrets=()=>Object.fromEntries(['password','token','code'].filter(name=>fields[name]).map(name=>[name,fields[name].value]));
 const context={Headers,runInSession,sessionGeneration:0,sessionChangedError:()=>Error('fixture-session-changed'),getLanguage:()=>language,wireText:value=>value,ht:(strings,...values)=>String.raw({raw:strings},...values),document:{addEventListener(type,handler){assert.equal(type,'submit');context.submit=handler;}},state:{auth:null,challengeToken:'fixture-challenge',challengeExpires:Date.now()+60000},FormData:class{constructor(value){assert.equal(value,form);}*[Symbol.iterator](){for(const[name,input]of Object.entries(fields))yield[name,input.value];}},$:selector=>selector==='button[type=submit]'?button:selector==='#auth-error'?errorBox:assert.fail('unexpected selector'),beginButtonBusy:()=>()=>{},uiText:(target,value)=>{target.textContent=value;},t:value=>value,nodeText:(en,vi)=>language==='vi'?vi:en,api:async(route,options)=>{seen.apiCalls++;seen.route=route;seen.body=structuredClone(options.body);if(apiGate)await apiGate.promise;if(error)throw error;return mfaRequired?structuredClone(challengeResponse):structuredClone(sessionResponse);},renderMfaChallenge:()=>{seen.transitions++;seen.secretsAtTransition=secrets();form.isConnected=false;},launch:async()=>{seen.launchCalls++;seen.secretsAtLaunch=secrets();if(launchGate)await launchGate.promise;if(launchError)throw launchError;}};
 if(wire)context.fetch=async(route,options)=>{seen.apiCalls++;seen.route=route;seen.body=JSON.parse(options.body);if(wire.networkFailure)throw Error('fixture-network-failure');return {status:wire.status||200,ok:!wire.status||wire.status===200,json:async()=>{if(wire.malformed)throw SyntaxError('fixture-malformed-json');return JSON.parse(JSON.stringify(wire.value));}};};
 vm.createContext(context);vm.runInContext((wire?apiSource+'\n':'')+helper+'\n'+source.slice(start,end),context);
 return {form,fields,original,seen,button,errorBox,secrets,context,submit:()=>context.submit({target:form,preventDefault(){}})};
}
const assertCleared=values=>assert.ok(Object.values(values).every(value=>value===''),'secret controls must be empty');

test('acknowledged login and setup send original credentials then clear only secrets before launch',async()=>{
 for(const kind of ['login','setup']){
  const h=harness(kind);await h.submit();assert.equal(h.seen.route,'/auth/'+kind);assert.deepEqual(h.seen.body,h.original);assertCleared(h.seen.secretsAtLaunch);assertCleared(h.secrets());assert.equal(h.fields.username.value,h.original.username);assert.equal(h.form.isConnected,true);assert.equal(h.seen.launchCalls,1);assert.equal(h.button.disabled,false);
 }
});

test('successful MFA verification clears TOTP and recovery input before workspace work',async()=>{
 for(const code of ['123456','fixture-recovery-code']){
  const h=harness('mfa',{code});await h.submit();assert.equal(h.seen.route,'/auth/mfa/verify');assert.equal(h.seen.body.code,code);assert.equal(h.seen.body.challengeToken,'fixture-challenge');assertCleared(h.seen.secretsAtLaunch);assertCleared(h.secrets());
 }
});

test('password acknowledgement requiring MFA clears the old form before replacing its markup',async()=>{
 const h=harness('login',{mfaRequired:true});await h.submit();assert.equal(h.seen.transitions,1);assertCleared(h.seen.secretsAtTransition);assertCleared(h.secrets());assert.equal(h.form.isConnected,false);assert.equal(h.seen.launchCalls,0);assert.equal(h.fields.username.value,h.original.username);
});

test('an acknowledged sign-in still clears secrets when later dashboard launch fails',async()=>{
 for(const kind of ['login','setup','mfa']){
  const h=harness(kind,{launchError:Error('fixture-dashboard-unavailable')});await h.submit();assertCleared(h.seen.secretsAtLaunch);assertCleared(h.secrets());assert.equal(h.errorBox.textContent,'fixture-dashboard-unavailable');assert.equal(h.button.disabled,false);
 }
});

test('rejected and unknown authentication outcomes preserve visible inputs for correction and retry',async()=>{
 for(const kind of ['login','setup','mfa'])for(const message of ['fixture-auth-rejected','fixture-network-outcome-unknown']){
  const h=harness(kind,{error:Error(message)});await h.submit();for(const[name,value]of Object.entries(h.original))assert.equal(h.fields[name].value,value);assert.equal(h.seen.launchCalls,0);assert.equal(h.seen.transitions,0);assert.equal(h.errorBox.textContent,message);assert.equal(h.button.disabled,false);
 }
});

test('credentials remain until API acknowledgement and are empty throughout a pending launch',async()=>{
 for(const kind of ['login','setup','mfa']){
  const apiGate=deferred(),launchGate=deferred(),h=harness(kind,{apiGate,launchGate}),pending=h.submit();
  assert.ok(Object.values(h.secrets()).every(Boolean));assert.equal(h.seen.launchCalls,0);apiGate.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.seen.launchCalls,1);assertCleared(h.seen.secretsAtLaunch);assertCleared(h.secrets());assert.equal(h.button.disabled,true);launchGate.resolve();await pending;assert.equal(h.button.disabled,false);
 }
});

test('actual api and submit handler reject malformed or unrecognized 2xx acknowledgements without clearing or transitions',async()=>{
 const invalid=[{malformed:true},...[null,[],{},'fixture-string',{authenticated:'true'},{authenticated:1},{authenticated:false},{authenticated:true,mfaRequired:true},{authenticated:false,mfaRequired:'true',challengeToken:'fixture',expiresIn:300},{authenticated:false,mfaRequired:true,expiresIn:300},{authenticated:false,mfaRequired:true,challengeToken:'',expiresIn:300},{authenticated:false,mfaRequired:true,challengeToken:'   ',expiresIn:300},{authenticated:false,mfaRequired:true,challengeToken:123,expiresIn:300},{authenticated:false,mfaRequired:true,challengeToken:'fixture',expiresIn:'300'},{authenticated:false,mfaRequired:true,challengeToken:'fixture',expiresIn:0},{authenticated:false,mfaRequired:true,challengeToken:'fixture',expiresIn:-1}].map(value=>({value}))];
 for(const kind of ['login','setup','mfa'])for(const language of ['en','vi'])for(const wire of [...invalid,...(kind==='login'?[]:[{value:challengeResponse}])]){
  const h=harness(kind,{wire,language});await h.submit();for(const[name,value]of Object.entries(h.original))assert.equal(h.fields[name].value,value);assert.equal(h.context.state.auth,null);assert.equal(h.seen.launchCalls,0);assert.equal(h.seen.transitions,0);assert.equal(h.errorBox.textContent,language==='vi'?'Không thể xác nhận phản hồi xác thực. Vui lòng thử lại.':'Unable to confirm the authentication response. Please try again.');assert.equal(h.button.disabled,false);
 }
});

test('actual api accepts source-backed session and login-only MFA responses while preserving real HTTP/network failures',async()=>{
 assert.equal(sessionResponse.authenticated,true);assert.equal(challengeResponse.authenticated,false);assert.equal(challengeResponse.mfaRequired,true);
 for(const kind of ['login','setup','mfa']){
  const h=harness(kind,{wire:{value:sessionResponse}});await h.submit();assertCleared(h.seen.secretsAtLaunch);assertCleared(h.secrets());assert.equal(h.context.state.auth.authenticated,true);assert.equal(h.seen.launchCalls,1);
  for(const wire of [{status:401,value:{error:'fixture-auth-rejected'}},{networkFailure:true}]){const failed=harness(kind,{wire});await failed.submit();for(const[name,value]of Object.entries(failed.original))assert.equal(failed.fields[name].value,value);assert.equal(failed.seen.launchCalls,0);assert.equal(failed.seen.transitions,0);assert.equal(failed.context.state.auth,null);assert.ok(failed.errorBox.textContent);}
 }
 const challenge=harness('login',{wire:{value:challengeResponse}});await challenge.submit();assertCleared(challenge.seen.secretsAtTransition);assertCleared(challenge.secrets());assert.equal(challenge.context.state.auth,null);assert.equal(challenge.seen.launchCalls,0);assert.equal(challenge.seen.transitions,1);
});
