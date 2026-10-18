import {wireText,uiHTML,uiText,replaceUI,uiAttr,formatUI} from './i18n.js';
import {serviceText as text,serviceEscape as escape,serviceDialogContext,serviceField,clearServiceSecrets,protectServiceSecrets} from './service-ui.js';

const pending=new Map();let generation=0;
export function resetMemoryClientState(){pending.clear();generation++;}
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
const note=()=>text('Compressed memory helps the operating system cope with memory pressure. It does not increase the RAM available for game servers.','Bộ nhớ nén hỗ trợ hệ điều hành khi thiếu RAM. Tính năng này không tăng RAM có thể cấp cho máy chủ.');
const status=value=>value.ownership==='external'?text('Managed outside Vortex','Được quản lý bên ngoài Vortex'):value.busy?text('Checking an operation','Đang kiểm tra thao tác'):enabled(value)?text('Enabled','Đã bật'):text('Disabled','Đã tắt');
const actionLabel=value=>enabled(value)?text('Disable memory assistance','Tắt hỗ trợ bộ nhớ'):text('Enable memory assistance','Bật hỗ trợ bộ nhớ');
export function memoryFacts(value,{preview=false}={}){
 const facts=[[text('Physical RAM','RAM vật lý'),bytes(value.physicalMemoryBytes)],...(preview?[[text('Logical zram capacity','Dung lượng zram logic'),bytes(value.recommended?.logicalSizeBytes)],[text('Physical RAM limit for zram','Giới hạn RAM vật lý cho zram'),bytes(value.recommended?.residentLimitBytes)]]:[[text('RAM occupied by zram, including overhead','RAM zram đang chiếm, gồm chi phí quản lý'),bytes(value.effective?.residentBytes)]])];
 return `<dl class="service-facts">${facts.map(([label,v])=>`<div><dt>${escape(label)}</dt><dd>${escape(v)}</dd></div>`).join('')}</dl>`;
}
export function memoryControlsMarkup(node){return `<section class="service-memory" data-memory-controls="${escape(node.id)}" data-memory-name="${escape(node.name||'Vortex Panel')}"><div class="service-section-heading"><div><h3>${escape(text('System memory assistance','Hỗ trợ bộ nhớ hệ thống'))}</h3></div><span class="badge neutral" data-memory-status>${escape(text('Checking availability…','Đang kiểm tra…'))}</span></div><p class="panel-description">${escape(note())}</p><div data-memory-facts></div><p class="panel-description service-feedback" data-memory-message role="status" aria-live="polite"></p><div class="actions"><button type="button" class="btn" data-action="memory-config" data-node-id="${escape(node.id)}" disabled>${escape(text('Configure assistance','Thiết lập hỗ trợ'))}</button><button type="button" class="btn intent-neutral" data-intent="neutral" data-action="memory-status" data-node-id="${escape(node.id)}">${escape(text('Refresh status','Tải lại trạng thái'))}</button></div></section>`;}
export function memoryDetailsMarkup(value){
 const effective=value.effective||{},summary=value.swapSummary,details=[
  [text('Data before compression','Dữ liệu trước nén'),bytes(effective.originalDataBytes)],
  [text('Compressed data, without allocator overhead','Dữ liệu đã nén, chưa gồm chi phí quản lý'),bytes(effective.compressedDataBytes)],
  [text('Logical swap occupied in zram','Swap logic đang chiếm trong zram'),bytes(effective.swapUsedBytes)],
  [text('Logical zram capacity','Dung lượng zram logic'),bytes(effective.logicalSizeBytes)],
  [text('Physical RAM limit for zram','Giới hạn RAM vật lý cho zram'),effective.residentLimitBytes===0?text('No configured limit','Không đặt giới hạn'):bytes(effective.residentLimitBytes)],
  [text('Compression algorithm','Cách nén'),effective.algorithm||'—'],
  ...(summary?[[text('Other swap in use / capacity','Swap ngoài zram đang dùng / tổng'),summary.complete?`${bytes(summary.other?.usedBytes)} / ${bytes(summary.other?.totalBytes)}`:text('Not fully identified','Chưa xác định đầy đủ')]]:[])
 ];
 const stamp=typeof value.observedAt==='string'?new Date(value.observedAt):null,time=stamp&&Number.isFinite(stamp.getTime())?stamp.toLocaleTimeString(undefined,{hour12:false}):'';
 return `<details class="service-details" data-zram-details><summary>${escape(text('Compressed memory details (zram)','Chi tiết bộ nhớ nén (zram)'))}</summary><dl class="service-facts">${details.map(([k,v])=>`<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join('')}</dl><p class="panel-description">${escape(text('Compressed data is only the payload. Physical RAM use also includes allocation overhead. Logical capacity is not extra physical RAM, and occupied swap can differ from stored data.','Dữ liệu đã nén chỉ là phần nội dung. RAM thực dùng còn gồm chi phí cấp phát. Dung lượng logic không phải RAM vật lý cộng thêm; swap đã chiếm có thể khác dữ liệu đang lưu.'))}</p></details>${time?`<p class="memory-observation"><span>${escape(text('Measured','Đo lúc'))}</span> <time datetime="${escape(value.observedAt)}">${escape(time)}</time><span> · ${escape(text('Refresh to update','Tải lại trạng thái để cập nhật'))}</span></p>`:''}`;
}
function sync(root,value){
 const nodeId=root.dataset.memoryControls,current=operation(value,nodeId),uncertain=current&&['running','unknown'].includes(current.status),button=root.querySelector('[data-action="memory-config"]');
 uiText(root.querySelector('[data-memory-status]'),status(value));
 const expanded=root.querySelector('[data-zram-details]')?.open===true;uiHTML(root.querySelector('[data-memory-facts]'),`${memoryFacts(value)}${memoryDetailsMarkup(value)}`);if(expanded)root.querySelector('[data-zram-details]').open=true;
 uiText(button,actionLabel(value));button.disabled=!memoryActionAllowed(value)||Boolean(uncertain);button.classList.remove('intent-positive','intent-danger');button.classList.add(enabled(value)?'intent-danger':'intent-positive');button.dataset.intent=enabled(value)?'danger':'positive';
 const reason=uncertain?text('The previous result is unconfirmed. Refresh status; do not submit another change.','Chưa xác minh được kết quả trước đó. Tải lại trạng thái; không gửi thay đổi khác.'):wireText(value.reason,value.reasonI18n)||(value.ownership==='external'?text('This VPS already has compressed memory managed elsewhere. Vortex will not change it.','VPS đã có bộ nhớ nén được quản lý bên ngoài. Vortex không thay đổi cấu hình đó.'):'');uiText(root.querySelector('[data-memory-message]'),reason);uiAttr(button,'title',reason||'');
}
export async function bindMemoryControls(root,context){
 if(!context.isAdmin())return;
 const token=generation,actor=context.actorId?.(),sections=[...(root.matches?.('[data-memory-controls]')?[root]:[]),...root.querySelectorAll('[data-memory-controls]')];
 await Promise.all(sections.map(async section=>{try{const value=memoryState(await context.api(memoryPath(section.dataset.memoryControls)),section.dataset.memoryControls);if(token===generation&&section.isConnected&&context.isAdmin()&&context.actorId?.()===actor)sync(section,value);}catch(error){if(token===generation&&section.isConnected&&context.isAdmin()&&context.actorId?.()===actor){uiText(section.querySelector('[data-memory-status]'),text('Unavailable','Chưa khả dụng'));uiText(section.querySelector('[data-memory-message]'),error.message);}}}));
}
function resultMarkup(nodeId,value,error=''){
 const last=operation(value,nodeId),unknown=last?.status==='unknown'||last?.status==='running'||value.busy,failed=last?.status==='failed';
 return `<section class="service-operation" data-memory-result="${escape(nodeId)}"><span class="badge ${unknown||failed?'warn':'neutral'}">${escape(unknown?text('Outcome unconfirmed','Chưa xác minh kết quả'):failed?text('Change was not applied','Chưa áp dụng thay đổi'):text('State confirmed','Đã xác minh trạng thái'))}</span><h3>${escape(status(value))}</h3><p role="status">${escape(error||(unknown?text('Only status checks are available while this result is uncertain.','Chỉ có thể kiểm tra trạng thái khi kết quả chưa được xác minh.'):note()))}</p>${memoryFacts(value)}<div class="actions"><button type="button" class="btn intent-neutral" data-intent="neutral" data-action="memory-status" data-node-id="${escape(nodeId)}">${escape(text('Refresh status','Tải lại trạng thái'))}</button></div></section>`;
}
export async function handleMemoryAction(action,target,context){
 if(!['memory-config','memory-status'].includes(action))return false;
 if(!context.isAdmin())throw Error(text('Administrator access is required.','Cần quyền quản trị viên.'));
 const nodeId=target.dataset.nodeId||'local',token=generation,value=memoryState(await context.api(memoryPath(nodeId)),nodeId);
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
