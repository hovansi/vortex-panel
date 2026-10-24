import {wireText,uiHTML,uiText} from './i18n.js';
import {serviceText as text,serviceEscape as escape,serviceField,serviceDialogContext,protectServiceSecrets,clearServiceSecrets} from './service-ui.js';
import {operationProgressMarkup,updateOperationProgress,operationJobStatusLabel} from './operation-progress.js';

const base='/host/update',jobPath=id=>`${base}/jobs/${encodeURIComponent(id)}`;
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const VERSION=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,MACHINE=/^[a-f0-9]{32}$/i;
const active=new Set(['queued','running','preparing','updating','verifying','scheduled']);
const message=row=>wireText(row?.message,row?.messageI18n)||row?.code||'';
const button=(label,action,extra='',primary=false)=>`<button type="button" class="btn ${primary?'primary':'soft'}" data-action="${action}" ${extra}>${escape(label)}</button>`;
let accepted=null;

export function panelUpdatePlan(response){
 const value=response?.update;
 if(!value||value.schemaVersion!==1||!Array.isArray(value.nodes)||!Array.isArray(value.blockers)||typeof value.currentVersion!=='string'||!['blocked','ready','current'].includes(value.status))throw Error(text('The update plan could not be verified.','Không xác minh được kế hoạch cập nhật.'));
 const ids=new Set();for(const row of value.nodes){if(!row||typeof row.nodeId!=='string'||!row.nodeId||ids.has(row.nodeId)||typeof row.local!=='boolean'||row.local!==(row.nodeId==='local'))throw Error(text('The update plan contains an invalid VPS.','Kế hoạch cập nhật chứa VPS không hợp lệ.'));ids.add(row.nodeId);}
 if(value.nodes.filter(row=>row.local===true&&row.nodeId==='local').length!==1)throw Error(text('The main panel could not be identified.','Không xác định được panel chính.'));
 if(value.available&&(!SHA.test(value.revision||'')||value.release?.verified!==true||value.latestVersion!==value.release.version))throw Error(text('The official release could not be verified.','Không xác minh được bản phát hành chính thức.'));
 return {...value,nodes:[...value.nodes.filter(row=>!row.local),...value.nodes.filter(row=>row.local)]};
}
export function panelUpdateJob(response,id){
 const job=response?.job;
 if(!job||!UUID.test(job.id||'')||job.requestId!==job.id||id&&job.id!==id||!VERSION.test(job.version||'')||!SHA.test(job.release?.archiveSHA256||'')||!Array.isArray(job.nodes)||!job.nodes.length||typeof job.status!=='string'||!Number.isFinite(job.progress))throw Error(text('The update task could not be verified.','Không xác minh được tác vụ cập nhật.'));
 const ids=new Set();for(const row of job.nodes){if(!row||typeof row.nodeId!=='string'||!row.nodeId||ids.has(row.nodeId)||typeof row.local!=='boolean')throw Error(text('The update task contains an invalid VPS identity.','Tác vụ cập nhật chứa mã VPS không hợp lệ.'));ids.add(row.nodeId);}
 if(job.nodes.filter(row=>row.local&&row.nodeId==='local').length!==1||job.nodes.some(row=>row.local!== (row.nodeId==='local')))throw Error(text('The update task does not identify one main panel.','Tác vụ cập nhật không xác định đúng một panel chính.'));
 const proofValid=row=>{const proof=row.proof;return row.status==='completed'&&row.verified===true&&proof?.schemaVersion===1&&proof.verified===true&&proof.independentlyVerified===true&&proof.requestId===job.requestId&&proof.version===job.version&&proof.archiveSHA256===job.release?.archiveSHA256&&proof.role===(row.local?'panel':'worker')&&proof.nodeId===(row.local?'local':row.agentId)&&(row.local||UUID.test(row.agentId||''))&&MACHINE.test(row.observed?.machineId||'')&&SHA.test(row.observed?.installationId||'')&&proof.machineId===row.observed.machineId&&proof.installationId===row.observed.installationId&&['sourceVerified','serviceHealthy','configurationPreserved','dataIdentityPreserved','customerDefinitionsPreserved'].every(key=>proof[key]===true);};
 const result={...job,nodes:job.nodes.map(row=>({...row,verified:proofValid(row)}))};
 if(job.status==='completed'&&(job.verified!==true||result.nodes.some(row=>!row.verified)))return {...result,status:'unknown',verified:false};
 return result;
}
export function panelUpdateSettingsMarkup(icon){return `<div class="settings-row panel-update-settings" data-panel-update-settings><div><strong>${escape(text('Panel updates','Cập nhật panel'))}</strong><p data-panel-update-summary>${escape(text('Install verified stable releases across your linked VPS fleet.','Cài bản ổn định đã xác minh trên cụm VPS đã liên kết.'))}</p><span class="badge neutral" data-panel-update-version hidden></span></div><button type="button" class="btn soft" data-action="panel-update">${icon('download')}<span>${escape(text('Check for updates','Kiểm tra cập nhật'))}</span></button></div>`;}
export function panelUpdateSummary(plan){
 const count=plan.bootstrapRequiredNodeIds?.length||0;
 if(count)return text(`${count} linked VPS need a one-time worker maintenance upgrade. Open the plan for details.`,`${count} VPS liên kết cần nâng cấp worker một lần bằng bộ cài bảo trì. Mở kế hoạch để xem chi tiết.`);
 if(plan.availableReason==='fleet')return text('The main panel is current. Linked workers have updates available.','Panel chính đã mới nhất. Có bản cập nhật cho VPS liên kết.');
 if(plan.available)return text('A newer stable release is available. Review the fleet before updating.','Đã có bản ổn định mới. Kiểm tra cụm VPS trước khi cập nhật.');
 const blockers=plan.blockers||[];
 const current=plan.release?.verified===true&&plan.release.version===plan.latestVersion&&VERSION.test(plan.latestVersion||'')&&plan.currentVersion===plan.latestVersion&&plan.mainUpdateRequired!==true&&!plan.laggingNodeIds?.length&&plan.nodes?.length&&plan.nodes.every(row=>row.version===plan.latestVersion&&row.needsUpdate!==true&&(row.local||row.versionStale===false));
 // Running workloads block applying an update, not verifying an already-current fleet.
 if(current&&blockers.every(row=>row?.code==='UPDATE_SERVERS_RUNNING'))return text('The panel and observed linked VPS are current.','Panel và các VPS liên kết đã xác minh đang dùng bản mới nhất.');
 if(blockers.length||plan.release?.verified===true&&plan.latestVersion)return text('Some VPS could not be verified for updates. Review the fleet status.','Chưa xác minh được cập nhật cho một số VPS. Kiểm tra trạng thái cụm VPS.');
 return text('Release information is unavailable. Check again to see details.','Chưa lấy được thông tin phát hành. Kiểm tra lại để xem chi tiết.');
}
export async function syncPanelUpdateSettings(root,context){
 const card=root.querySelector('[data-panel-update-settings]');if(!card)return;
 try{const plan=panelUpdatePlan(await context.api(base));if(!card.isConnected||!context.isAdmin())return;const badge=card.querySelector('[data-panel-update-version]');badge.hidden=false;badge.classList.toggle('purple',plan.available);badge.classList.toggle('warn',Boolean(plan.bootstrapRequiredNodeIds?.length));uiText(badge,plan.latestVersion?`${plan.currentVersion} → ${plan.latestVersion}`:plan.currentVersion);uiText(card.querySelector('[data-panel-update-summary]'),panelUpdateSummary(plan));}
 catch{if(card.isConnected)uiText(card.querySelector('[data-panel-update-summary]'),text('Could not check for updates. Use the button to try again.','Chưa kiểm tra được cập nhật. Dùng nút bên cạnh để thử lại.'));}
}
export function panelUpdateImpact(plan){
 return plan.policy?.mainRestartRequired===false?text('Stop managed servers and finish pending jobs before applying an update. Compatible workers update first; the current main panel is verified afterward without restarting.','Dừng các server và hoàn tất tác vụ trước khi áp dụng cập nhật. VPS phụ tương thích được cập nhật trước; panel chính hiện tại được xác minh sau đó, không khởi động lại.'):text('Stop all managed servers and finish pending jobs before applying an update. Vortex will not stop workloads automatically. Workers update first; the main panel restarts last.','Dừng mọi server và hoàn tất tác vụ trước khi áp dụng cập nhật. Vortex không tự dừng server. Cập nhật VPS phụ trước, khởi động lại panel chính cuối cùng.');
}
const blockersMarkup=rows=>rows.map(row=>`<p class="notice warn">${escape(typeof row==='string'?row:message(row))}</p>`).join('');
export function panelUpdatePlanMarkup(plan){return `<section class="panel-update-review"><div class="update-release-card"><span class="eyebrow">${escape(text('OFFICIAL STABLE RELEASE','BẢN ỔN ĐỊNH CHÍNH THỨC'))}</span><h3>${escape(plan.currentVersion)} <span>→</span> ${escape(plan.latestVersion||'—')}</h3><p>${escape(text('Updates panel and agent source only. Server files, worlds, backups, accounts, ports, resource settings and installed runtime versions are preserved.','Chỉ cập nhật source panel và agent. Giữ nguyên tệp server, thế giới, bản sao lưu, tài khoản, cổng, cấu hình tài nguyên và phiên bản môi trường đã cài.'))}</p>${plan.release?.url?.startsWith('https://github.com/hovansi/vortex-panel/releases/tag/')?`<a href="${escape(plan.release.url)}" target="_blank" rel="noopener noreferrer">${escape(text('View release on GitHub','Xem bản phát hành trên GitHub'))} ↗</a>`:''}</div><p class="notice">${escape(panelUpdateImpact(plan))}</p>${blockersMarkup(plan.blockers)}<ol class="update-node-order">${plan.nodes.map((row,index)=>`<li><span class="fleet-step-number">${index+1}</span><div><strong>${escape(row.name||row.nodeId)}</strong><small>${escape(row.local?(plan.policy?.mainRestartRequired===false?text('Main panel · verify without restart','Panel chính · xác minh, không khởi động lại'):text('Main panel · last','Panel chính · cuối cùng')):text('Linked worker','VPS phụ'))}${row.version?' · '+escape(row.version):''}</small>${blockersMarkup(row.blockers||[])}</div></li>`).join('')}</ol>${plan.release?.notes?`<details class="update-release-notes"><summary>${escape(text('Release notes','Ghi chú phát hành'))}</summary><pre>${escape(plan.release.notes)}</pre></details>`:''}</section>`;}

