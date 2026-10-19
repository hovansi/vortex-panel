import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const messages={
 TLS_PLATFORM:['Managed HTTPS requires the canonical Linux panel service running as root.','HTTPS được quản lý cần dịch vụ panel Linux chuẩn chạy bằng root.'],
 TLS_ACCESS:['Automatic IP HTTPS requires Vortex’s managed IP reverse proxy. Existing custom access is preserved.','HTTPS IP tự động cần reverse proxy IP do Vortex quản lý. Giữ nguyên cấu hình truy cập tùy chỉnh.'],
 TLS_EXTERNAL:['The proxy or renewal unit was changed outside Vortex. Review the configuration before continuing.','Proxy hoặc dịch vụ gia hạn đã được sửa ngoài Vortex. Kiểm tra cấu hình trước khi tiếp tục.'],
 TLS_OWNERSHIP:['HTTPS configuration ownership could not be verified.','Không xác minh được quyền quản lý cấu hình HTTPS.'],
 TLS_CHANGED:['HTTPS settings changed. Refresh the status before confirming again.','Thiết lập HTTPS đã đổi. Tải lại trạng thái trước khi xác nhận.'],
 TLS_INPUT:['Invalid HTTPS request.','Yêu cầu HTTPS không hợp lệ.'],
 TLS_CONFIRM:['Review and confirm the certificate authority terms before requesting HTTPS.','Xem và xác nhận điều khoản của tổ chức chứng thực trước khi yêu cầu HTTPS.'],
 TLS_BUSY:['Another HTTPS operation is running. Follow its existing task.','Một thao tác HTTPS đang chạy. Theo dõi tác vụ hiện tại.'],
 TLS_RUNTIME:['The managed Certbot runtime is unavailable or was changed. Run the release installer to repair its prerequisites.','Certbot được quản lý chưa khả dụng hoặc đã bị sửa. Chạy bộ cài phát hành để sửa các thành phần cần thiết.'],
 TLS_LAYOUT:['Automatic renewal requires the canonical managed release layout.','Tự gia hạn cần cấu trúc bản cài được quản lý chuẩn.'],
 TLS_CHALLENGE:['The HTTP challenge path could not be verified. Check NGINX and inbound TCP port 80.','Không xác minh được đường dẫn HTTP challenge. Kiểm tra NGINX và cổng TCP 80 chiều vào.'],
 TLS_ISSUANCE:['The certificate authority did not issue a certificate. Check inbound TCP port 80, firewall/NAT and CA limits. The previous HTTPS configuration is preserved.','Tổ chức chứng thực chưa cấp chứng chỉ. Kiểm tra TCP 80 chiều vào, firewall/NAT và giới hạn CA. Giữ cấu hình HTTPS trước đó.'],
 TLS_VERIFY:['The issued certificate or its public trust could not be verified.','Không xác minh được chứng chỉ được cấp hoặc chuỗi tin cậy công khai.'],
 TLS_RENEW:['Certificate renewal could not be verified. Inspect the renewal service journal before expiry.','Không xác minh được việc gia hạn chứng chỉ. Kiểm tra nhật ký dịch vụ gia hạn trước khi hết hạn.'],
 TLS_RECOVERY:['HTTPS recovery needs administrator review. The configuration was preserved for inspection.','Cần quản trị viên kiểm tra phục hồi HTTPS. Cấu hình được giữ lại để kiểm tra.'],
 TLS_COMMAND:['The HTTPS operation failed. Inspect the actual status and the renewal service journal.','Thao tác HTTPS thất bại. Kiểm tra trạng thái thực tế và nhật ký dịch vụ gia hạn.'],
 TLS_UNKNOWN:['The HTTPS result is unknown. Refresh and inspect the existing task before submitting another request.','Chưa rõ kết quả HTTPS. Tải lại và kiểm tra tác vụ hiện tại trước khi gửi yêu cầu khác.'],
 TLS_KEY:['The certificate and its private key do not match. The previous HTTPS configuration is preserved.','Chứng chỉ và khóa riêng không khớp. Giữ nguyên cấu hình HTTPS trước đó.'],
 TLS_INTERRUPTED:['The interrupted HTTPS request was safely rolled back. Review the status before requesting a new certificate.','Đã hoàn tác an toàn yêu cầu HTTPS bị gián đoạn. Kiểm tra trạng thái trước khi yêu cầu chứng chỉ mới.'],
 TLS_PERSIST:['The HTTPS task could not be saved safely. The requested operation was not dispatched.','Không thể lưu tác vụ HTTPS an toàn. Chưa gửi thao tác được yêu cầu.'],
 TLS_CLOSED:['The panel is stopping. No HTTPS request was accepted.','Panel đang dừng. Chưa nhận yêu cầu HTTPS.'],
};
const metadata=code=>({id:`panel.tls.${code.slice(4).toLowerCase()}`,en:messages[code][0],vi:messages[code][1],params:[]});
export const TLS_MESSAGES=Object.freeze(Object.keys(messages).map(metadata));
const fail=(code,status=409,extra={})=>Object.assign(new Error(messages[code]?.[0]||messages.TLS_COMMAND[0]),{code,status,...extra});
export function tlsErrorPayload(error,language='en'){if(!messages[error?.code])return null;const errorI18n=metadata(error.code);return{code:error.code,error:errorI18n[language==='vi'?'vi':'en'],errorI18n,...(error.outcomeUnknown?{outcomeUnknown:true}:{})};}
export function assertTLSHelper(filename){
 const canonical=fs.realpathSync(filename);if(canonical!==filename||!path.isAbsolute(filename))throw fail('TLS_OWNERSHIP');
 for(let parent=path.dirname(filename);;parent=path.dirname(parent)){const info=fs.lstatSync(parent);if(!info.isDirectory()||info.uid!==0||info.mode&0o022)throw fail('TLS_OWNERSHIP');if(parent==='/')break;}
 const info=fs.lstatSync(filename);if(!info.isFile()||info.uid!==0||info.nlink!==1||info.mode&0o022)throw fail('TLS_OWNERSHIP');
}
function invokeHelper(filename,action,input){
 assertTLSHelper(filename);
 return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/python3',['-I','-B',filename,action],{stdio:['pipe','pipe','pipe'],detached:true,windowsHide:true,shell:false,env:{PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'}});
  let output='',size=0,settled=false;
  const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const timer=setTimeout(()=>{kill();finish(fail('TLS_UNKNOWN',504,{outcomeUnknown:action!=='inspect'}));},action==='inspect'?15000:600000);timer.unref?.();
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
  for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){kill();finish(fail('TLS_UNKNOWN',502,{outcomeUnknown:action!=='inspect'}));}else if(stream===child.stdout)output+=chunk;});
  child.on('error',()=>finish(fail('TLS_PLATFORM',503)));child.stdin.on('error',()=>{});
  child.on('close',()=>{if(settled)return;let result;try{result=JSON.parse(output);}catch{return finish(fail('TLS_UNKNOWN',502,{outcomeUnknown:action!=='inspect'}));}if(result.ok!==true||!result.tls)return finish(fail(messages[result.code]?result.code:'TLS_COMMAND',409,{outcomeUnknown:result.code==='TLS_RECOVERY'}));finish(null,result.tls);});
  child.stdin.end(input?JSON.stringify(input):'');
 });
}
export function createHostTLSController({store,manager,platform=process.platform,uid=process.getuid?.(),helperPath=fileURLToPath(new URL('./host-tls.py',import.meta.url)),native=invokeHelper}={}){
 const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,terminal=row=>['completed','failed'].includes(row?.status),ttl=7*86400000;
 let closed=false,active=null,flight=null,admission=null;
 const localJobs=new Map();
 const supported=()=>platform==='linux'&&uid===0;
 const fields=['id','status','phase','progress','startedAt','completedAt','recovered','errorCode'],phases=new Set(['preparing','challenge','issuing','activating','verified','failed','recovery-required','interrupted']);
 const publicJob=row=>{
  if(!row||!uuid.test(row.id||'')||!['queued','running','completed','failed','unknown'].includes(row.status))return null;
  const value=Object.fromEntries(fields.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
  value.type='tls';value.progress=Number.isFinite(row.progress)?Math.max(0,Math.min(100,row.progress)):0;
  if(!phases.has(value.phase))value.phase='preparing';
  for(const key of['startedAt','completedAt'])if(typeof value[key]!=='string'||value[key].length>40||!Number.isFinite(Date.parse(value[key])))delete value[key];
  if(Object.hasOwn(value,'recovered'))value.recovered=value.recovered===true;
  if(value.errorCode==null)delete value.errorCode;
  else if(typeof value.errorCode!=='string')value.errorCode='TLS_COMMAND';
  if(messages[value.errorCode]){value.error=messages[value.errorCode][0];value.errorI18n=metadata(value.errorCode);}
  return value;
 };
 for(const row of Array.isArray(store?.data?.hostTLSJobs)?store.data.hostTLSJobs.slice(-32):[]){const value=publicJob(row);if(value)localJobs.set(value.id,{...value,...(typeof row.requestRevision==='string'?{requestRevision:row.requestRevision}:{}),...(!terminal(value)?{status:'unknown',errorCode:'TLS_UNKNOWN'}:{})});}
 function prune(){for(const[id,row]of localJobs)if(terminal(row)&&Date.parse(row.completedAt||row.startedAt)<Date.now()-ttl)localJobs.delete(id);while(localJobs.size>32){const candidate=[...localJobs].find(([,row])=>terminal(row));if(!candidate)break;localJobs.delete(candidate[0]);}}
 function persist(){prune();if(!store?.data||typeof store.save!=='function')throw fail('TLS_PERSIST',503);store.data.hostTLSJobs=[...localJobs.values()].map(row=>({...publicJob(row),...(row.requestRevision?{requestRevision:row.requestRevision}:{})}));try{store.save();}catch{throw fail('TLS_PERSIST',503);}}
 function mergeResult(value,row){for(const key of['errorCode','completedAt','recovered'])if(!Object.hasOwn(row,key))delete value[key];Object.assign(value,row);return value;}
 function remember(row){const previous=localJobs.get(row.id);if(previous)return mergeResult(previous,row);const value={...row};localJobs.set(row.id,value);return value;}
 function decorate(raw){
  const rows=new Map([...localJobs].map(([id,row])=>[id,publicJob(row)]));
  for(const source of Array.isArray(raw.jobs)?raw.jobs.slice(-32):[]){const row=publicJob(source);if(!row)continue;if(row.status==='running'&&!raw.operationActive&&active?.id!==row.id){row.status='unknown';row.errorCode='TLS_UNKNOWN';row.error=messages.TLS_UNKNOWN[0];row.errorI18n=metadata('TLS_UNKNOWN');}rows.set(row.id,row);}
  const jobs=[...rows.values()].filter(Boolean).sort((a,b)=>String(a.startedAt||'').localeCompare(String(b.startedAt||'')));
  const recoveryRequired=raw.recoveryRequired===true||jobs.some(row=>row.status==='unknown');
  const reasonCode=raw.reasonCode||(recoveryRequired?'TLS_RECOVERY':null);
  return {...Object.fromEntries(['available','address','mode','certificate','automaticRenewal','revision','observedAt','operationActive','statusAvailable'].filter(key=>Object.hasOwn(raw,key)).map(key=>[key,raw[key]])),renewal:raw.renewal?Object.fromEntries(['status','lastSuccessAt','errorCode','startedAt','completedAt','recovered'].filter(key=>Object.hasOwn(raw.renewal,key)).map(key=>[key,raw.renewal[key]])):null,jobs,recoveryRequired,busy:!!active||raw.operationActive===true,reasonCode,reason:messages[reasonCode]?.[0]||null,reasonI18n:messages[reasonCode]?metadata(reasonCode):null};
 }
 async function read(){
  prune();if(!supported())return decorate({available:false,statusAvailable:false,reasonCode:'TLS_PLATFORM',mode:'unmanaged',jobs:[]});
  let raw;try{raw=await native(helperPath,'inspect');if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Array.isArray(raw.jobs))throw fail('TLS_UNKNOWN');raw={...raw,statusAvailable:true};}catch(error){return decorate({available:false,statusAvailable:false,mode:'unmanaged',reasonCode:messages[error.code]?error.code:'TLS_PLATFORM',jobs:[]});}
  const state=decorate(raw);let changed=false;
  for(const row of state.jobs)if(localJobs.has(row.id)&&JSON.stringify(publicJob(localJobs.get(row.id)))!==JSON.stringify(row)){remember(row);changed=true;}
  if(changed)try{persist();}catch{} // The authoritative helper record is already durable.
  return state;
 }
 async function job(id){if(!uuid.test(id||''))throw fail('TLS_INPUT',400);const state=await read();if(state.statusAvailable===false)throw fail(messages[state.reasonCode]?state.reasonCode:'TLS_UNKNOWN',503);const row=state.jobs.find(row=>row.id===id);if(!row)throw fail('TLS_INPUT',404);return row;}
 function validate(input,recovery=false){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!(recovery?['requestId','revision','confirmed']:['requestId','revision','confirmed','termsAccepted']).includes(key))||!uuid.test(input.requestId||'')||!/^[a-f0-9]{64}$/.test(input.revision||''))throw fail('TLS_INPUT',400);if(input.confirmed!==true||!recovery&&input.termsAccepted!==true)throw fail('TLS_CONFIRM',400);}
 async function admit(input,callback,kind='issue'){
  if(closed)throw fail('TLS_CLOSED');if(!supported())throw fail('TLS_PLATFORM');
  if(admission){if(admission.id===input.requestId){if(admission.signature!==`${kind}:${input.revision}`)throw fail('TLS_INPUT',400);return{...await admission.promise,replayed:true};}throw fail('TLS_BUSY');}
  const pending={id:input.requestId,signature:`${kind}:${input.revision}`,promise:null};admission=pending;
  pending.promise=Promise.resolve().then(callback);
  try{return await pending.promise;}finally{if(admission===pending)admission=null;}
 }
 function accepted(input,user,action='request'){
  const value=remember({id:input.requestId,type:'tls',status:'queued',phase:'preparing',progress:0,startedAt:new Date().toISOString(),requestRevision:input.revision});
  const before=store.data.hostTLSJobs;store.data.hostTLSJobs=[...localJobs.values()].map(row=>({...publicJob(row),...(row.requestRevision?{requestRevision:row.requestRevision}:{})}));
  try{store.audit(`host.tls.${action}`,input.requestId,user?.username||'admin');}catch{localJobs.delete(value.id);store.data.hostTLSJobs=before;throw fail('TLS_PERSIST',503);}
  return value;
 }
 function finishError(value,error){const code=messages[error?.code]?error.code:'TLS_COMMAND';Object.assign(value,{status:error?.outcomeUnknown||code==='TLS_RECOVERY'||code==='TLS_UNKNOWN'?'unknown':'failed',phase:code==='TLS_RECOVERY'?'recovery-required':'failed',errorCode:code,completedAt:new Date().toISOString()});try{persist();}catch{}return publicJob(value);}
 async function start(input,user){
  validate(input);return admit(input,async()=>{
   if(active){if(active.id===input.requestId){if(active.requestRevision!==input.revision)throw fail('TLS_INPUT',400);return{job:publicJob(active),replayed:true};}throw fail('TLS_BUSY');}
   const before=await read();if(closed)throw fail('TLS_CLOSED');const existing=before.jobs.find(row=>row.id===input.requestId);
   if(existing){const old=localJobs.get(existing.id);if(old?.requestRevision&&old.requestRevision!==input.revision)throw fail('TLS_INPUT',400);return{job:existing,replayed:true};}
   if(!before.available)throw fail(messages[before.reasonCode]?before.reasonCode:'TLS_ACCESS');if(before.busy)throw fail('TLS_BUSY');if(before.recoveryRequired)throw fail('TLS_RECOVERY');if(before.revision!==input.revision)throw fail('TLS_CHANGED');
   const value=accepted(input,user);active=value;
   const run=async()=>{
    value.status='running';try{persist();const after=await native(helperPath,'issue',input),result=publicJob(after.jobs?.find(row=>row.id===value.id));if(!result||result.status!=='completed'||after.mode!=='public-ca'||after.automaticRenewal!==true)throw fail('TLS_UNKNOWN',502,{outcomeUnknown:true});mergeResult(value,result);persist();try{store.audit('host.tls.completed',value.id,user?.username||'admin');}catch{}}catch(error){let durable;try{durable=(await read()).jobs.find(row=>row.id===value.id);}catch{}if(durable&&terminal(durable)){mergeResult(value,durable);try{persist();}catch{}}else finishError(value,error);}finally{if(active===value)active=null;}
   };
   try{flight=Promise.resolve(manager?.withHostOperation?manager.withHostOperation(run):run()).catch(error=>finishError(value,error)).finally(()=>{if(active===value)active=null;flight=null;});}catch(error){finishError(value,error);active=null;}
   return{job:publicJob(value)};
  });
 }
 async function recover(input,user){
  validate(input,true);return admit(input,async()=>{
   if(active)throw fail('TLS_BUSY');const before=await read();if(closed)throw fail('TLS_CLOSED');if(before.statusAvailable===false)throw fail(messages[before.reasonCode]?before.reasonCode:'TLS_UNKNOWN',503);if(before.busy)throw fail('TLS_BUSY');if(before.revision!==input.revision)throw fail('TLS_CHANGED');
   const previous=before.jobs.find(row=>row.id===input.requestId),pending=before.jobs.filter(row=>['queued','running','unknown'].includes(row.status)),renewalRecovery=!previous&&['unknown','running'].includes(before.renewal?.status);
   if(pending.some(row=>row.id!==input.requestId))throw fail('TLS_CHANGED');
   if(previous&&terminal(previous)&&!before.recoveryRequired)return{tls:before,job:previous,replayed:true};
   if(!previous&&!['unknown','running'].includes(before.renewal?.status))throw fail('TLS_INPUT',404);
   // Inspect may be unavailable precisely because activation was interrupted.
   // Its durable revision/job still identify the transaction; only the locked
   // helper can decide whether the served candidate or previous state is safe.
   const value=previous?remember(previous):accepted(input,user,'recovery.request');active=value;
   const run=async()=>{try{
    try{store.audit('host.tls.recovery.request',value.id,user?.username||'admin');}catch{throw fail('TLS_PERSIST',503,{outcomeUnknown:!terminal(previous)});}
    const raw=await native(helperPath,'recover',{revision:input.revision,confirmed:true}),record=publicJob(raw.jobs?.find(row=>row.id===value.id));
    if(raw.recoveryRequired||record&&!terminal(record))throw fail('TLS_RECOVERY',409,{outcomeUnknown:true});
    const renewed=renewalRecovery&&raw.renewal?.status==='completed';mergeResult(value,record||{status:renewed?'completed':'failed',phase:renewed?'verified':'interrupted',progress:renewed?100:value.progress,errorCode:renewed?null:'TLS_INTERRUPTED',completedAt:new Date().toISOString(),recovered:true});try{persist();}catch{}
    try{store.audit('host.tls.recovery.completed',value.id,user?.username||'admin');}catch{}
    if(active===value)active=null;return{tls:decorate(raw),job:publicJob(value)};
   }catch(error){finishError(value,error);throw error;}finally{if(active===value)active=null;}};
   flight=Promise.resolve().then(()=>manager?.withHostOperation?manager.withHostOperation(run):run());try{return await flight;}catch(error){if(active===value){active=null;finishError(value,fail('TLS_BUSY',409,{outcomeUnknown:!terminal(previous)}));}throw error;}finally{flight=null;}
  },'recover');
 }
 return{read,start,recover,job,async close(){closed=true;await admission?.promise.catch(()=>{});await flight?.catch(()=>{});}};
}
