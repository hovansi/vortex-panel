import {wireText,uiHTML,uiText,replaceUI,uiAttr,formatUI} from './i18n.js';
import {formatPanelDate} from './timezone.js';
import {serviceText as text,serviceEscape as escape,serviceDialogContext,serviceField,clearServiceSecrets,protectServiceSecrets} from './service-ui.js';
import {beginButtonBusy} from './button-busy.js';

const pending=new Map(),reads=new Map(),watchers=new Set(),bindings=new WeakMap();let generation=0;
export function resetMemoryClientState(){pending.clear();generation++;for(const watcher of watchers)watcher.stop();for(const value of reads.values())value.controller.abort();reads.clear();}
export const memoryPath=nodeId=>`/nodes/${encodeURIComponent(nodeId)}/zram`;
export function memoryState(response,nodeId){
 const value=response?.zram;
 if(response?.nodeId!==nodeId||!value||value.nodeId!==nodeId||typeof value.revision!=='string'||!value.revision)throw Error(text('The VPS memory response could not be verified.','Không xác minh được thông tin bộ nhớ của VPS.'));
 return value;
}
export function memoryActionAllowed(value){return value?.available===true&&['none','vortex'].includes(value.ownership)&&value.busy!==true&&!['running','unknown'].includes(value.lastOperation?.status)&&typeof value.revision==='string'&&Boolean(value.revision);}
function operation(value,nodeId){
 const active=pending.get(nodeId),last=value.lastOperation;
 if(active&&last?.requestId===active.requestId&&['completed','failed'].includes(last.status)&&value.busy!==true){pending.delete(nodeId);return last;}
 return active||last;
}
const enabled=value=>value?.effective?.enabled===true;
const bytes=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?formatUI(value,(locale,size)=>{const index=size>0?Math.min(4,Math.max(0,Math.floor(Math.log(size)/Math.log(1024)))):0;return `${new Intl.NumberFormat(locale,{maximumFractionDigits:index>0?1:0}).format(size/1024**index)} ${['B','KiB','MiB','GiB','TiB'][index]}`;}):'—';
const note=()=>text('Compressed memory helps the operating system cope with memory pressure. It does not increase the RAM available to managed workloads.','Bộ nhớ nén hỗ trợ hệ điều hành khi thiếu RAM. Tính năng này không tăng RAM có thể cấp cho các máy chủ và ứng dụng.');
const status=value=>{const telemetry=memoryTelemetry(value);return telemetry.status==='active'?text('Active','Đang hoạt động'):telemetry.status==='inactive'?text('Inactive','Chưa hoạt động'):text('Unavailable','Chưa khả dụng');};
const actionLabel=value=>enabled(value)?text('Disable memory assistance','Tắt hỗ trợ bộ nhớ'):text('Enable memory assistance','Bật hỗ trợ bộ nhớ');
const validBytes=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const algorithms=value=>Array.isArray(value)&&value.length<=32&&value.every(item=>typeof item==='string'&&/^[A-Za-z0-9_.+-]{1,64}$/.test(item))?[...new Set(value)].sort():null;
export function memoryTelemetry(value){
 const measured=value?.telemetry;
 if(measured?.schemaVersion===1){
  if(measured.scope!=='host-zram-swap'||measured.source!=='/proc/swaps + sysfs')return {status:'unavailable',logicalSizeBytes:null,swapUsedBytes:null,algorithms:null,complete:false,observedAt:null};
  const active=measured.available===true&&measured.status==='active',inactive=measured.available===true&&measured.status==='inactive';
  return {status:active?'active':inactive?'inactive':'unavailable',logicalSizeBytes:active&&validBytes(measured.logicalSizeBytes)?measured.logicalSizeBytes:null,swapUsedBytes:active&&validBytes(measured.swapUsedBytes)?measured.swapUsedBytes:null,algorithms:active?algorithms(measured.algorithms):null,complete:measured.complete===true,observedAt:measured.observedAt};
 }
 // Old workers may expose verified swap totals before independent telemetry.
 // Their owned-profile zeroes are never evidence about an external device.
 const summary=value?.swapSummary;
 if(summary?.source==='/proc/swaps'&&summary.scope==='host'&&summary.complete===true&&validBytes(summary.zram?.totalBytes)&&validBytes(summary.zram?.usedBytes))return {status:summary.zram.totalBytes>0?'active':'inactive',logicalSizeBytes:summary.zram.totalBytes,swapUsedBytes:summary.zram.usedBytes,algorithms:null,complete:false,observedAt:value.observedAt};
 const effective=value?.effective;
 if(value?.available===true&&value.ownership==='vortex'&&typeof effective?.enabled==='boolean')return {status:effective.enabled?'active':'inactive',logicalSizeBytes:effective.enabled&&validBytes(effective.logicalSizeBytes)?effective.logicalSizeBytes:null,swapUsedBytes:effective.enabled&&validBytes(effective.swapUsedBytes)?effective.swapUsedBytes:null,algorithms:effective.enabled&&typeof effective.algorithm==='string'?algorithms([effective.algorithm]):null,complete:effective.enabled&&validBytes(effective.logicalSizeBytes)&&validBytes(effective.swapUsedBytes),observedAt:value.observedAt};
 return {status:'unavailable',logicalSizeBytes:null,swapUsedBytes:null,algorithms:null,complete:false,observedAt:null};
}
export function memoryFacts(value,{preview=false}={}){
 if(preview){const facts=[[text('Physical RAM','RAM vật lý'),bytes(value.physicalMemoryBytes)],[text('Logical zram capacity','Dung lượng zram logic'),bytes(value.recommended?.logicalSizeBytes)],[text('Physical RAM limit for zram','Giới hạn RAM vật lý cho zram'),bytes(value.recommended?.residentLimitBytes)]];return `<dl class="service-facts">${facts.map(([label,v])=>`<div><dt>${escape(label)}</dt><dd>${escape(v)}</dd></div>`).join('')}</dl>`;}
 const measured=memoryTelemetry(value);
 if(measured.status!=='active')return `<p class="memory-empty">${escape(measured.status==='inactive'?text('No active zram swap.','Chưa có swap zram hoạt động.'):text('Memory measurements are unavailable.','Chưa đọc được số liệu bộ nhớ.'))}</p>`;
 const unknown=text('Unavailable','Chưa có số liệu'),facts=[[text('Total','Tổng'),measured.logicalSizeBytes===null?unknown:bytes(measured.logicalSizeBytes)],[text('Used','Đã dùng'),measured.swapUsedBytes===null?unknown:bytes(measured.swapUsedBytes)],[text('Compression','Cách nén'),measured.algorithms?.length?measured.algorithms.join(' · '):unknown]];
 return `<dl class="memory-metrics">${facts.map(([label,v])=>`<div><dt>${escape(label)}</dt><dd>${escape(v)}</dd></div>`).join('')}</dl>`;
}
export function memoryControlsMarkup(node){return `<section class="service-memory" data-memory-controls="${escape(node.id)}" data-memory-name="${escape(node.name||'Vortex Panel')}"><div class="service-section-heading"><div><h3>${escape(text('Compressed memory (zram)','Bộ nhớ nén (zram)'))}</h3></div><span class="badge neutral" data-memory-status>${escape(text('Checking…','Đang kiểm tra…'))}</span></div><div data-memory-facts></div><p class="panel-description service-feedback" data-memory-message role="status" aria-live="polite" hidden></p><div class="memory-footer"><span class="memory-observation" data-memory-observation></span><div class="actions"><button type="button" class="btn" data-action="memory-config" data-node-id="${escape(node.id)}" disabled>${escape(text('Configure assistance','Thiết lập hỗ trợ'))}</button><button type="button" class="btn intent-neutral" data-intent="neutral" data-action="memory-status" data-node-id="${escape(node.id)}"><svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg><span>${escape(text('Refresh','Tải lại'))}</span></button></div></div></section>`;}
export function memoryDetailsMarkup(value){
 const measured=memoryTelemetry(value),stamp=typeof measured.observedAt==='string'?new Date(measured.observedAt):null,time=stamp&&Number.isFinite(stamp.getTime())?formatUI(stamp,(locale,instant)=>formatPanelDate(instant,locale,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})):'';
 return `${time?`<span>${escape(text('Measured','Đo lúc'))} <time datetime="${escape(measured.observedAt)}">${escape(time)}</time></span>`:''}${measured.status==='active'&&(!measured.complete||measured.logicalSizeBytes===null||measured.swapUsedBytes===null||!measured.algorithms?.length)?`<span class="memory-partial">${escape(text('Partial measurement','Số liệu chưa đầy đủ'))}</span>`:''}`;
}
function sync(root,value){
 const nodeId=root.dataset.memoryControls,current=operation(value,nodeId),uncertain=current&&['running','unknown'].includes(current.status),button=root.querySelector('[data-action="memory-config"]');
 uiText(root.querySelector('[data-memory-status]'),status(value));
 uiHTML(root.querySelector('[data-memory-facts]'),memoryFacts(value));uiHTML(root.querySelector('[data-memory-observation]'),memoryDetailsMarkup(value));
 uiText(button,actionLabel(value));button.hidden=value.ownership==='external';button.disabled=!memoryActionAllowed(value)||Boolean(uncertain);button.classList.remove('intent-positive','intent-danger');button.classList.add(enabled(value)?'intent-danger':'intent-positive');button.dataset.intent=enabled(value)?'danger':'positive';
 const reason=uncertain?text('The previous change is unconfirmed. Refresh before trying again.','Chưa xác minh thay đổi trước. Tải lại trước khi thử tiếp.'):value.ownership==='external'?text('Managed outside Vortex. Configuration is preserved.','Được quản lý bên ngoài Vortex. Giữ nguyên cấu hình.'):wireText(value.reason,value.reasonI18n)||'';const message=root.querySelector('[data-memory-message]');uiText(message,reason);message.hidden=!reason;uiAttr(button,'title',reason||'');
}
function readMemory(context,nodeId){
 const token=generation,actor=context.actorId?.(),current=reads.get(nodeId);if(current?.token===token&&current.actor===actor)return current.promise;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);timer.unref?.();const entry={token,actor,controller};
 entry.promise=Promise.resolve().then(()=>context.api(memoryPath(nodeId),{signal:controller.signal})).then(response=>memoryState(response,nodeId)).catch(error=>{if(token!==generation||context.actorId?.()!==actor)throw Object.assign(Error('The memory status session changed.'),{code:'UI_SESSION_CHANGED'});throw error;}).finally(()=>{clearTimeout(timer);if(reads.get(nodeId)===entry)reads.delete(nodeId);});reads.set(nodeId,entry);return entry.promise;
}
// A single flight owns each refresh. Pausing never schedules another request,
// and a late result cannot repaint a detached or previous-session section.
export function createMemoryRefreshLoop({read,accept=()=>true,onValue=()=>{},onError=()=>{},onBusy=()=>{},interval=5000,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 let stopped=false,paused=true,timer=null,flight=null;
 const clear=()=>{if(timer!==null){clearTimer(timer);timer=null;}};
 const schedule=()=>{clear();if(!stopped&&!paused){timer=setTimer(()=>{timer=null;void refresh().catch(()=>{});},interval);timer?.unref?.();}};
 function refresh(){
  if(stopped||paused||!accept())return Promise.resolve(null);if(flight)return flight;clear();onBusy(true);
  flight=Promise.resolve().then(read).then(value=>{if(!stopped&&!paused&&accept())onValue(value);return value;},error=>{if(!stopped&&!paused&&accept())onError(error);throw error;}).finally(()=>{flight=null;onBusy(false);schedule();});return flight;
 }
 return {refresh,resume(){if(stopped)return Promise.resolve(null);if(!paused)return flight||Promise.resolve(null);paused=false;return refresh();},pause(){paused=true;clear();},stop(){stopped=true;paused=true;clear();}};
}
function memoryReadError(section,error){
 uiText(section.querySelector('[data-memory-status]'),text('Unavailable','Chưa khả dụng'));uiHTML(section.querySelector('[data-memory-facts]'),memoryFacts({}));uiHTML(section.querySelector('[data-memory-observation]'),'');
 const message=section.querySelector('[data-memory-message]');uiText(message,text('Unable to refresh. Try again.','Chưa tải lại được. Vui lòng thử lại.'));message.hidden=false;uiAttr(message,'title',error.message||'');section.querySelector('[data-action="memory-config"]').disabled=true;
}
function bindMemorySection(section,context){
 const prior=bindings.get(section);if(prior)return prior.loop.refresh().catch(()=>{});
 const token=generation,actor=context.actorId?.(),doc=section.ownerDocument,view=doc.defaultView||globalThis,valid=()=>token===generation&&section.isConnected&&context.isAdmin()&&context.actorId?.()===actor;
 const visible=()=>{if(doc.hidden||section.closest('[hidden]'))return false;const dialog=section.closest('dialog');if(dialog&&!dialog.open)return false;const box=section.getBoundingClientRect();return box.width>0&&box.height>0&&box.bottom>0&&box.top<(view.innerHeight||Infinity);};
 let finishBusy=null,previousVisible=false,stopped=false,visibility,detach;
 const loop=createMemoryRefreshLoop({read:()=>readMemory(context,section.dataset.memoryControls),accept:()=>valid()&&visible(),onValue:value=>sync(section,value),onError:error=>memoryReadError(section,error),onBusy:busy=>{
  const button=section.querySelector('[data-action="memory-status"]');if(busy){finishBusy=beginButtonBusy(button,{delay:0});button.disabled=true;}else{finishBusy?.();finishBusy=null;if(button.isConnected)button.disabled=false;}
 }});
 const watcher={loop,stop(){if(stopped)return;stopped=true;loop.stop();visibility?.disconnect();detach?.disconnect();doc.removeEventListener('visibilitychange',activity);view.removeEventListener?.('focus',focus);view.removeEventListener?.('scroll',activity,true);bindings.delete(section);watchers.delete(watcher);}};
 function activity(){if(!valid()){watcher.stop();return;}const current=visible();if(current===previousVisible)return;previousVisible=current;if(current)void loop.resume().catch(()=>{});else loop.pause();}
 function focus(){activity();if(previousVisible)void loop.refresh().catch(()=>{});}
 bindings.set(section,watcher);watchers.add(watcher);doc.addEventListener('visibilitychange',activity);view.addEventListener?.('focus',focus);view.addEventListener?.('scroll',activity,true);
 if(typeof view.IntersectionObserver==='function'){visibility=new view.IntersectionObserver(activity);visibility.observe(section);}
 if(typeof view.MutationObserver==='function'&&doc.body){detach=new view.MutationObserver(activity);detach.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','open','class','style']});}
 previousVisible=visible();if(previousVisible)return loop.resume().catch(()=>{});return Promise.resolve(null);
}
export async function bindMemoryControls(root,context){
 if(!context.isAdmin())return;
 const sections=[...(root.matches?.('[data-memory-controls]')?[root]:[]),...root.querySelectorAll('[data-memory-controls]')];await Promise.all(sections.map(section=>bindMemorySection(section,context)));
}
function resultMarkup(nodeId,value,error=''){
 const last=operation(value,nodeId),unknown=last?.status==='unknown'||last?.status==='running'||value.busy,failed=last?.status==='failed';
 return `<section class="service-operation" data-memory-result="${escape(nodeId)}"><span class="badge ${unknown||failed?'warn':'neutral'}">${escape(unknown?text('Outcome unconfirmed','Chưa xác minh kết quả'):failed?text('Change was not applied','Chưa áp dụng thay đổi'):text('State confirmed','Đã xác minh trạng thái'))}</span><h3>${escape(status(value))}</h3><p role="status">${escape(error||(unknown?text('Only status checks are available while this result is uncertain.','Chỉ có thể kiểm tra trạng thái khi kết quả chưa được xác minh.'):note()))}</p>${memoryFacts(value)}<div class="actions"><button type="button" class="btn intent-neutral" data-intent="neutral" data-action="memory-status" data-node-id="${escape(nodeId)}">${escape(text('Refresh status','Tải lại trạng thái'))}</button></div></section>`;
}
export async function handleMemoryAction(action,target,context){
 if(!['memory-config','memory-status'].includes(action))return false;
 if(!context.isAdmin())throw Error(text('Administrator access is required.','Cần quyền quản trị viên.'));
 const nodeId=target.dataset.nodeId||'local',token=generation,value=await readMemory(context,nodeId);
 if(token!==generation||context.isCurrent&&!context.isCurrent())return true;
 operation(value,nodeId);
 if(action==='memory-status'){
  const section=target.closest('[data-memory-controls]');if(section){sync(section,value);return true;}
  const result=target.closest('[data-memory-result]');if(result){replaceUI(result,resultMarkup(nodeId,value));return true;}
  return true;
 }
 if(!memoryActionAllowed(value)||['unknown','running'].includes(pending.get(nodeId)?.status))throw Error(wireText(value.reason,value.reasonI18n)||text('This memory setting is unavailable. Refresh its status before continuing.','Thiết lập bộ nhớ hiện chưa khả dụng. Tải lại trạng thái trước khi tiếp tục.'));
 const name=context.nodes().find(node=>node.id===nodeId)?.name||'Vortex Panel',enable=!enabled(value),label=actionLabel(value),body=`<div class="notice warn">${escape(note())}</div>${memoryFacts(value,{preview:true})}<p class="panel-description">${escape(enable?text('Vortex uses an automatic profile. Existing disk swap is kept. This operation does not reboot the VPS.','Vortex sử dụng cấu hình tự động và giữ nguyên bộ nhớ dự phòng trên ổ đĩa. Thao tác này không khởi động lại VPS.'):text('Disabling releases the compressed swap only when the VPS has enough memory. If memory is under pressure, Vortex will refuse the change and keep the current configuration.','Chỉ tắt khi VPS còn đủ bộ nhớ. Nếu đang thiếu bộ nhớ, Vortex từ chối thay đổi và giữ cấu hình hiện tại.'))}</p>${serviceField('memory-admin-password','password',text('Panel administrator password','Mật khẩu quản trị panel'),{type:'password',extra:'required autocomplete="current-password" maxlength="128"'})}<label class="service-ack"><input name="acknowledged" type="checkbox" required><span>${escape(text('I understand this changes system memory assistance, without increasing server capacity.','Tôi hiểu thao tác thay đổi hỗ trợ bộ nhớ hệ thống và không tăng tài nguyên cấp cho máy chủ.'))}</span></label>`;
 let dialog;
 const opened=await context.openModal(`${label} · ${name}`,text('Review the system change before confirming.','Kiểm tra thay đổi hệ thống trước khi xác nhận.'),body,async(values,form)=>{
  if(token!==generation||!dialog?.isCurrent()||form.dataset.committed==='true')return false;
  if(values.acknowledged!=='on'||!values.password)throw Error(text('Enter the administrator password and confirm the change.','Nhập mật khẩu quản trị và xác nhận thay đổi.'));
  const password=values.password;delete values.password;clearServiceSecrets(form);
  const requestId=crypto.randomUUID();pending.set(nodeId,{requestId,enabled:enable,status:'running'});form.dataset.committed='true';form.dataset.dirty='false';
  let result,errorMessage='';
  try{result=memoryState(await context.api(memoryPath(nodeId),{method:'POST',body:{nodeId,enabled:enable,profile:'auto',confirmed:true,revision:value.revision,requestId,password}}),nodeId);}
  catch(error){
   if(error.code==='UI_SESSION_CHANGED'||token!==generation||!dialog.isCurrent())return false;
   if(error.status>=400&&error.status<500&&!error.outcomeUnknown){pending.delete(nodeId);delete form.dataset.committed;throw error;}
   pending.set(nodeId,{requestId,enabled:enable,status:'unknown'});result=error.zram?.nodeId===nodeId?error.zram:{...value,busy:true,lastOperation:{requestId,enabled:enable,status:'unknown'}};errorMessage=error.message;
  }
  if(token!==generation||!dialog.isCurrent())return false;
  operation(result,nodeId);uiHTML(form,resultMarkup(nodeId,result,errorMessage));
  void bindMemoryControls(document,context);return false;
 },label,false,{intent:enable?'positive':'danger'});
 if(opened!==false){const form=document.querySelector('#modal-form');if(form){dialog=serviceDialogContext(context,form);protectServiceSecrets(form);}}
 return true;
}
