import {wireText,uiText} from './i18n.js';

const text=(en,vi)=>wireText(en,{en,vi});
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

const automaticHint=(application,capability)=>!application&&capability?.preferredRaknetPort===19132?text('For RakNet: UDP 19132 (IPv4) and 19133 (IPv6) when both are free; otherwise, random available ports.','Với RakNet: ưu tiên UDP 19132 (IPv4) và 19133 (IPv6) khi cả hai còn trống; nếu không, cấp cổng trống ngẫu nhiên.') : text('The selected VPS assigns and reserves random available ports when you create this server. Your assigned connection address appears after the request is accepted.','VPS đã chọn cấp và giữ các cổng trống ngẫu nhiên khi tạo máy chủ. Địa chỉ kết nối được hiển thị sau khi yêu cầu được chấp nhận.');

export function portAllocationFields({id='create-port-allocation'}={}){
 return `<div data-port-allocation><div class="field"><label for="${escape(id)}">${escape(text('Port allocation','Cấp phát cổng'))}</label><select id="${escape(id)}" name="portAllocation"><option value="auto" selected>${escape(text('Automatic · available ports','Tự động · cổng trống'))}</option><option value="manual">${escape(text('Custom ports · advanced','Cổng tùy chỉnh · nâng cao'))}</option></select></div><div class="notice spacer" data-port-allocation-auto role="status">${escape(automaticHint(false))}</div><div class="form-grid spacer" data-port-allocation-manual hidden><div class="field"><label for="${escape(id)}-port" data-port-allocation-label>${escape(text('Primary port','Cổng chính'))}</label><input id="${escape(id)}-port" name="port" type="number" min="1024" max="65535" step="1" inputmode="numeric" autocomplete="off" disabled></div><div class="field" data-port-allocation-v6><label for="${escape(id)}-v6">${escape(text('IPv6 port · RakNet','Cổng IPv6 · RakNet'))}</label><input id="${escape(id)}-v6" name="portV6" type="number" min="1024" max="65535" step="1" inputmode="numeric" autocomplete="off" disabled></div><p class="panel-description wide">${escape(text('Custom ports are checked for reservation conflicts on this VPS. An external service may still prevent startup.','Cổng tùy chỉnh được kiểm tra xung đột đặt chỗ trên VPS này. Dịch vụ bên ngoài vẫn có thể khiến máy chủ không khởi động được.'))}</p></div><p data-port-allocation-feedback class="node-create-feedback" role="status" hidden></p></div>`;
}

export function portAllocationFromValues(values,{application=false}={}){
 const mode=values.portAllocation||'auto';
 if(mode==='auto')return{portAllocation:'auto'};
 if(mode!=='manual')throw Error(text('Choose automatic or custom port allocation.','Chọn cấp phát cổng tự động hoặc tùy chỉnh.'));
 const port=Number(values.port),portV6=Number(values.portV6),valid=value=>Number.isInteger(value)&&value>=1024&&value<=65535;
 if(!valid(port)||!application&&!valid(portV6))throw Error(text('Enter whole port numbers between 1024 and 65535.','Nhập số cổng nguyên từ 1024 đến 65535.'));
 return application?{portAllocation:'manual',port}:{portAllocation:'manual',port,portV6};
}

export function portAllocationState(node,{mode='auto'}={}){
 const capability=node?.portAllocation;
 const supported=capability?.supported===true&&capability.schemaVersion===1&&capability.mode==='auto'&&capability.authority==='node';
 return{allowed:mode==='manual'||supported,reason:mode==='manual'||supported?'':text('Update this node to use automatic ports, or choose custom ports.','Cập nhật node này để cấp cổng tự động, hoặc chọn cổng tùy chỉnh.')};
}

export function syncPortAllocation(form,{application=false,disabled=false,node}={}){
 const mode=form.elements.portAllocation;
 if(!mode)return;
 const manual=mode.value==='manual';
 mode.disabled=disabled;
 const automatic=form.querySelector('[data-port-allocation-auto]');automatic.hidden=manual;uiText(automatic,automaticHint(application,node?.portAllocation));
 form.querySelector('[data-port-allocation-manual]').hidden=!manual;
 form.querySelector('[data-port-allocation-v6]').hidden=application;
 uiText(form.querySelector('[data-port-allocation-label]'),application?text('Application TCP port','Cổng TCP ứng dụng'):text('Primary port','Cổng chính'));
 for(const name of ['port','portV6']){const input=form.elements[name];input.disabled=disabled||!manual||application&&name==='portV6';input.required=!input.disabled;}
 const availability=portAllocationState(node,{mode:mode.value}),feedback=form.querySelector('[data-port-allocation-feedback]');
 if(feedback){feedback.hidden=availability.allowed||disabled;uiText(feedback,availability.reason);}
 return availability;
}