function updateJob(root,job){
 const confirmed=job.status==='completed'&&job.verified===true;
 updateOperationProgress(root.querySelector('[data-progress-live]'),{...job,progress:confirmed?100:Math.min(99,job.progress),status:confirmed?'completed':job.status},value=>String(value));
 uiText(root.querySelector('[data-update-job-state]'),operationJobStatusLabel(job.status));
 uiText(root.querySelector('[data-update-job-message]'),message(job));
 const rows=job.nodes.map(row=>`<li><div><strong>${escape(row.name||row.nodeId)}</strong><span class="badge ${row.verified?'':'neutral'}">${escape(operationJobStatusLabel(row.status))}</span></div><p>${escape(message(row)||row.phase||'')}</p>${row.verified?`<small>${escape(text('Source, service, configuration and data identity verified','Đã xác minh source, dịch vụ, cấu hình và định danh dữ liệu'))}</small>`:''}${row.verified&&row.proof?.recoveryRetentionNeedsReview===true?`<p class="notice warn" data-update-retention-warning>${escape(text('The update is verified. Old recovery evidence was kept because cleanup needs administrator review.','Đã xác minh cập nhật. Bằng chứng phục hồi cũ được giữ lại vì cần quản trị viên kiểm tra việc dọn.'))}</p>`:''}</li>`).join(''),list=root.querySelector('[data-update-job-nodes]');if(list.dataset.signature!==rows){uiHTML(list,rows);list.dataset.signature=rows;}
 root.dataset.updateState=job.status;
 const observation=root.querySelector('[data-update-observation]');observation.hidden=true;
 const recovery=root.querySelector('[data-update-recovery]');if(recovery)recovery.hidden=job.status!=='unknown';
}
function jobMarkup(job){
 return `<section class="panel-update-job" data-panel-update-job="${escape(job.id)}">${operationProgressMarkup(job)}<div class="update-job-identity"><span class="badge neutral" data-update-job-state></span><code>${escape(job.id)}</code></div><p data-update-job-message></p><ol class="update-job-nodes" data-update-job-nodes></ol><p class="notice warn" data-update-observation hidden role="status"></p><div class="actions">${button(text('Refresh existing task','Tải lại tác vụ hiện tại'),'panel-update-status',`data-id="${escape(job.id)}"`)}</div><section data-update-recovery hidden><p class="notice warn">${escape(text('Some outcomes need fresh verification. Inspect the existing request before starting another update.','Một số kết quả cần xác minh lại. Kiểm tra yêu cầu hiện có trước khi bắt đầu cập nhật khác.'))}</p>${button(text('Verify update','Xác minh cập nhật'),'panel-update-recover',`data-id="${escape(job.id)}"`)}<details class="update-verification"><summary>${escape(text('Independent verification instructions','Hướng dẫn xác minh độc lập'))}</summary>${job.nodes.map(row=>`<strong>${escape(row.name||row.nodeId)}</strong>${row.recoveryPath?`<code>${escape(row.recoveryPath)}</code>`:''}${row.verificationCommand?`<code>${escape(row.verificationCommand)}</code>`:''}`).join('')}</details></section><p class="panel-description">${escape(text('The main panel may briefly disconnect while restarting. Status checks never resend the update. Sign in again if your session expires, then reopen this task from Settings or Notifications.','Panel chính có thể tạm mất kết nối khi khởi động lại. Kiểm tra trạng thái không gửi lại cập nhật. Đăng nhập lại nếu phiên hết hạn, rồi mở tác vụ từ Cài đặt hoặc Thông báo.'))}</p></section>`;
}
export async function showPanelUpdateJob(id,context,seed){
 if(!context.isAdmin())throw Error(text('Administrator access is required.','Cần quyền quản trị viên.'));
 let job=seed?panelUpdateJob({job:seed},id):panelUpdateJob(await context.api(jobPath(id)),id);
 if(context.isCurrent&&!context.isCurrent())return;
 if(await context.openModal(text('Panel update','Cập nhật panel'),`Vortex Panel · ${job.version||''}`,jobMarkup(job),null,'',true)===false)return;
 const root=document.querySelector('[data-panel-update-job]');if(!root||root.dataset.panelUpdateJob!==id)return;
 const current=serviceDialogContext(context,root,{selector:'[data-panel-update-job]'});updateJob(root,job);
 void(async()=>{let failures=0;for(let attempt=0;attempt<300&&current.isCurrent();attempt++){
   try{job=panelUpdateJob(await context.api(jobPath(id)),id);if(!current.isCurrent())return;failures=0;updateJob(root,job);if(accepted?.id===id)accepted.job=job;if(!active.has(job.status))return;}
   catch{if(!current.isCurrent())return;const notice=root.querySelector('[data-update-observation]');notice.hidden=false;uiText(notice,text('Waiting for the panel to reconnect. The outcome is not confirmed yet; this request will not be sent again.','Đang chờ panel kết nối lại. Kết quả chưa được xác minh; yêu cầu này sẽ không được gửi lại.'));if(++failures>=8)return;}
   await new Promise(resolve=>setTimeout(resolve,Math.min(5000,1000+attempt*300)));
 }})();
}

