import {wireText,uiHTML,uiText} from './i18n.js';
import {beginButtonBusy} from './button-busy.js';
import {applicationProjectMarkup,bindApplicationProject} from './application-project.js';

const text=(en,vi)=>wireText(en,{en,vi});
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const bindings=new WeakMap();
const environmentName=/^[A-Z_][A-Z0-9_]{0,63}$/;
const reservedEnvironment=new Set(['PORT','PATH','HOME','USER','LOGNAME','SHELL','PWD','TMPDIR','TEMP','TMP','ENV','BASH_ENV','IFS','CDPATH','SHELLOPTS','GLOBIGNORE','NODE_OPTIONS','NODE_PATH','PYTHONHOME','PYTHONPATH','PYTHONSTARTUP','PYTHONUSERBASE','PYTHONINSPECT','PYTHONBREAKPOINT']);
const reservedEnvironmentPrefix=/^(?:VORTEX_|BEDROCK_|LD_|DYLD_)/;
const controls=/[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
let sequence=0;

export function applicationKind(server){return typeof server==='string'?server:server?.kind||'bedrock';}
export function isApplication(server){return ['nodejs','python'].includes(applicationKind(server));}
export function applicationName(server){const kind=applicationKind(server);return kind==='nodejs'?'Node.js':kind==='python'?'Python':kind==='bedrock'?'Minecraft Bedrock':text('Unknown runtime','Môi trường chạy không xác định');}
export function applicationVersionLabel(server,version=server?.version){const value=typeof version==='string'?version.trim():'';return applicationKind(server)==='python'?value.replace(/^Python\s+(?=\d)/i,''):value;}
export function applicationTabs(server){return isApplication(server)?['console','files','settings','backups','activity']:['console','worlds','gameplay','files','settings','players','packs','backups','activity'];}
export function applicationDefaults(kind){return{entrypoint:kind==='python'?'app.py':'server.js',args:[],environment:[],dependencies:'none',readiness:'tcp'};}
export function applicationRuntimeState(capabilities,kind,{creating=false,server,runtimeAvailability}={}){
 const runtime=Array.isArray(capabilities?.runtimes)?capabilities.runtimes.find(row=>row.kind===applicationKind(kind)):null,available=capabilities?.supported===true&&runtime?.available===true;
 const needsUpgrade=creating&&capabilities?.managed!==true,pinned=!creating&&server?.runtime?.mode==='managed',selectedMatches=pinned&&runtimeAvailability?.mode==='managed'&&runtimeAvailability.kind===applicationKind(kind)&&runtimeAvailability.version===server.runtime.version;
 const actual=pinned?capabilities?.supported===true&&selectedMatches&&runtimeAvailability.available===true:available;
 const catalog=runtime?.catalog,verified=catalog?.status==='verified'&&typeof runtime?.latest?.version==='string',publisherUnavailable=creating&&!needsUpgrade&&runtime?.managedAvailable===true&&!verified;
 return{available:creating?capabilities?.supported===true&&capabilities?.managed===true&&runtime?.managedAvailable===true&&verified:actual,runtime:runtime||null,managed:capabilities?.managed===true,creating,engine:capabilities?.engine||null,reason:needsUpgrade?text('Update this node to create applications with an official pinned runtime.','Cập nhật VPS này để tạo ứng dụng với môi trường chính thức được ghim.'):publisherUnavailable?catalog?.reason||text('The latest official stable runtime is not verified. Refresh the runtime catalog to try again.','Chưa xác minh môi trường ổn định chính thức mới nhất. Làm mới danh mục để thử lại.'):pinned?!selectedMatches?text('Refresh this workspace to verify its exact pinned runtime.','Làm mới workspace để xác minh chính xác môi trường đã ghim.'):runtimeAvailability.reason:runtime?.reason||capabilities?.reason,reasonI18n:needsUpgrade||pinned&&!selectedMatches?null:publisherUnavailable?catalog?.reasonI18n:pinned?runtimeAvailability.reasonI18n:runtime?.reasonI18n||capabilities?.reasonI18n};
}
export function validateApplicationResponse(data,serverId,kind){
 if(data?.server?.id!==serverId||applicationKind(data.server)!==applicationKind(kind)||!data.application||typeof data.revision!=='string'||!data.revision)fail('The application response changed. Reload this workspace before continuing.','Phản hồi ứng dụng đã thay đổi. Tải lại workspace trước khi tiếp tục.');
 return data;
}

function fail(en,vi){throw new Error(text(en,vi));}
function parsed(value,label){
 if(Array.isArray(value))return value;
 try{const result=JSON.parse(value||'[]');if(Array.isArray(result))return result;}catch{}
 fail(`${label} must be a list.`,`${label} phải là danh sách.`);
}
// This is a user-friendly first check. The server validates the path again inside
// the application's owned directory, including symlinks and file ownership.
export function applicationFromValues(values,{kind='nodejs',previous}={}){
 if(!isApplication(kind))fail('Choose Node.js or Python.','Chọn Node.js hoặc Python.');
 const mode=values.appStartupMode??values.startup?.mode??previous?.startup?.mode??'entrypoint';
 const entrypoint=String(mode==='entrypoint'?values.appEntrypoint??values.entrypoint??applicationDefaults(kind).entrypoint:previous?.entrypoint??applicationDefaults(kind).entrypoint).trim();
 if(!entrypoint||entrypoint.length>240||!/^[A-Za-z0-9_./-]+$/.test(entrypoint)||entrypoint.startsWith('/')||entrypoint.split('/').some(part=>!part||part.length>80||part.startsWith('.'))||entrypoint.split('/')[0]==='node_modules'||!(kind==='python'?/\.py$/:/\.(?:js|mjs|cjs)$/).test(entrypoint))fail('Choose an entry file inside this application, such as src/server.js or app.py.','Chọn tệp đầu vào bên trong ứng dụng, ví dụ src/server.js hoặc app.py.');
 const args=parsed(values.appArgs??values.args,'Arguments');
 if(args.length>32||args.some(value=>typeof value!=='string'||!value.isWellFormed()||value.length>1024||controls.test(value)))fail('Use up to 32 arguments, each no longer than 1,024 characters and on one line.','Dùng tối đa 32 tham số, mỗi tham số không quá 1.024 ký tự và nằm trên một dòng.');
 const rows=parsed(values.appEnvironment??values.environment,'Environment variables'),environment=[],seen=new Set(),original=new Map((previous?.environment||[]).map(row=>[row.name,row]));
 let environmentBytes=0;if(rows.length>64)fail('Use up to 64 environment variables.','Dùng tối đa 64 biến môi trường.');
 for(const row of rows){
  if(!row||typeof row!=='object'||Array.isArray(row))fail('Check each environment variable.','Kiểm tra từng biến môi trường.');
  const name=typeof row.name==='string'?row.name.trim():'',secret=row.secret===true;
  if(!environmentName.test(name))fail('Use up to 64 uppercase letters, digits or underscores for each variable name. Start with a letter or underscore.','Tên biến dài tối đa 64 ký tự chữ in hoa, số hoặc dấu gạch dưới; bắt đầu bằng chữ hoặc dấu gạch dưới.');
  if(seen.has(name))fail(`The variable ${name} is listed more than once.`,`Biến ${name} đang bị lặp.`);
  if(reservedEnvironment.has(name)||reservedEnvironmentPrefix.test(name))fail(`${name} is managed by Vortex. Choose another variable name.`,`${name} do Vortex quản lý. Chọn tên biến khác.`);
  seen.add(name);
  if(row.value===null||row.value===undefined){
   const saved=original.get(name);
   if(!secret||saved?.secret!==true||saved.hasValue!==true||row.originalName&&row.originalName!==name)fail('Enter a new value when renaming a stored secret or changing its visibility.','Nhập giá trị mới khi đổi tên biến bí mật hoặc đổi chế độ hiển thị.');
   environment.push({name,secret:true});
  }else{
   if(typeof row.value!=='string'||!row.value.isWellFormed()||row.value.length>4096||controls.test(row.value))fail('Environment values must be one-line text no longer than 4,096 characters.','Giá trị biến phải là văn bản một dòng không quá 4.096 ký tự.');
   environmentBytes+=new TextEncoder().encode(name+row.value).length;
   if(environmentBytes>32768)fail('Environment variables exceed the 32 KiB limit.','Các biến môi trường vượt giới hạn 32 KiB.');
   environment.push({name,value:row.value,secret});
  }
 }
 const dependencies=values.appDependencies??values.dependencies??'none';
 if(!['none','auto'].includes(dependencies))fail('Choose a supported dependency policy.','Chọn chính sách thư viện được hỗ trợ.');
 const readiness=values.appReadiness??values.readiness??'tcp';if(!['tcp','process'].includes(readiness))fail('Choose TCP readiness or process readiness.','Chọn kiểm tra cổng TCP hoặc tiến trình.');
 let startup;
 if(mode==='npm-script'&&kind==='nodejs'){const script=values.appStartupScript??values.startup?.script??previous?.startup?.script;if(typeof script!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(script))fail('Choose a package.json script name of up to 80 letters, digits, colons, hyphens or underscores.','Chọn tên script trong package.json dài tối đa 80 ký tự chữ, số, dấu hai chấm, gạch ngang hoặc gạch dưới.');startup={mode,script};}
 else if(mode==='python-module'&&kind==='python'){const module=values.appStartupModule??values.startup?.module??previous?.startup?.module;if(typeof module!=='string'||module.length>200||!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(module))fail('Enter an importable Python module, such as uvicorn or my_project.worker.','Nhập module Python có thể import, ví dụ uvicorn hoặc my_project.worker.');startup={mode,module};}
 else if(mode!=='entrypoint')fail('Choose a startup mode supported by this runtime.','Chọn chế độ khởi chạy được môi trường này hỗ trợ.');
 return{entrypoint,args:[...args],environment,dependencies,readiness,...(startup?{startup}:{})};
}
export function readApplicationForm(form,options={}){
 const root=form?.matches?.('[data-application-editor]')?form:form?.querySelector?.('[data-application-editor]');
 const binding=root&&bindings.get(root);if(binding)binding.serialize();
 const value=name=>root?.querySelector(`[name="${name}"]`)?.value??form?.elements?.namedItem(name)?.value;
 return applicationFromValues({appEntrypoint:value('appEntrypoint'),appArgs:value('appArgs'),appEnvironment:value('appEnvironment'),appDependencies:value('appDependencies'),appReadiness:value('appReadiness'),appStartupMode:value('appStartupMode'),appStartupScript:value('appStartupScript'),appStartupModule:value('appStartupModule')},{kind:root?.dataset.applicationKind||options.kind,...options});
}
function argumentRow(value,disabled=false){return`<div class="application-argument" data-app-argument><span class="application-row-grip" aria-hidden="true">›</span><input type="text" data-app-argument-value value="${escape(value)}" maxlength="1024" autocomplete="off" spellcheck="false" aria-label="${escape(text('One command-line argument','Một tham số dòng lệnh'))}" ${disabled?'disabled':''}><button type="button" class="icon-button" data-app-remove="argument" aria-label="${escape(text('Remove argument','Xóa tham số'))}" ${disabled?'disabled':''}>×</button></div>`;}
function environmentRow(row={},disabled=false){
 const saved=row.secret===true&&row.hasValue===true,value=saved?'':row.value??'';
 return`<div class="application-variable" data-app-variable data-original-name="${escape(row.name||'')}" data-app-retained="${saved}" data-app-replaced="false"><div class="application-variable-fields"><div class="field"><label>${escape(text('Name','Tên biến'))}<input type="text" data-app-env-name value="${escape(row.name||'')}" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="API_KEY" ${disabled?'disabled':''}></label></div><div class="field"><label>${escape(text('Value','Giá trị'))}<input type="${row.secret?'password':'text'}" data-app-env-value value="${escape(value)}" maxlength="4096" autocomplete="new-password" spellcheck="false" ${saved?`placeholder="${escape(text('Stored securely · unchanged','Đã lưu bảo mật · giữ nguyên'))}"`:''} ${disabled?'disabled':''}></label></div></div><div class="application-variable-controls"><label class="check-row"><input type="checkbox" data-app-env-secret ${row.secret?'checked':''} ${disabled?'disabled':''}><span>${escape(text('Secret','Bí mật'))}</span></label><button type="button" class="btn text" data-app-clear-secret ${!saved?'hidden':''} ${disabled?'disabled':''}>${escape(text('Clear value','Xóa giá trị'))}</button><button type="button" class="icon-button" data-app-remove="variable" aria-label="${escape(text('Remove variable','Xóa biến'))}" ${disabled?'disabled':''}>×</button></div></div>`;
}
export function applicationStartupModeSupported(runtime,mode='entrypoint'){return(Array.isArray(runtime?.startupModes)?runtime.startupModes:['entrypoint']).includes(mode);}
function startupModeMarkup(id,selected,configured=['entrypoint'],disabled=false){
 const labels={entrypoint:text('Entry file','Tệp đầu vào'),'npm-script':text('package.json script','Script package.json'),'python-module':text('Python module · -m','Module Python · -m')},allowed=new Set(configured),modes=[...new Set(['entrypoint',...configured,selected])].filter(mode=>Object.hasOwn(labels,mode));
 return`<div data-app-startup-mode-slot>${modes.length>1?`<div class="field application-startup-mode"><label for="${id}-startup-mode">${escape(text('Startup mode','Chế độ khởi chạy'))}</label><select id="${id}-startup-mode" name="appStartupMode" ${disabled?'disabled':''}>${modes.map(mode=>`<option value="${mode}" ${mode===selected?'selected':''} ${allowed.has(mode)?'':'disabled'}>${escape(labels[mode])}${allowed.has(mode)?'':` · ${escape(text('Unavailable on this VPS','Chưa hỗ trợ trên VPS này'))}`}</option>`).join('')}</select><small>${escape(text('Launch directly, through a declared package script, or as a Python module when supported by this VPS.','Khởi chạy trực tiếp, qua script khai báo trong gói hoặc qua module Python khi VPS hỗ trợ.'))}</small></div>`:`<input type="hidden" name="appStartupMode" value="${escape(selected)}" id="${id}-startup-mode">`}</div>`;
}
export function syncApplicationStartupModes(container,modes,{beforeReplace=()=>{}}={}){
 const root=container?.matches?.('[data-application-editor]')?container:container?.querySelector?.('[data-application-editor]'),slot=root?.querySelector('[data-app-startup-mode-slot]'),control=slot?.querySelector('[name=appStartupMode]');if(!slot||!control)return false;
 const allowed=Array.isArray(modes)&&modes.length?modes:['entrypoint'],id=control.id.replace(/-startup-mode$/,''),selected=control.value||'entrypoint',markup=startupModeMarkup(id,selected,allowed,root.dataset.applicationDisabled==='true');
 beforeReplace(slot);const template=root.ownerDocument.createElement('template');uiHTML(template,markup);slot.replaceWith(template.content.firstElementChild);return true;
}
export function applicationFields({kind='nodejs',application={},disabled=false,idPrefix,startupModes=['entrypoint']}={}){
 if(!isApplication(kind))return'';
 const id=String(idPrefix||`application-${++sequence}`).replace(/[^\w-]/g,'-'),config={...applicationDefaults(kind),...application},args=Array.isArray(config.args)?config.args:[],environment=Array.isArray(config.environment)?config.environment:[],readonly=disabled?'disabled':'';
 // A masked public value is never copied into an input or serialized hidden field.
 const publicEnvironment=environment.map(row=>({...row,value:row.secret&&row.hasValue?null:row.value??''}));
 const mode=config.startup?.mode||'entrypoint',knownModes=kind==='python'?['entrypoint','python-module']:['entrypoint','npm-script'],modes=(Array.isArray(startupModes)?startupModes:['entrypoint']).filter(value=>knownModes.includes(value));
 const startupMarkup=`${startupModeMarkup(id,mode,modes,disabled)}<div class="field" data-app-startup-for="npm-script" ${mode==='npm-script'?'':'hidden'}><label for="${id}-startup-script">${escape(text('Package script name','Tên script của gói'))}</label><input id="${id}-startup-script" name="appStartupScript" value="${escape(config.startup?.script||'start')}" maxlength="80" autocomplete="off" spellcheck="false" ${readonly}><small>${escape(text('Must exist in package.json. Additional arguments are passed to the selected script.','Phải tồn tại trong package.json. Tham số bổ sung được chuyển cho script đã chọn.'))}</small></div><div class="field" data-app-startup-for="python-module" ${mode==='python-module'?'':'hidden'}><label for="${id}-startup-module">${escape(text('Python module','Module Python'))}</label><input id="${id}-startup-module" name="appStartupModule" value="${escape(config.startup?.module||(kind==='python'&&config.entrypoint==='app.py'?'app':''))}" maxlength="200" placeholder="uvicorn" autocomplete="off" spellcheck="false" ${readonly}><small>${escape(text('Uses python -m inside this application’s isolated environment. Install the module in the project first.','Dùng python -m trong môi trường riêng của ứng dụng. Cài module trong dự án trước.'))}</small></div>`;
 return`<section class="application-editor" data-application-editor data-application-kind="${kind}" data-application-disabled="${disabled}"><div class="application-startup-grid">${startupMarkup}<div class="field" data-app-startup-for="entrypoint" ${mode==='entrypoint'?'':'hidden'}><label for="${id}-entrypoint">${escape(text('Entry file','Tệp đầu vào'))}</label><input id="${id}-entrypoint" name="appEntrypoint" value="${escape(config.entrypoint)}" required maxlength="240" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${kind==='python'?'app.py':'server.js'}" ${readonly}><small>${escape(text('Relative to this application’s file directory.','Đường dẫn tương đối trong thư mục tệp của ứng dụng.'))}</small></div><div class="field"><label for="${id}-dependencies">${escape(text('Dependencies during setup','Thư viện khi tạo ứng dụng'))}</label><select id="${id}-dependencies" name="appDependencies" ${readonly}><option value="none" ${config.dependencies==='none'?'selected':''}>${escape(text('Manual installation','Cài thủ công'))}</option><option value="auto" ${config.dependencies==='auto'?'selected':''}>${escape(text('Install during creation','Cài khi tạo ứng dụng'))}</option></select><small>${escape(kind==='python'?text('Uses requirements.txt in an isolated Python environment. After changing it, install dependencies while stopped.','Dùng requirements.txt trong môi trường Python riêng. Sau khi sửa tệp, cài thư viện khi ứng dụng đã dừng.'):text('Uses package-lock.json when present; otherwise package.json. After changing either, install dependencies while stopped.','Dùng package-lock.json nếu có; nếu không dùng package.json. Sau khi sửa tệp, cài thư viện khi ứng dụng đã dừng.'))}</small></div><div class="field application-readiness-field"><label for="${id}-readiness">${escape(text('Ready when','Sẵn sàng khi'))}</label><select id="${id}-readiness" name="appReadiness" ${readonly}><option value="tcp" ${config.readiness==='tcp'?'selected':''}>${escape(text('TCP port accepts connections','Cổng TCP nhận kết nối'))}</option><option value="process" ${config.readiness==='process'?'selected':''}>${escape(text('Process is running','Tiến trình đang chạy'))}</option></select><small>${escape(text('For bots or background scripts, process mode checks that the process stays alive; it does not verify a web endpoint.','Với bot hoặc tác vụ nền, chế độ tiến trình kiểm tra ứng dụng còn chạy; không xác nhận trang web sẵn sàng.'))}</small></div></div><div class="application-field-heading"><div><h3>${escape(text('Arguments','Tham số'))}</h3><p>${escape(text('One field is one argument. Spaces stay inside that argument.','Mỗi ô là một tham số. Dấu cách trong ô được giữ nguyên.'))}</p></div><button type="button" class="btn text" data-app-add="argument" ${disabled||args.length>=32?'disabled':''}>+ ${escape(text('Add argument','Thêm tham số'))}</button></div><div class="application-arguments" data-app-arguments>${args.map(value=>argumentRow(value,disabled)).join('')}</div><p class="application-empty-note" data-app-no-arguments ${args.length?'hidden':''}>${escape(text('No additional arguments.','Không có tham số bổ sung.'))}</p><input type="hidden" name="appArgs" value="${escape(JSON.stringify(args))}"><div class="application-field-heading application-environment-heading"><div><h3>${escape(text('Environment variables','Biến môi trường'))}</h3><p>${escape(text('PORT is supplied automatically. Secret values stay hidden after saving.','PORT được cấp tự động. Giá trị bí mật được ẩn sau khi lưu.'))}</p></div><button type="button" class="btn text" data-app-add="variable" ${disabled||environment.length>=64?'disabled':''}>+ ${escape(text('Add variable','Thêm biến'))}</button></div><div class="application-variables" data-app-variables>${publicEnvironment.map(row=>environmentRow(row,disabled)).join('')}</div><p class="application-empty-note" data-app-no-variables ${environment.length?'hidden':''}>${escape(text('No custom variables.','Không có biến tùy chỉnh.'))}</p><input type="hidden" name="appEnvironment" value="${escape(JSON.stringify(publicEnvironment))}"><p class="application-draft-error form-error" data-app-field-error role="status"></p></section>`;
}
export function bindApplicationFields(container,{onChange=()=>{},disabled}={}){
 const root=container?.matches?.('[data-application-editor]')?container:container?.querySelector?.('[data-application-editor]');if(!root)return null;
 const existing=bindings.get(root);if(existing)return existing;
 let locked=disabled??root.dataset.applicationDisabled==='true',destroyed=false;
 const elements=selector=>[...root.querySelectorAll(selector)];
 const serialize=()=>{
  const args=elements('[data-app-argument-value]').map(input=>input.value),environment=elements('[data-app-variable]').map(row=>({name:row.querySelector('[data-app-env-name]').value,value:row.dataset.appRetained==='true'&&row.dataset.appReplaced!=='true'?null:row.querySelector('[data-app-env-value]').value,secret:row.querySelector('[data-app-env-secret]').checked,originalName:row.dataset.originalName}));
  root.querySelector('[name=appArgs]').value=JSON.stringify(args);root.querySelector('[name=appEnvironment]').value=JSON.stringify(environment);return{args,environment};
 };
 const sync=()=>{
  const {args,environment}=serialize();root.querySelector('[data-app-no-arguments]').hidden=Boolean(args.length);root.querySelector('[data-app-no-variables]').hidden=Boolean(environment.length);
  for(const control of root.querySelectorAll('input:not([type=hidden]),select,button'))control.disabled=locked;
  const mode=root.querySelector('[name=appStartupMode]')?.value||'entrypoint';for(const field of root.querySelectorAll('[data-app-startup-for]')){field.hidden=field.dataset.appStartupFor!==mode;const input=field.querySelector('input');if(input)input.required=!field.hidden;}
  root.querySelector('[data-app-add=argument]').disabled=locked||args.length>=32;root.querySelector('[data-app-add=variable]').disabled=locked||environment.length>=64;
 };
 const changed=()=>{sync();onChange(root);};
 const onInput=event=>{const variable=event.target.closest('[data-app-variable]');if(variable&&event.target.matches('[data-app-env-value]'))variable.dataset.appReplaced='true';changed();};
 const onChangeEvent=event=>{if(event.target.matches('[data-app-env-secret]')){const row=event.target.closest('[data-app-variable]');row.querySelector('[data-app-env-value]').type=event.target.checked?'password':'text';}changed();};
 const onClick=event=>{
  const button=event.target.closest('button');if(!button||!root.contains(button)||button.disabled||locked)return;
  if(button.dataset.appAdd){const type=button.dataset.appAdd,rows=elements(type==='argument'?'[data-app-argument]':'[data-app-variable]');if(rows.length>=(type==='argument'?32:64))return;const holder=root.querySelector(type==='argument'?'[data-app-arguments]':'[data-app-variables]');const template=root.ownerDocument.createElement('template');uiHTML(template,type==='argument'?argumentRow(''):environmentRow());const row=template.content.firstElementChild;holder.append(row);changed();row.querySelector('input')?.focus();}
  else if(button.dataset.appRemove){const row=button.closest(button.dataset.appRemove==='argument'?'[data-app-argument]':'[data-app-variable]'),next=row.nextElementSibling||row.previousElementSibling,add=root.querySelector(`[data-app-add="${button.dataset.appRemove}"]`);row.remove();changed();(next?.querySelector('input')||add)?.focus();}
  else if(button.hasAttribute('data-app-clear-secret')){const row=button.closest('[data-app-variable]');row.dataset.appReplaced='true';const input=row.querySelector('[data-app-env-value]');input.value='';input.placeholder='';button.hidden=true;changed();input.focus();}
 };
 root.addEventListener('input',onInput);root.addEventListener('change',onChangeEvent);root.addEventListener('click',onClick);
 const binding={serialize,sync,setDisabled(value){locked=Boolean(value);sync();},destroy(){if(destroyed)return;destroyed=true;root.removeEventListener('input',onInput);root.removeEventListener('change',onChangeEvent);root.removeEventListener('click',onClick);bindings.delete(root);}};bindings.set(root,binding);sync();return binding;
}

export function applicationRuntimeMarkup(server,{runtime,available,reason,reasonI18n,managed=false,creating=false}={}){
 const latest=creating&&managed&&runtime?.catalog?.status==='verified'?runtime?.latest:null,version=applicationVersionLabel(server,latest?.version??(creating&&managed?'':server?.runtime?.version??runtime?.version??'')),isAvailable=available===true,missing=runtime?.prerequisites?.missing;
 const description=isAvailable?creating&&managed?text('Latest stable release · pinned on creation','Bản ổn định mới nhất · ghim khi tạo'):text('Application runtime available','Môi trường ứng dụng sẵn sàng'):Array.isArray(missing)&&missing.length?text(`Missing build prerequisites: ${missing.join(', ')}`,`Thiếu công cụ biên dịch: ${missing.join(', ')}`):wireText(reason,reasonI18n)||text('Runtime availability has not been confirmed on this VPS.','Chưa xác nhận môi trường chạy trên VPS này.');
 const catalogNotice=creating&&runtime?.catalog?.status==='unavailable'?wireText(runtime.catalog.reason,runtime.catalog.reasonI18n):null;
 return`<div class="application-runtime-summary"><span class="application-runtime-glyph" aria-hidden="true">${applicationKind(server)==='python'?'Py':'JS'}</span><div><strong>${escape(applicationName(server))}${version?` <span>${escape(version)}</span>`:''}</strong><p>${escape(description)}</p>${catalogNotice&&catalogNotice!==description?`<small>${escape(catalogNotice)}</small>`:''}${latest?.method?`<small>${escape(latest.method==='official-source'?text('Official source build','Biên dịch nguồn chính thức'):text('Official runtime package','Gói môi trường chính thức'))}${latest.cached===true?` · ${escape(text('Cached on this VPS','Đã lưu trên VPS này'))}`:''}</small>`:''}${creating?`<button type="button" class="btn text application-runtime-refresh" data-app-runtime-refresh><svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg><span>${escape(text('Refresh runtime catalog','Làm mới danh mục môi trường'))}</span></button>`:''}</div><span class="badge ${isAvailable?'':'neutral'}">${escape(isAvailable?creating&&managed?text('Ready to install','Sẵn sàng cài'):text('Available','Sẵn sàng'):text('Unavailable','Chưa sẵn sàng'))}</span></div>`;
}

export function applicationSettingsMarkup(data,{icon=()=>'',canManage=()=>false,runtime={}}={}){
 const server=data.server||data,stopped=server.status==='stopped'&&!server.busy&&!server.recoveryRequired,editable=stopped&&canManage(server),app=data.application||server.application||applicationDefaults(applicationKind(server));
 return`<section class="panel application-settings" data-application-settings data-server-id="${escape(server.id)}"><div class="panel-header"><div><h2>${escape(text('Startup & environment','Khởi chạy & môi trường'))}</h2></div><span class="badge neutral">${escape(applicationName(server))}</span></div><div class="panel-body">${applicationRuntimeMarkup(server,runtime)}${!stopped?`<div class="notice application-state-notice">${escape(text('Stop the application before changing startup settings or installing dependencies.','Dừng ứng dụng trước khi sửa thiết lập khởi chạy hoặc cài thư viện.'))}</div>`:''}<form data-application-form data-dirty="false">${applicationFields({kind:applicationKind(server),application:app,disabled:!editable,startupModes:runtime.runtime?.startupModes})}<div class="application-savebar"><span data-app-save-state role="status">${escape(text('No unsaved changes','Chưa có thay đổi'))}</span><button type="submit" class="btn primary" disabled>${icon('check')}<span>${escape(text('Save startup settings','Lưu thiết lập khởi chạy'))}</span></button></div><p class="form-error" data-app-save-error role="alert"></p></form><div class="application-dependency-card"><span class="application-dependency-icon" aria-hidden="true">${icon('layers')}</span><div><strong>${escape(text('Project dependencies','Thư viện dự án'))}</strong><p>${escape(applicationKind(server)==='python'?text('Install packages listed in requirements.txt.','Cài các gói trong requirements.txt.'):text('Install packages from the project manifest and lockfile.','Cài các gói từ tệp khai báo và tệp khóa của dự án.'))}</p></div><button type="button" class="btn soft" data-app-install-dependencies data-server-id="${escape(server.id)}" ${editable&&runtime.available===true?'':'disabled'}>${icon('download')}<span>${escape(text('Install dependencies','Cài thư viện'))}</span></button></div><p data-app-dependency-state role="status" class="application-dependency-state"></p><section class="application-project" data-app-project>${applicationProjectMarkup(data,{icon,canManage})}</section></div></section>`;
}

export function applicationConsoleAside(server,{icon=()=>''}={}){
 return`<section class="panel application-console-aside" data-app-console-server="${escape(server.id)}"><div class="panel-header"><h2>${escape(text('Application','Ứng dụng'))}</h2><span class="badge neutral">${escape(applicationName(server))}</span></div><div class="panel-body"><dl class="application-facts" data-app-runtime-facts>${applicationConsoleFacts(server)}</dl><p class="panel-description">${escape(text('Console input is sent to the running application’s standard input.','Nội dung console được gửi tới đầu vào chuẩn của ứng dụng đang chạy.'))}</p><button type="button" class="btn text" data-action="server-tab" data-tab="settings">${icon('sliders')}<span>${escape(text('Startup settings','Thiết lập khởi chạy'))}</span></button></div></section>`;
}
export function applicationConsoleFacts(server){
 const app=server.application||applicationDefaults(applicationKind(server)),runtime=server.applicationRuntime||{},mode=app.startup?.mode||'entrypoint',fact=(label,value)=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;
 const ready=server.nodeOnline===false?text('Node unreachable · last known state','VPS mất kết nối · trạng thái gần nhất'):server.status==='stopped'?text('Stopped','Đã dừng'):runtime.ready===true?runtime.readiness==='process'?text('Process check passed','Đã xác nhận tiến trình'):text('TCP check passed','Đã xác nhận cổng TCP'):server.status==='starting'?text('Waiting for readiness','Đang chờ sẵn sàng'):text('Readiness not confirmed','Chưa xác nhận sẵn sàng');
 return`${fact(mode==='npm-script'?text('Package script','Script của gói'):mode==='python-module'?text('Python module','Module Python'):text('Entry file','Tệp đầu vào'),mode==='npm-script'?app.startup.script:mode==='python-module'?app.startup.module:app.entrypoint)}${server.runtime?.version?fact(text('Pinned runtime','Môi trường đã ghim'),server.runtime.version):runtime.version?fact(text('Runtime version','Phiên bản môi trường'),runtime.version):''}${fact(text('Application port','Cổng ứng dụng'),Number.isInteger(server.port)?`${server.port} TCP`:'—')}${fact(text('Readiness','Độ sẵn sàng'),ready)}${Number.isInteger(server.pid)&&server.pid>0?fact('PID',server.pid):''}${Number.isInteger(runtime.uid)&&Number.isInteger(runtime.gid)?fact('UID / GID',`${runtime.uid} / ${runtime.gid}`):''}${fact(text('Automatic restart','Tự khởi động lại'),server.autoRestart?text('On','Bật'):text('Off','Tắt'))}`;
}
const consoleSnapshots=new WeakMap();
export function syncApplicationConsoleAside(container,server){
 const root=container?.querySelector('[data-app-console-server]');if(!root||root.dataset.appConsoleServer!==server?.id)return;
 const signature=JSON.stringify([server.application?.entrypoint,server.application?.startup,server.status,server.nodeOnline,server.port,server.pid,server.autoRestart,server.runtime?.version,server.applicationRuntime]);if(consoleSnapshots.get(root)===signature)return;
 consoleSnapshots.set(root,signature);uiHTML(root.querySelector('[data-app-runtime-facts]'),applicationConsoleFacts(server));
}

export function bindApplicationSettings(container,data,context){
 const panel=container.querySelector('[data-application-settings]');if(!panel)return null;
 const serverId=data.server.id,path=`/servers/${encodeURIComponent(serverId)}`,form=panel.querySelector('[data-application-form]'),save=form.querySelector('[type=submit]'),install=panel.querySelector('[data-app-install-dependencies]'),error=form.querySelector('[data-app-save-error]'),status=form.querySelector('[data-app-save-state]'),dependencyStatus=panel.querySelector('[data-app-dependency-state]');
 let baseline=data,working=false,unknownDependency=false,disposed=false,fields,projectControls;
 const current=()=>!disposed&&panel.isConnected&&(!context.isCurrent||context.isCurrent());
 const actual=()=>context.findServer?.(serverId)||baseline.server;
 const editable=()=>{const server=actual();return context.canManage(server)&&server.status==='stopped'&&!server.busy&&!server.recoveryRequired&&server.nodeOnline!==false;};
 const raw=()=>JSON.stringify([...form.querySelectorAll('[name]')].map(input=>[input.name,input.value]));let saved;
 const sync=()=>{const dirty=raw()!==saved,runtime=context.runtime||applicationRuntimeState(baseline.capabilities?.applicationRuntime||baseline.capabilities,baseline.server.kind,{server:baseline.server,runtimeAvailability:baseline.runtimeAvailability});form.dataset.dirty=String(dirty);save.disabled=working||!editable()||!dirty;install.disabled=working||!editable()||unknownDependency||runtime.available!==true;fields?.setDisabled(working||!editable());projectControls?.sync();if(!working)uiText(status,dirty?text('Unsaved startup changes','Có thay đổi khởi chạy chưa lưu'):text('No unsaved changes','Chưa có thay đổi'));context.onDirty?.(dirty);};
 fields=bindApplicationFields(form,{onChange:sync});saved=raw();
 const onSubmit=async event=>{
  event.preventDefault();if(working||!current()||!editable())return;
  if(context.canSave&&!context.canSave()){uiText(error,text('Save or discard general settings before saving the startup draft.','Lưu hoặc bỏ thiết lập chung trước khi lưu bản nháp khởi chạy.'));return;}
  let application;try{application=readApplicationForm(form,{kind:baseline.server.kind,previous:baseline.application});}catch(cause){uiText(error,cause.message);return;}
  const submitted=raw();working=true;sync();const finish=beginButtonBusy(save);uiText(error,'');
  try{
   const result=validateApplicationResponse(await context.api(path+'/application',{method:'PATCH',body:{revision:baseline.revision,application}}),serverId,baseline.server.kind);if(!current())return;
   baseline={...result,runtimeAvailability:result.runtimeAvailability??baseline.runtimeAvailability};if(raw()===submitted){fields.destroy();uiHTML(form.querySelector('[data-application-editor]'),applicationFields({kind:result.server.kind,application:result.application,disabled:!editable(),startupModes:(context.runtime||applicationRuntimeState(result.capabilities?.applicationRuntime||result.capabilities,result.server.kind,{server:result.server,runtimeAvailability:baseline.runtimeAvailability})).runtime?.startupModes}));const outer=form.querySelector('[data-application-editor]'),inner=outer.querySelector('[data-application-editor]');if(inner)outer.replaceWith(inner);fields=bindApplicationFields(form,{onChange:sync});saved=raw();}
   uiText(status,text('Startup settings saved.','Đã lưu thiết lập khởi chạy.'));await context.onSaved?.(result);
  }catch(cause){if(current())uiText(error,cause.message);}finally{finish();working=false;if(current())sync();}
 };
 const onInstall=async()=>{
  if(working||unknownDependency||!current()||!editable())return;
  if(form.dataset.dirty==='true'){uiText(dependencyStatus,text('Save startup changes before installing dependencies.','Lưu thay đổi khởi chạy trước khi cài thư viện.'));return;}
  if(context.confirm&&!await context.confirm({title:text('Install project dependencies?','Cài thư viện của dự án?'),description:text('The application stays stopped. Follow the installation job for the result.','Ứng dụng vẫn dừng. Theo dõi tác vụ cài đặt để xem kết quả.'),confirm:text('Install dependencies','Cài thư viện'),cancel:text('Cancel','Hủy')}))return;
  if(!current()||!editable())return;working=true;sync();const finish=beginButtonBusy(install);uiText(dependencyStatus,'');
  try{const result=await context.api(path+'/dependencies',{method:'POST',body:{}});if(!current())return;uiText(dependencyStatus,text('Dependency installation accepted. Check the job for completion.','Đã nhận yêu cầu cài thư viện. Xem tác vụ để biết khi hoàn tất.'));if(result.job?.id)await context.showJob?.(result.job.id,result.job,baseline.server);await context.onJobAccepted?.(result);}
  catch(cause){if(current()){unknownDependency=cause.outcomeUnknown===true||!cause.status;uiText(dependencyStatus,unknownDependency?text('The installation outcome is unknown. Check tasks before sending another request.','Chưa rõ kết quả yêu cầu cài đặt. Kiểm tra tác vụ trước khi gửi lại.'):cause.message);}}finally{finish();working=false;if(current())sync();}
 };
 projectControls=bindApplicationProject(panel,data,context);form.addEventListener('submit',onSubmit);install.addEventListener('click',onInstall);sync();
 return{sync,destroy(){disposed=true;projectControls.destroy();for(const input of form.querySelectorAll('[data-app-env-value]'))input.value='';const serialized=form.querySelector('[name=appEnvironment]');if(serialized)serialized.value='[]';fields.destroy();form.removeEventListener('submit',onSubmit);install.removeEventListener('click',onInstall);}};
}
