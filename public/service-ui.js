import {wireText} from './i18n.js';
export const serviceText=(en,vi)=>wireText(en,{en,vi});
export const serviceEscape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function serviceDialogContext(context,element,{root=document,selector='#modal-form'}={}){
 const actor=context.actorId?.(),current=context.rebase?context.rebase(element):context,guard=current.isCurrent;
 return {...current,isCurrent:()=>element?.isConnected&&root.querySelector('#modal')?.open&&root.querySelector(selector)===element&&context.actorId?.()===actor&&(!guard||guard())};
}
export function clearServiceSecrets(form){
 for(const input of form?.querySelectorAll('input[type="password"],textarea[name="privateKey"]')||[])input.value='';
}
export function protectServiceSecrets(form,root=document){
 const modal=root.querySelector('#modal');if(!modal)return;
 const onClose=()=>{
  // A queued close event may belong to the previous form in this reused dialog.
  if(modal.open&&form.isConnected)return;
  clearServiceSecrets(form);modal.removeEventListener('close',onClose);
 };
 modal.addEventListener('close',onClose);
}
export const serviceField=(id,name,label,{type='text',value='',extra=''}={})=>`<div class="field"><label for="${id}">${serviceEscape(label)}</label><input id="${id}" name="${name}" type="${type}" value="${serviceEscape(value)}" ${extra}></div>`;

export function sshAddress(values){
 const host=String(values.host||'').trim(),port=Number(values.port??22);
 if(!host||/[\s/@?#<>]/.test(host)||!Number.isInteger(port)||port<1||port>65535)throw Error(serviceText('Enter a valid VPS address and SSH port.','Nhập địa chỉ VPS và cổng SSH hợp lệ.'));
 return {host,port};
}
export function sshFields(values){
 const address=sshAddress(values),username=String(values.username??'root').trim();if(!username||/\s/.test(username))throw Error(serviceText('Enter a valid SSH username.','Nhập tên đăng nhập SSH hợp lệ.'));
 const result={...address,username};
 if(values.authMode==='key'){const key=String(values.privateKey||'').trim();if(!key)throw Error(serviceText('Paste the SSH private key.','Dán khóa riêng SSH.'));result.privateKey=key;const passphrase=String(values.passphrase||'');if(passphrase)result.passphrase=passphrase;}
 else{const password=String(values.password||'');if(!password)throw Error(serviceText('Enter the SSH password.','Nhập mật khẩu SSH.'));result.password=password;}
 return result;
}
