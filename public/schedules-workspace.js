import {wireText,getLocale,uiText,uiHTML} from './i18n.js';

const text=(en,vi)=>wireText(en,{en,vi});
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={backup:['Backup','Sao lưu'],restart:['Restart','Khởi động lại'],command:['Console command','Lệnh console']};
const statuses={idle:['Waiting','Chờ chạy'],running:['Running','Đang chạy'],completed:['Completed','Hoàn tất'],failed:['Failed','Thất bại']};
const renderedCells=new WeakMap();
const pendingControls=new WeakMap();
const label=(map,key)=>map[key]?text(...map[key]):key;
const button=(action,id,title,icon,disabled,extra='')=>`<button type="button" class="icon-button" data-action="${action}" data-id="${escape(id)}" ${disabled?'disabled':''} ${extra} aria-label="${escape(title)}" title="${escape(title)}">${icon}</button>`;

export function scheduleCommandResult(result){
  if(!result||!result.status)return '';
  if(['rejected','failed','not-sent'].includes(result.status))return text('Command rejected or not sent; the following action was not started.','Lệnh bị từ chối hoặc chưa gửi; tác vụ tiếp theo chưa được chạy.');
  if(['unknown','timeout','unconfirmed'].includes(result.status))return text('Command delivery is unconfirmed. Review the console before retrying.','Chưa xác minh được việc gửi lệnh. Kiểm tra console trước khi thử lại.');
  if(result.confirmedApplied===true)return text('Command confirmed by the server. Recipient receipt is not verified.','Máy chủ đã xác nhận lệnh. Chưa xác minh bên nhận nhận thông báo.');
  return text('Command sent to the console; its effect is not verified.','Đã gửi lệnh tới console; chưa xác minh tác động của lệnh.');
}

export function scheduleRowModel(schedule,{servers=[],canManage=()=>false,formatDate=value=>value||'—',icon=()=>''}={}){
  const server=servers.find(row=>row.id===schedule.serverId),running=schedule.status==='running',writable=Boolean(server&&canManage(server));
  const serverName=wireText(server?.name,server?.nameI18n)||schedule.serverId;
  const result=scheduleCommandResult(schedule.lastCommandResult||schedule.commandResult),command=schedule.command||'';
  return {
    id:schedule.id,
    cells:[
      `<strong>${escape(label(names,schedule.action))}</strong><small class="table-sub">${escape(serverName)}</small>${command?`<code class="schedule-command" title="${escape(command)}">${escape(command)}</code><small class="table-sub">${escape(schedule.action==='command'?text('Console command','Lệnh console'):text('Before the action','Chạy trước tác vụ'))}</small>`:''}`,
      `${escape(new Intl.NumberFormat(getLocale()).format(schedule.intervalMinutes))} ${escape(text('min','phút'))}<small class="table-sub">${escape(schedule.enabled?text('Enabled','Đã bật'):text('Paused','Đã tạm dừng'))}</small>`,
      `<span class="badge ${schedule.status==='failed'?'warn':running?'purple':'neutral'}">${running?icon('refresh'):''}${escape(label(statuses,schedule.status||'idle'))}</span>${schedule.error?`<small class="table-sub server-error">${escape(wireText(schedule.error,schedule.errorI18n))}</small>`:schedule.lastFinishedAt?`<small class="table-sub">${escape(formatDate(schedule.lastFinishedAt))}</small>`:''}${result?`<small class="table-sub schedule-delivery">${escape(result)}</small>`:''}`,
      schedule.enabled?escape(formatDate(schedule.nextRun)):'—',
      writable?`<div class="actions">${button('run-schedule',schedule.id,text('Run now','Chạy ngay'),icon('play'),running,`data-schedule-action="${escape(schedule.action)}"`)}${button('toggle-schedule',schedule.id,schedule.enabled?text('Pause schedule','Tạm dừng lịch'):text('Enable schedule','Bật lịch'),icon(schedule.enabled?'stop':'clock'),running,`data-enabled="${schedule.enabled?'true':'false'}"`)}${button('edit-schedule',schedule.id,text('Edit schedule','Sửa lịch'),icon('sliders'),running)}${button('delete-schedule',schedule.id,text('Delete schedule','Xóa lịch'),icon('trash'),running)}</div>`:`<span class="badge neutral">${escape(text('Read only','Chỉ xem'))}</span>`
    ]
  };
}

const rowMarkup=model=>`<tr data-schedule-row="${escape(model.id)}">${model.cells.map((cell,index)=>`<td data-schedule-cell="${index}"${index===3?' class="muted"':''}>${cell}</td>`).join('')}</tr>`;
const count=value=>new Intl.NumberFormat(getLocale()).format(value);

