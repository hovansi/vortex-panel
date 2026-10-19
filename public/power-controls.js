import {wireText,uiHTML,uiText} from './i18n.js';

const text=(en,vi)=>wireText(en,{en,vi});
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const pending=new Map(),observing=new WeakMap();
let panelVersion=null,pendingGeneration=0;
const frontendVersion=typeof document==='undefined'?null:document.querySelector?.('meta[name="vortex-frontend-version"]')?.content;
export function resetPowerClientState(){pendingGeneration++;pending.clear();}
function releasePending(nodeId,request){if(pending.get(nodeId)?.requestId===request?.requestId)pending.delete(nodeId);}

export function panelVersionLabel(value=frontendVersion||panelVersion){return typeof value==='string'&&/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/.test(value)?`v${value}`:text('Version unavailable','Chưa rõ phiên bản');}
export function syncPanelVersion(root=document){for(const element of root.querySelectorAll('[data-panel-version]'))uiText(element,panelVersionLabel());}
export async function refreshPanelVersion(fetcher=fetch,root=document){
 try{const response=await fetcher('/healthz',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error();const result=await response.json();panelVersion=typeof result.version==='string'?result.version:null;}catch{panelVersion=null;}
 syncPanelVersion(root);return panelVersion;
}

export function powerPath(nodeId){return nodeId==='local'?'/host/power':`/nodes/${encodeURIComponent(nodeId)}/power`;}
export function powerState(response,nodeId){
 const power=response?.power;
 if(response?.nodeId!==nodeId||power?.nodeId!==nodeId)throw Error(text('The VPS response does not match the selected VPS. Refresh and try again.','Phản hồi không khớp VPS đã chọn. Hãy làm mới và thử lại.'));
 return power;
}
export function powerActionAllowed(power,action){return power?.available===true&&power.busy!==true&&['panel','worker'].includes(power.role)&&typeof power.revision==='string'&&Boolean(power.revision)&&Array.isArray(power.actions)&&power.actions.includes(action)&&['restart-service','reboot'].includes(action);}
export function powerObservation(power,request){
 const operation=power?.lastOperation?.requestId===request.requestId?power.lastOperation:null;
 if(operation?.status==='failed')return {status:'failed',error:wireText(operation.error,operation.errorI18n)||text('The action could not be completed.','Không thể hoàn tất thao tác.')};
 const key=request.action==='reboot'?'bootId':'instanceId',before=request.baseline?.[key],after=power?.[key];
 if(typeof before==='string'&&before&&typeof after==='string'&&after&&before!==after)return {status:'completed'};
 if(operation&&['accepted','scheduled'].includes(operation.status))return {status:operation.status};
 return {status:'unknown'};
}
export function powerImpact(role,action){
 if(action==='reboot')return role==='panel'?text('This VPS, the panel and its hosted servers and applications will restart. Active connections to this VPS will be interrupted. Workloads on other VPS stay running.','VPS này, panel và các máy chủ, ứng dụng trên VPS sẽ khởi động lại. Kết nối đang hoạt động tới VPS này sẽ bị gián đoạn. Máy chủ và ứng dụng ở VPS khác tiếp tục chạy.'):text('This VPS and all its hosted servers and applications will restart. Active connections to this VPS will be interrupted. The main panel and other VPS stay available.','VPS này cùng mọi máy chủ và ứng dụng trên đó sẽ khởi động lại. Kết nối đang hoạt động tới VPS này sẽ bị gián đoạn. Panel chính và các VPS khác tiếp tục hoạt động.');
 return role==='panel'?text('The panel will briefly disconnect. Managed servers and applications on this VPS will stop and follow their startup settings when the panel returns. Workloads on other VPS stay running.','Panel sẽ tạm mất kết nối. Các máy chủ và ứng dụng được quản lý trên VPS này sẽ dừng và chạy lại theo thiết lập tự khởi động khi panel trở lại. Máy chủ và ứng dụng ở VPS khác tiếp tục chạy.'):text('The VPS management service will restart. Managed servers and applications on this VPS will stop and follow their startup settings when the service returns. Their active connections may be interrupted.','Dịch vụ quản lý VPS sẽ khởi động lại. Các máy chủ và ứng dụng được quản lý trên VPS này sẽ dừng và chạy lại theo thiết lập tự khởi động khi dịch vụ trở lại. Kết nối đang hoạt động tới chúng có thể bị gián đoạn.');
}
const actionLabel=(role,action)=>action==='reboot'?text('Reboot VPS','Khởi động lại VPS'):role==='panel'?text('Restart panel','Khởi động lại panel'):text('Restart management service','Khởi động lại dịch vụ quản lý');
export function powerControlsMarkup(node){
 const local=node.local===true||node.id==='local',role=local?'panel':'worker';
 return `<section class="vps-power-controls" data-power-controls data-power-node="${escape(node.id)}" data-power-name="${escape(node.name||'Vortex Panel')}" data-power-role="${role}"><div class="vps-power-heading"><h3>${escape(local?text('Panel & VPS','Panel & VPS'):text('VPS controls','Điều khiển VPS'))}</h3><span class="badge neutral" data-power-availability>${escape(text('Checking availability…','Đang kiểm tra…'))}</span></div><p class="panel-description">${escape(local?text('Restart the panel service or reboot the main VPS. Review the affected servers before confirming.','Khởi động lại dịch vụ panel hoặc VPS chính. Xem phạm vi ảnh hưởng trước khi xác nhận.'):text('Restart this VPS’s management service or reboot the whole VPS.','Khởi động lại dịch vụ quản lý hoặc toàn bộ VPS này.'))}</p><div class="actions">${['restart-service','reboot'].map(action=>`<button type="button" class="btn intent-warning" data-intent="warning" data-action="vps-power" data-node-id="${escape(node.id)}" data-power-action="${action}" disabled>${escape(actionLabel(role,action))}</button>`).join('')}<button type="button" class="btn text" data-action="vps-power-status" data-node-id="${escape(node.id)}" hidden>${escape(text('View restart status','Xem trạng thái khởi động lại'))}</button></div><p class="panel-description vps-power-message" data-power-message role="status" aria-live="polite"></p></section>`;
}
async function request(context,path,options={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{return await context.api(path,{...options,signal:controller.signal});}finally{clearTimeout(timer);}}
function currentRequest(nodeId,power){const active=pending.get(nodeId),previous=power?.lastOperation;if(active)return active;return previous&&['accepted','scheduled','unknown'].includes(previous.status)?previous:null;}
function syncControls(root,power,error){
 const nodeId=root.dataset.powerNode,active=currentRequest(nodeId,power),observation=active&&powerObservation(power,active),waiting=active&&!['completed','failed'].includes(observation?.status);
 if(active&&observation?.status==='completed')releasePending(nodeId,active);
 uiText(root.querySelector('[data-power-availability]'),error?text('Unavailable','Chưa khả dụng'):power.available?text('Available','Sẵn sàng'):text('Unavailable','Chưa khả dụng'));
 for(const button of root.querySelectorAll('[data-power-action]'))button.disabled=Boolean(error||waiting||!powerActionAllowed(power,button.dataset.powerAction));
 root.querySelector('[data-action="vps-power-status"]').hidden=!active;
 uiText(root.querySelector('[data-power-message]'),error?.message||(waiting?text('A restart request is being checked. Check its status before sending another request.','Đang kiểm tra yêu cầu khởi động lại. Xem trạng thái trước khi gửi yêu cầu khác.'):wireText(power?.reason,power?.reasonI18n)||''));
}
export async function bindPowerControls(root,context){
 if(!context.isAdmin())return;
 await Promise.all([...root.querySelectorAll('[data-power-controls]')].map(async element=>{try{const power=powerState(await request(context,powerPath(element.dataset.powerNode)),element.dataset.powerNode);if(element.isConnected)syncControls(element,power);}catch(error){if(element.isConnected)syncControls(element,null,error);}}));
}
function progressMarkup(nodeId,request){return `<section class="vps-power-progress" data-power-progress="${escape(nodeId)}"><span class="badge warn" data-power-status></span><h3 data-power-progress-title></h3><p data-power-progress-message role="status" aria-live="polite"></p><p class="panel-description">${escape(text('The panel only checks status after sending your request. It will never automatically send the restart again.','Sau khi gửi yêu cầu, panel chỉ kiểm tra trạng thái và không tự gửi lại lệnh khởi động.'))}</p><div class="actions"><button type="button" class="btn soft" data-action="vps-power-status" data-node-id="${escape(nodeId)}" data-power-request="${escape(request.requestId)}">${escape(text('Check status','Kiểm tra trạng thái'))}</button></div></section>`;}
function updateProgress(root,request,observation){
 if(!root?.isConnected)return;
 const status=observation.status,done=status==='completed',failed=status==='failed';root.dataset.powerOutcome=status;
 uiText(root.querySelector('[data-power-status]'),done?text('Confirmed','Đã xác minh'):failed?text('Failed','Thất bại'):status==='unknown'?text('Outcome not confirmed','Chưa xác minh kết quả'):text('Request accepted','Đã nhận yêu cầu'));
 uiText(root.querySelector('[data-power-progress-title]'),done?text('The VPS is available again','VPS đã kết nối trở lại'):failed?text('Restart did not complete','Chưa hoàn tất khởi động lại'):text('Waiting for the VPS to return','Đang chờ VPS kết nối lại'));
 uiText(root.querySelector('[data-power-progress-message]'),done?(request.action==='reboot'?text('A new VPS startup was verified. Check the server and application list for their current status.','Đã xác minh VPS khởi động mới. Xem danh sách máy chủ và ứng dụng để kiểm tra trạng thái hiện tại.'):text('A new service session was verified. Check the server and application list for their current status.','Đã xác minh dịch vụ khởi động mới. Xem danh sách máy chủ và ứng dụng để kiểm tra trạng thái hiện tại.')):failed?observation.error:status==='unknown'?text('The connection or action result is not yet confirmed. Do not send another restart; use Check status to keep checking.','Chưa xác minh được kết nối hoặc kết quả thao tác. Không gửi lại lệnh khởi động; dùng Kiểm tra trạng thái để kiểm tra tiếp.'):text('The request was accepted. A temporary disconnection is expected; completion is confirmed only after a new startup is observed.','Yêu cầu đã được nhận. Kết nối có thể gián đoạn; panel chỉ xác nhận hoàn tất khi ghi nhận lần khởi động mới.'));
}
export function observePower(nodeId,request,context,root,options={}){
 if(!root)return Promise.resolve({status:'unknown'});if(observing.has(root))return observing.get(root);
 const observation=runObservation(nodeId,request,context,root,options).finally(()=>observing.delete(root));observing.set(root,observation);return observation;
}
async function runObservation(nodeId,request,context,root,{attempts=60,delay=2000}={}){
 for(let attempt=0;attempt<attempts&&root?.isConnected&&document.querySelector('#modal')?.open&&context.isAdmin();attempt++){
  let observation;try{const power=powerState(await requestPowerStatus(context,nodeId),nodeId);observation=powerObservation(power,request);}catch{observation={status:'unknown'};}
  updateProgress(root,request,observation);
  if(['completed','failed'].includes(observation.status)){releasePending(nodeId,request);if(observation.status==='completed'){void refreshPanelVersion();void context.refresh().then(()=>bindPowerControls(document,context)).catch(()=>{});}return observation;}
  if(attempt+1<attempts)await new Promise(resolve=>setTimeout(resolve,delay));
 }
 updateProgress(root,request,{status:'unknown'});return {status:'unknown'};
}
const requestPowerStatus=(context,nodeId)=>request(context,powerPath(nodeId));
export async function handlePowerAction(action,target,context){
 if(!['vps-power','vps-power-status'].includes(action))return false;
 if(!context.isAdmin())throw Error(text('Administrator access is required.','Cần quyền quản trị viên.'));
 const generation=pendingGeneration;
 const nodeId=target.dataset.nodeId||'local',origin=target.closest('[data-power-controls]'),node=context.nodes().find(item=>item.id===nodeId),name=origin?.dataset.powerName||node?.name||'Vortex Panel';
 if(action==='vps-power-status'){
  let active=pending.get(nodeId);if(!active){const power=powerState(await requestPowerStatus(context,nodeId),nodeId);active=power.lastOperation;if(!active)throw Error(text('There is no recent restart request for this VPS.','VPS này chưa có yêu cầu khởi động lại gần đây.'));}
  if(generation!==pendingGeneration||context.isCurrent&&!context.isCurrent())return true;
  const existing=document.querySelector('[data-power-progress]');if(existing?.dataset.powerProgress===nodeId){void observePower(nodeId,active,context,existing);return true;}
  if(await context.openModal(name,text('Restart status','Trạng thái khởi động lại'),progressMarkup(nodeId,active),null)===false)return true;
  const progress=document.querySelector('[data-power-progress]');updateProgress(progress,active,{status:'unknown'});void observePower(nodeId,active,context,progress);return true;
 }
 const power=powerState(await requestPowerStatus(context,nodeId),nodeId),powerAction=target.dataset.powerAction;
 if(generation!==pendingGeneration||context.isCurrent&&!context.isCurrent())return true;
 const active=currentRequest(nodeId,power);if(active&&!['completed','failed'].includes(powerObservation(power,active).status))throw Error(text('A restart request is still being checked. Open its status before starting another action.','Yêu cầu khởi động lại vẫn đang được kiểm tra. Mở trạng thái trước khi thực hiện thao tác khác.'));
 if(!powerActionAllowed(power,powerAction))throw Error(wireText(power.reason,power.reasonI18n)||text('This action is unavailable on the selected VPS.','VPS đã chọn chưa hỗ trợ thao tác này.'));
 const reboot=powerAction==='reboot',label=actionLabel(power.role,powerAction),body=`<div class="notice warn vps-power-impact">${escape(powerImpact(power.role,powerAction))}</div>${reboot?`<div class="field spacer"><label for="power-confirm-name">${escape(text('Type the VPS name to confirm','Nhập tên VPS để xác nhận'))}</label><input id="power-confirm-name" name="confirmName" autocomplete="off" spellcheck="false" required><small>${escape(name)}</small></div>`:''}<label class="vps-power-ack"><input type="checkbox" name="acknowledged" required><span>${escape(text('I understand the interruption and want to continue.','Tôi hiểu kết nối sẽ gián đoạn và muốn tiếp tục.'))}</span></label>`;
 await context.openModal(`${label} · ${name}`,text('Review the interruption before confirming.','Kiểm tra ảnh hưởng trước khi xác nhận.'),body,async(values,form)=>{
  if(generation!==pendingGeneration)return false;
  if(values.acknowledged!=='on'||reboot&&values.confirmName!==name)throw Error(text('Confirm the interruption and enter the VPS name exactly as shown.','Xác nhận việc gián đoạn và nhập đúng tên VPS đang hiển thị.'));
  if(!context.isAdmin())throw Error(text('Administrator access is required.','Cần quyền quản trị viên.'));
  const operation={requestId:crypto.randomUUID(),action:powerAction,baseline:{instanceId:power.instanceId,bootId:power.bootId,revision:power.revision}};
  form.dataset.committed='true';form.dataset.dirty='false';pending.set(nodeId,operation);if(origin?.isConnected)syncControls(origin,power);
  let observation={status:'unknown'};
  try{const result=await request(context,powerPath(nodeId),{method:'POST',body:{nodeId,action:powerAction,confirmed:true,revision:power.revision,requestId:operation.requestId}});if(result.nodeId!==nodeId||result.operation?.requestId!==operation.requestId)throw Error();Object.assign(operation,result.operation);observation={status:result.accepted?'accepted':'unknown'};}
  catch(error){if(error.status>=400&&error.status<500&&!error.outcomeUnknown){releasePending(nodeId,operation);observation={status:'failed',error:error.message};}}
  if(form.isConnected){uiHTML(form,progressMarkup(nodeId,operation));const progress=form.querySelector('[data-power-progress]');updateProgress(progress,operation,observation);if(observation.status!=='failed')void observePower(nodeId,operation,context,progress);}
  return false;
 },label,false,{intent:'warning'});
 return true;
}