export async function openPanelUpdate(context){
 if(!context.isAdmin())throw Error(text('Administrator access is required.','Cần quyền quản trị viên.'));
 if(accepted?.actor===context.actorId?.()&&accepted.id){if(!accepted.job||!['completed','failed','partial','cancelled'].includes(accepted.job.status)){await showPanelUpdateJob(accepted.id,context,accepted.job);return;}accepted=null;}
 const plan=panelUpdatePlan(await context.api(`${base}?refresh=true`));if(context.isCurrent&&!context.isCurrent())return;
 const canUpdate=plan.available&&plan.status==='ready'&&!plan.blockers.length;
 let form,dialog;const actor=context.actorId?.();
 const controls=canUpdate?`<p class="panel-description">${escape(text('Linked VPS use their existing trusted connection. No VPS SSH password is needed.','VPS liên kết sử dụng kết nối đã thiết lập. Không cần mật khẩu SSH của VPS.'))}</p>${serviceField('update-admin-password','adminPassword',text('Confirm with your panel account password','Xác nhận bằng mật khẩu tài khoản panel'),{type:'password',extra:'autocomplete="current-password" maxlength="128"'})}<label class="service-ack"><input name="confirmedUpdate" type="checkbox"><span>${escape(text('Update the listed VPS, workers first and the main panel last.','Cập nhật các VPS đã liệt kê, VPS phụ trước và panel chính cuối cùng.'))}</span></label>`:'';
 const recent=plan.latestJobId?button(text('View last update task','Xem tác vụ cập nhật gần nhất'),'panel-update-status',`data-id="${escape(plan.latestJobId)}"`):'';
 const opened=await context.openModal(text('Update Vortex Panel','Cập nhật Vortex Panel'),text('Review the release and update order','Kiểm tra bản phát hành và thứ tự cập nhật'),`${panelUpdatePlanMarkup(plan)}<div class="actions">${button(text('Check again','Kiểm tra lại'),'panel-update-refresh')}${recent}</div>${controls}`,canUpdate?async(values,origin)=>{
   if(!dialog.isCurrent()||origin.dataset.committed==='true')return false;
   if(!values.adminPassword||values.confirmedUpdate!=='on')throw Error(text('Enter your panel account password and confirm the update.','Nhập mật khẩu tài khoản panel và xác nhận cập nhật.'));
   const id=crypto.randomUUID(),body={requestId:id,revision:plan.revision,version:plan.latestVersion,confirmedUpdate:true,adminPassword:values.adminPassword,connections:[]};
   origin.dataset.committed='true';origin.dataset.dirty='false';clearServiceSecrets(origin);for(const key of Object.keys(values))if(/password|privateKey|passphrase/i.test(key))delete values[key];accepted={id,actor};
   let result;
   try{result=panelUpdateJob(await context.api(base,{method:'POST',body}),id);accepted.job=result;}
   catch(error){
     if(error.status>=400&&error.status<500&&!error.outcomeUnknown){accepted=null;delete origin.dataset.committed;throw error;}
     if(dialog.isCurrent())uiHTML(origin,`<p class="notice warn">${escape(text('The response was lost. Check this exact request; do not submit another update.','Mất phản hồi. Kiểm tra đúng yêu cầu này; không gửi cập nhật khác.'))}</p><code>${escape(id)}</code>${button(text('Check existing request','Kiểm tra yêu cầu hiện tại'),'panel-update-status',`data-id="${id}"`)}`);
     return false;
   }finally{body.adminPassword='';}
   if(dialog.isCurrent())await showPanelUpdateJob(id,dialog,result);return false;
 }:null,canUpdate?text('Update fleet','Cập nhật cụm VPS'):'',true);
 if(opened===false||!canUpdate)return;
 form=document.querySelector('#modal-form');if(!form)return;dialog=serviceDialogContext(context,form);form.dataset.ephemeralSecrets='true';protectServiceSecrets(form);
}

export async function handlePanelUpdateAction(action,target,context){
 if(action==='panel-update'||action==='panel-update-refresh'){await openPanelUpdate(context);return true;}
 if(action==='panel-update-status'){await showPanelUpdateJob(target.dataset.id,context);return true;}
 if(action==='panel-update-recover'){const {openPanelUpdateRecovery}=await import('./panel-update-recovery.js');await openPanelUpdateRecovery(target.dataset.id,context);return true;}
 return false;
}
