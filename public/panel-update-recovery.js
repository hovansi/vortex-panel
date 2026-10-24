import {uiText,uiHTML} from './i18n.js';
import {serviceText as text,serviceEscape as escape,serviceField,serviceDialogContext,protectServiceSecrets,sshFields} from './service-ui.js';
import {fleetSSHMarkup,readFleetSSH,clearFleetSecrets} from './panel-uninstall.js';
import {panelUpdateJob,showPanelUpdateJob} from './panel-update.js';
import {syncSelects} from './select-control.js';

const PIN=/^SHA256:[A-Za-z0-9+/]{43}$/;
const clear=value=>{if(value)for(const key of Object.keys(value))if(/password|privateKey|passphrase/i.test(key))delete value[key];};

export async function openPanelUpdateRecovery(id,context){
 if(!context.isAdmin())throw Error(text('Administrator access is required.','Cần quyền quản trị viên.'));
 const job=panelUpdateJob(await context.api(`/host/update/jobs/${encodeURIComponent(id)}`),id);
 if(context.isCurrent&&!context.isCurrent())return;
 if(job.status!=='unknown'){await showPanelUpdateJob(id,context,job);return;}
 const legacyNodes=job.nodes.filter(row=>!row.local&&row.updateTransport!=='agent');
 if(legacyNodes.some(row=>!row.sshTarget||!PIN.test(row.sshTarget.hostFingerprint||'')||typeof row.sshTarget.host!=='string'||!Number.isInteger(row.sshTarget.port)||row.sshTarget.port<1||row.sshTarget.port>65535))throw Error(text('The original pinned SSH targets are missing for this older update. Keep the task and inspect its verification instructions; do not launch another update.','Thiếu đích SSH đã ghim của tác vụ cập nhật cũ. Giữ tác vụ và kiểm tra hướng dẫn xác minh; không chạy cập nhật khác.'));
 let dialog,form;
 const nodes=legacyNodes.map(row=>({...row,sshHost:row.sshTarget.host,sshPort:row.sshTarget.port}));
 const legacyNotice=nodes.length?`<p class="notice warn">${escape(text('This task began with an older worker. Only those VPS need their original SSH connection for this verification.','Tác vụ này bắt đầu với worker phiên bản cũ. Chỉ các VPS đó cần kết nối SSH ban đầu để xác minh lần này.'))}</p>`:'';
 const opened=await context.openModal(text('Verify an interrupted update','Xác minh cập nhật bị gián đoạn'),`${job.version} · ${id}`,`<section class="panel-update-recovery"><p class="notice">${escape(text('Check the existing update without downloading, activating or starting it again. Confirmed staging that was never activated can be cancelled after verification.','Kiểm tra tác vụ cập nhật hiện có, không tải hay chạy lại. Phần chuẩn bị đã xác nhận chưa kích hoạt có thể được hủy sau khi xác minh.'))}</p>${legacyNotice}${nodes.map(fleetSSHMarkup).join('')}${serviceField('update-recover-password','adminPassword',text('Confirm with your panel account password','Xác nhận bằng mật khẩu tài khoản panel'),{type:'password',extra:'autocomplete="current-password" maxlength="128"'})}<label class="service-ack"><input name="cancelPrepared" type="checkbox"><span>${escape(text('Verify this exact request and cancel any confirmed unactivated staging. Keep all customer data.','Xác minh đúng yêu cầu này và hủy phần chuẩn bị đã xác nhận chưa kích hoạt. Giữ toàn bộ dữ liệu người dùng.'))}</span></label></section>`,async(values,origin)=>{
   if(!dialog.isCurrent()||origin.dataset.committed==='true')return false;
   if(!values.adminPassword||values.cancelPrepared!=='on')throw Error(text('Enter your panel account password and confirm inspection of this existing request.','Nhập mật khẩu tài khoản panel và xác nhận kiểm tra yêu cầu hiện có.'));
   const cards=[...origin.querySelectorAll('[data-fleet-ssh]')];
   if(cards.some(card=>!card.querySelector('[data-fleet-trust]').checked))throw Error(text('Confirm every original pinned SSH host key.','Xác nhận khóa host SSH đã ghim ban đầu của mọi VPS.'));
   const connections=nodes.map(row=>{const card=cards.find(card=>card.dataset.fleetSsh===row.nodeId);return {nodeId:row.nodeId,ssh:{...sshFields(readFleetSSH(card)),host:row.sshTarget.host,port:row.sshTarget.port,hostFingerprint:row.sshTarget.hostFingerprint}};}),body={requestId:id,cancelPrepared:true,adminPassword:values.adminPassword,connections};
   origin.dataset.committed='true';origin.dataset.dirty='false';clearFleetSecrets(origin);clear(values);
   try{
     const response=panelUpdateJob(await context.api('/host/update/recover',{method:'POST',body}),id);
     if(dialog.isCurrent())await showPanelUpdateJob(id,dialog,response);
   }catch(error){
     if(error.status>=400&&error.status<500&&!error.outcomeUnknown){delete origin.dataset.committed;throw error;}
     if(dialog.isCurrent())uiHTML(origin,`<p class="notice warn">${escape(text('The verification response was lost. Keep this existing request and refresh its status; no update was replayed.','Mất phản hồi xác minh. Giữ yêu cầu hiện có và tải lại trạng thái; cập nhật không được gửi lại.'))}</p><code>${escape(id)}</code><button type="button" class="btn soft" data-action="panel-update-status" data-id="${escape(id)}">${escape(text('Refresh existing request','Tải lại yêu cầu hiện có'))}</button>`);
   }finally{clear(body);for(const row of connections)clear(row.ssh);}
   return false;
 },text('Verify existing update','Xác minh cập nhật hiện có'),true);
 if(opened===false)return;form=document.querySelector('#modal-form');if(!form)return;dialog=serviceDialogContext(context,form);form.dataset.ephemeralSecrets='true';protectServiceSecrets(form);
 for(const card of form.querySelectorAll('[data-fleet-ssh]')){
   const node=nodes.find(row=>row.nodeId===card.dataset.fleetSsh);
   for(const key of ['host','port','username']){const input=card.querySelector(`[data-ssh-name="${key}"]`);input.readOnly=true;}
   card.querySelector('[data-fleet-host-key]').hidden=false;uiText(card.querySelector('[data-fleet-fingerprint]'),node.sshTarget.hostFingerprint);
   card.querySelector('[data-fleet-ssh-check]').hidden=true;card.querySelector('[data-fleet-ssh-edit]').hidden=true;
   uiText(card.querySelector('[data-fleet-ssh-state]'),text('Original pinned target','Đích đã ghim ban đầu'));
   uiText(card.querySelector('[data-fleet-ssh-feedback]'),text('Fresh root authentication and independent outcome checks run when you submit this recovery.','Xác thực root mới và kiểm tra kết quả độc lập được thực hiện khi gửi yêu cầu xác minh này.'));
 }
 form.addEventListener('change',event=>{const card=event.target.closest('[data-fleet-ssh]');if(!card)return;const key=card.querySelector('[data-ssh-name=authMode]').value==='key';card.querySelector('[data-fleet-auth-key]').hidden=!key;card.querySelector('[data-fleet-auth-password]').hidden=key;});
 syncSelects(form);
}