export function schedulesMarkup(data,context){
  const schedules=data.schedules||[],canCreate=context.servers.some(context.canManage);
  return `<section class="panel schedules-panel" data-schedules-workspace><div class="panel-header"><div><h2>${escape(text('Automation','Tự động hóa'))}</h2></div><span class="badge neutral" data-schedule-count>${count(schedules.length)}</span></div><div class="table-wrap" data-schedule-table${schedules.length?'':' hidden'}><table><thead><tr>${['Task / Server','Interval','Status','Next run','Actions'].map((en,index)=>`<th>${escape(text(en,['Tác vụ / Máy chủ','Chu kỳ','Trạng thái','Lần tiếp theo','Thao tác'][index]))}</th>`).join('')}</tr></thead><tbody data-schedule-rows>${schedules.map(schedule=>rowMarkup(scheduleRowModel(schedule,context))).join('')}</tbody></table></div><div class="empty-state" data-schedule-empty${schedules.length?' hidden':''}>${context.icon('clock')}<h3>${escape(text('Tasks that run on time','Tác vụ chạy đúng giờ'))}</h3><p>${escape(text('Schedule backups, restarts or console commands.','Tạo lịch sao lưu, khởi động lại hoặc gửi lệnh console.'))}</p>${canCreate?`<button type="button" class="btn soft" data-action="create-schedule">${context.icon('plus')}${escape(text('Create your first schedule','Tạo lịch đầu tiên'))}</button>`:''}</div></section>`;
}

// Reconcile by identity and by cell. Polling must never remount the workspace,
// discard keyboard focus, or replay its loading animation.
export function syncSchedules(root,data,context){
  const panel=root.querySelector('[data-schedules-workspace]'),body=panel?.querySelector('[data-schedule-rows]');
  if(!body)return false;
  const schedules=data.schedules||[],existing=new Map([...body.children].map(row=>[row.dataset.scheduleRow,row]));
  const focused=panel.ownerDocument.activeElement,focus=panel.contains(focused)&&focused.matches('[data-action][data-id]')?{action:focused.dataset.action,id:focused.dataset.id}:null;
  let cursor=body.firstElementChild;
  for(const schedule of schedules){
    const model=scheduleRowModel(schedule,context);let row=existing.get(model.id);
    const pending=new Set([...(pendingControls.get(row)||[]),...(row?.querySelectorAll('button[data-action]')||[])].filter(button=>button.dataset.pending==='true'));
    if(!row){const template=body.ownerDocument.createElement('template');uiHTML(template,rowMarkup(model));row=template.content.firstElementChild;}
    else for(let index=0;index<model.cells.length;index++){const cell=row.children[index];if(renderedCells.get(row)?.[index]!==model.cells[index]&&cell.innerHTML!==model.cells[index])uiHTML(cell,model.cells[index]);}
    // Click handlers temporarily disable their control. A fast job may finish
    // before a running snapshot is observed, leaving unchanged action markup.
    // Reconcile properties without remounting the cell or discarding focus.
    // Keep an original pending owner across cell replacement; its release
    // clears the marker even when detached. Never copy a stale busy flag.
    for(const button of row.querySelectorAll('button[data-action]'))button.disabled=schedule.status==='running'||[...pending].some(owner=>owner.dataset.action===button.dataset.action&&owner.dataset.id===button.dataset.id);
    if(pending.size)pendingControls.set(row,pending);else pendingControls.delete(row);
    renderedCells.set(row,model.cells);
    if(row!==cursor)body.insertBefore(row,cursor);cursor=row.nextElementSibling;existing.delete(model.id);
  }
  for(const row of existing.values())row.remove();
  const counter=panel.querySelector('[data-schedule-count]'),value=count(schedules.length);if(counter.textContent!==value)counter.textContent=value;
  panel.querySelector('[data-schedule-table]').hidden=!schedules.length;panel.querySelector('[data-schedule-empty]').hidden=Boolean(schedules.length);
  if(focus&&focused!==panel.ownerDocument.activeElement){const replacement=[...panel.querySelectorAll('[data-action][data-id]')].find(button=>button.dataset.action===focus.action&&button.dataset.id===focus.id);if(replacement&&!replacement.disabled)replacement.focus({preventScroll:true});}
  return true;
}

export function bindScheduleForm(form){
  const action=form.elements.namedItem('action'),input=form.elements.namedItem('command'),label=input?.labels?.[0];
  if(!action||!input||!label)return;
  const hint=form.ownerDocument.createElement('small');hint.id='schedule-command-help';input.closest('.field').append(hint);input.setAttribute('aria-describedby',hint.id);input.maxLength=2048;
  function sync(){
    input.required=action.value==='command';
    uiText(label,input.required?text('Console command','Lệnh console'):action.value==='restart'?text('Before restart (optional)','Trước khi khởi động lại (tùy chọn)'):text('Before backup (optional)','Trước khi sao lưu (tùy chọn)'));
    uiText(hint,text('Requires a running server. A rejected or unconfirmed command blocks the following action.','Cần máy chủ đang chạy. Lệnh bị từ chối hoặc chưa xác minh sẽ chặn tác vụ tiếp theo.'));
  }
  action.addEventListener('change',sync);sync();
}
