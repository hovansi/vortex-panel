import {wireText,uiHTML,uiText} from './i18n.js';
import {WORLD_VOICE_COPY,WORLD_VOICE_TEMPLATES,buildWorldVoice,getWorldVoiceTemplate,worldVoiceErrorText} from './world-voice.js';

export const voiceText=(en,vi)=>wireText(en,{en,vi});
const copy=pair=>wireText(pair.en,pair);
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const errorText=error=>voiceText(worldVoiceErrorText(error,'en'),worldVoiceErrorText(error,'vi'));
const $=(selector,root=document)=>root.querySelector(selector);

// A preview is local. Only the explicit submit performs a console write.
// Server configuration owns the message language; changing the UI cannot change it.
export async function openWorldVoiceDialog(serverId,{api,findServer,canManage,openModal,toast,refreshLogs,icon,isCurrent=()=>true}){
  const path=`/servers/${encodeURIComponent(serverId)}`;
  let configuration=await api(`${path}/configuration`),server=configuration.server;if(!isCurrent())return;
  const assertAvailable=current=>{
    if(!current||!canManage(current))throw new Error(voiceText('You need permission to manage this server.','Bạn cần quyền quản lý máy chủ này.'));
    if(current.status!=='running'||current.busy||current.recoveryRequired)throw new Error(voiceText('Start the server and wait for its current operation to finish before sending.','Khởi động máy chủ và chờ tác vụ hiện tại hoàn tất trước khi gửi.'));
  };
  assertAvailable(server);
  let language=server.messageLanguage==='vi'?'vi':'en',templateId='welcome',method='say',preview;
  const drafts=new Map(WORLD_VOICE_TEMPLATES.map(template=>[template.id,Object.fromEntries(template.fields.map(field=>[field.key,field.defaultValue]))]));
  drafts.get('welcome').worldName=configuration.properties?.['level-name']||server.name;
  const languageLabel=()=>language==='vi'?'VI · Tiếng Việt':'EN · English';
  const fieldMarkup=field=>{
    const value=drafts.get(templateId)[field.key],id=`world-voice-${field.key}`,common=`id="${id}" name="${field.key}" ${field.required?'required':''}`;
    let input;
    if(field.type==='select')input=`<select ${common}>${field.options.map(option=>`<option value="${escape(option.value)}" ${value===option.value?'selected':''}>${escape(copy(option.label))}</option>`).join('')}</select>`;
    else if(field.type==='textarea')input=`<textarea ${common} rows="4" maxlength="${field.maxLength}">${escape(value)}</textarea>`;
    else input=`<input ${common} type="${field.type}" value="${escape(value)}" ${field.type==='number'?`min="${field.min}" max="${field.max}" step="${field.step}"`:`maxlength="${field.maxLength}"`} autocomplete="off">`;
    return `<div class="field ${field.type==='textarea'?'wide':''}"><label for="${id}">${escape(copy(field.label))}</label>${input}</div>`;
  };
  const body=`<section class="world-voice-composer"><div class="world-voice-language"><span>${icon('globe')}${escape(voiceText('Server message language','Ngôn ngữ thông báo server'))}</span><strong id="world-voice-language">${escape(languageLabel())}</strong></div><p class="panel-description">${escape(voiceText('Change this language in server configuration. Automatic welcomes and operation notices use the same setting.','Đổi ngôn ngữ trong cấu hình máy chủ. Lời chào tự động và thông báo vận hành dùng cùng thiết lập.'))}</p><div class="world-voice-templates" role="group" aria-label="${escape(voiceText('Announcement templates','Mẫu thông báo'))}">${WORLD_VOICE_TEMPLATES.map(template=>`<button type="button" data-voice-template="${template.id}" aria-pressed="${template.id===templateId}">${icon({welcome:'spark',restart:'refresh',backup:'backup',restore:'backup',maintenance:'sliders',custom:'terminal'}[template.id])}<span>${escape(copy(template.label))}</span></button>`).join('')}</div><p id="world-voice-description" class="panel-description"></p><div id="world-voice-fields" class="form-grid"></div><div class="field spacer"><label for="world-voice-method">${escape(voiceText('Delivery style','Kiểu gửi'))}</label><select id="world-voice-method" name="voiceMethod"><option value="say">${escape(voiceText('Server message','Thông báo server'))}</option><option value="tellraw">${escape(voiceText('Literal text','Văn bản nguyên nghĩa'))}</option></select></div><label id="world-voice-confirm-complete" class="check-row spacer" hidden><input type="checkbox" name="confirmComplete" disabled>${escape(voiceText('I have verified that this operation finished successfully.','Tôi đã kiểm tra thao tác này hoàn tất thành công.'))}</label><section class="world-voice-preview"><div class="world-voice-preview-head"><strong>${escape(copy(WORLD_VOICE_COPY.preview))}</strong><span id="world-voice-preview-language">${escape(languageLabel())}</span></div><div id="world-voice-preview-text" class="world-voice-message" aria-live="polite"></div><p id="world-voice-preview-error" class="form-error" role="status"></p></section><p class="world-voice-policy">${escape(copy(WORLD_VOICE_COPY.textPolicy))}</p><div id="world-voice-normalized" class="notice" hidden></div><div class="notice spacer">${icon('shield')}<span>${escape(copy(WORLD_VOICE_COPY.effect))}</span></div><p class="panel-description spacer">${escape(voiceText('The preview approximates Minecraft colors. A console acknowledgement does not confirm that a player received it.','Xem trước mô phỏng màu Minecraft. Console chấp nhận không có nghĩa người chơi đã nhận được thông báo.'))}</p></section>`;
  const updateLanguage=()=>{
    uiText($('#world-voice-language'),languageLabel());uiText($('#world-voice-preview-language'),languageLabel());
  };
  const remember=form=>{
    const draft=drafts.get(templateId);
    for(const field of getWorldVoiceTemplate(templateId).fields){const input=form.elements.namedItem(field.key);if(input)draft[field.key]=input.value;}
    method=form.elements.voiceMethod?.value||method;
  };
  const renderPreview=form=>{
    remember(form);
    const complete=drafts.get(templateId).phase==='complete',confirmation=$('#world-voice-confirm-complete',form),checkbox=form.elements.confirmComplete;
    confirmation.hidden=!complete;checkbox.disabled=!complete;checkbox.required=complete;
    const warning=$('#world-voice-normalized',form);
    try{
      preview=buildWorldVoice({templateId,values:drafts.get(templateId),language,method});
      // Minecraft content stays outside the UI translation slots and HTML parser.
      const fragment=document.createDocumentFragment();
      if(method==='say'){const prefix=document.createElement('span');prefix.className='world-voice-native-prefix';prefix.textContent='[Server] ';fragment.append(prefix);}
      for(const segment of preview.segments){const span=document.createElement('span');span.textContent=segment.text;span.style.color=segment.color;span.style.fontWeight=segment.bold?'700':'400';span.style.fontStyle=segment.italic?'italic':'normal';fragment.append(span);}
      $('#world-voice-preview-text',form).replaceChildren(fragment);
      uiText($('#world-voice-preview-error',form),'');warning.hidden=!preview.changedFields.length;
      if(preview.changedFields.length)uiText(warning,voiceText('The preview shows cleaned text. Only this displayed text will be sent.','Xem trước hiển thị nội dung đã làm sạch. Chỉ nội dung hiển thị này được gửi.'));
    }catch(error){preview=null;uiText($('#world-voice-preview-text',form),'');uiText($('#world-voice-preview-error',form),errorText(error));warning.hidden=true;}
  };
  const renderFields=form=>{
    const template=getWorldVoiceTemplate(templateId);uiText($('#world-voice-description',form),copy(template.description));uiHTML($('#world-voice-fields',form),template.fields.map(fieldMarkup).join(''));
    form.elements.confirmComplete.checked=false;
    for(const button of form.querySelectorAll('[data-voice-template]'))button.setAttribute('aria-pressed',String(button.dataset.voiceTemplate===templateId));
    renderPreview(form);
  };
  const refreshLanguage=async form=>{
    configuration=await api(`${path}/configuration`);server=configuration.server;language=server.messageLanguage==='vi'?'vi':'en';updateLanguage();renderPreview(form);
  };
  const opened=await openModal(copy(WORLD_VOICE_COPY.title),server.name,body,async(data,form)=>{
    remember(form);
    const submittedDraft=JSON.stringify(drafts.get(templateId)),submittedTemplate=templateId,submittedMethod=method;
    let message;try{message=buildWorldVoice({templateId,values:drafts.get(templateId),language,method});}catch(error){throw new Error(errorText(error));}
    if(message.normalizedValues.phase==='complete'&&data.confirmComplete!=='on')throw new Error(voiceText('Verify the successful result before announcing completion.','Xác nhận kết quả thành công trước khi thông báo hoàn tất.'));
    const fresh=await api(`${path}/configuration`);assertAvailable(fresh.server);
    if((fresh.server.messageLanguage==='vi'?'vi':'en')!==language){await refreshLanguage(form);throw new Error(voiceText('The server message language changed. Review the updated preview before sending again.','Ngôn ngữ thông báo server đã đổi. Kiểm tra lại xem trước rồi gửi lại.'));}
    try{
      const result=await api(`${path}/announcement`,{method:'POST',body:{templateId:message.templateId,values:message.normalizedValues,method:message.method,expectedLanguage:message.language}});
      if(!result.acceptedToConsole&&!result.simulated)throw new Error(voiceText('The console did not accept this announcement.','Console chưa chấp nhận thông báo này.'));
      toast(result.simulated?voiceText('Demo announcement simulated.','Thông báo demo được mô phỏng.'):voiceText('Announcement sent to the server console.','Đã gửi thông báo vào console máy chủ.'));
      if(result.warnings?.length)toast(result.warnings.map((warning,index)=>wireText(warning,result.warningsI18n?.[index])).join(' · '),true);
      // Log refresh is optional after a successful write: never turn a successful send into a retry.
      if(findServer()?.id===serverId)try{await refreshLogs();}catch{toast(voiceText('The announcement was accepted; the log could not be refreshed.','Thông báo đã được chấp nhận; chưa làm mới được log.'),true);}
      remember(form);const newerDraft=templateId!==submittedTemplate||method!==submittedMethod||JSON.stringify(drafts.get(submittedTemplate))!==submittedDraft;
      form.dataset.dirty=String(newerDraft);
      if(newerDraft){uiText($('#modal-error',form),voiceText('Your submitted announcement was accepted. Newer edits are still here and have not been sent.','Thông báo vừa gửi đã được chấp nhận. Các chỉnh sửa mới hơn vẫn được giữ và chưa gửi.'));return false;}
    }catch(error){if(error.status===409){try{await refreshLanguage(form);}catch{}}throw error;}
  },voiceText('Send announcement','Gửi thông báo'),true);
  if(opened===false)return;
  const form=$('#modal-form');renderFields(form);
  form.addEventListener('input',event=>{if(event.target.closest('.world-voice-composer'))renderPreview(form);});
  form.addEventListener('change',event=>{if(event.target.closest('.world-voice-composer'))renderPreview(form);});
  form.addEventListener('click',event=>{const button=event.target.closest('[data-voice-template]');if(!button||form.dataset.submitting)return;remember(form);templateId=button.dataset.voiceTemplate;form.dataset.dirty='true';renderFields(form);});
}
