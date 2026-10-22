import {wireText,uiText,plainUI} from './i18n.js';

const controls=new WeakMap(),mounted=new Set();let sequence=0,pendingInvalidFocus=null;
const message=(en,vi)=>wireText(en,{en,vi});
// Keep native menus on browsers without a top layer, including older iOS.
const eligible=select=>select instanceof HTMLSelectElement&&!select.multiple&&select.size<=1&&!select.hasAttribute('data-native-select')&&typeof HTMLElement.prototype.showPopover==='function';
function candidates(root,selector='select'){return [...(root.matches?.(selector)?[root]:[]),...root.querySelectorAll(selector)].filter(eligible);}
function accessibleName(select){
 const labelledby=select.getAttribute('aria-labelledby')?.trim().split(/\s+/).map(id=>document.getElementById(id)?.textContent.trim()).filter(Boolean).join(' ');if(labelledby)return labelledby;
 const explicit=select.getAttribute('aria-label');if(explicit)return explicit;
 const text=[...(select.labels||[])].map(label=>{const clone=label.cloneNode(true);for(const item of clone.querySelectorAll('select,.select-control'))item.remove();return clone.textContent.trim();}).filter(Boolean).join(' ');
 return text||select.getAttribute('title')||select.name||message('Choose an option','Chọn một mục');
}
function enhance(select){
 if(controls.has(select)){controls.get(select).sync();return controls.get(select);}
 const original={tabindex:select.getAttribute('tabindex'),ariaHidden:select.getAttribute('aria-hidden')},wrapper=document.createElement('span'),trigger=document.createElement('button'),value=document.createElement('span'),chevron=document.createElement('span'),popup=document.createElement('div'),list=document.createElement('div');
 wrapper.className='select-control';wrapper.dataset.selectControl='';if(select.id)wrapper.dataset.selectId=select.id;
 trigger.type='button';trigger.className='select-control-trigger';trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');trigger.setAttribute('aria-expanded','false');if(original.tabindex!==null)trigger.setAttribute('tabindex',original.tabindex);
 value.className='select-control-value';chevron.className='select-control-chevron';chevron.textContent='⌄';chevron.setAttribute('aria-hidden','true');trigger.append(value,chevron);
 popup.className='select-control-popup';popup.hidden=true;popup.id=`vortex-select-${++sequence}`;popup.setAttribute('popover','manual');
 list.className='select-control-options';list.id=popup.id+'-options';list.setAttribute('role','listbox');trigger.setAttribute('aria-controls',list.id);popup.append(list);
 select.before(wrapper);wrapper.append(select,trigger,popup);select.classList.add('select-control-native');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
 let open=false,disposed=false,signature='',search='',searchTimer=0,resetTimer=0,frame=0,reportedInvalid=false,activeIndex=-1;const listeners=[];
 const listen=(target,type,handler,options)=>{target.addEventListener(type,handler,options);listeners.push(()=>target.removeEventListener(type,handler,options));};
 const disabled=()=>select.matches(':disabled');
 const options=()=>[...select.options].map((option,index)=>({index,value:option.value,label:option.label,disabled:option.disabled||option.parentElement?.matches('optgroup:disabled'),hidden:option.hidden||option.parentElement?.matches('optgroup[hidden]'),group:option.parentElement?.tagName==='OPTGROUP'?option.parentElement:null}));
 const rows=()=>[...list.querySelectorAll('[data-select-option]:not(:disabled)')];
 function setActive(row,{scroll=true}={}){
  activeIndex=row?Number(row.dataset.selectOption):-1;
  for(const item of list.querySelectorAll('[data-select-option]'))item.classList.toggle('is-active',open&&item===row);
  if(open&&row){trigger.setAttribute('aria-activedescendant',row.id);if(scroll){const bounds=row.getBoundingClientRect(),view=popup.getBoundingClientRect();if(bounds.top<view.top+6)popup.scrollTop+=bounds.top-view.top-6;else if(bounds.bottom>view.bottom-6)popup.scrollTop+=bounds.bottom-view.bottom+6;}}
  else trigger.removeAttribute('aria-activedescendant');
 }
 function position(){
  frame=0;if(!open)return;if(!select.isConnected){destroy();return;}
  const rect=trigger.getBoundingClientRect(),viewport=window.visualViewport,margin=8,gap=6,view={left:viewport?.offsetLeft||0,top:viewport?.offsetTop||0,width:viewport?.width||document.documentElement.clientWidth,height:viewport?.height||innerHeight};
  const right=view.left+view.width,bottom=view.top+view.height;
  if(!rect.width||!rect.height||rect.bottom<view.top||rect.top>bottom||rect.right<view.left||rect.left>right){close();return;}
  const below=Math.max(0,bottom-margin-rect.bottom-gap),above=Math.max(0,rect.top-view.top-margin-gap),placeAbove=below<Math.min(240,above),height=Math.min(320,placeAbove?above:below);
  if(height<32){close();return;}
  popup.style.width=`${Math.max(0,Math.min(Math.max(rect.width,180),view.width-margin*2))}px`;popup.style.maxHeight=`${height}px`;
  const bounds=popup.getBoundingClientRect();popup.style.left=`${Math.max(view.left+margin,Math.min(rect.left,right-bounds.width-margin))}px`;popup.style.bottom='auto';popup.style.top=`${Math.max(view.top+margin,Math.min(placeAbove?rect.top-gap-bounds.height:rect.bottom+gap,bottom-margin-bounds.height))}px`;popup.dataset.placement=placeAbove?'above':'below';
  if(activeIndex>=0)setActive(rows().find(row=>Number(row.dataset.selectOption)===activeIndex));
 }
 const schedule=()=>{if(open&&!frame)frame=requestAnimationFrame(position);};
 function close({focus=false}={}){
  if(!open)return;open=false;trigger.setAttribute('aria-expanded','false');wrapper.classList.remove('is-open');setActive(null,{scroll:false});clearTimeout(searchTimer);search='';
  try{if(popup.matches(':popover-open'))popup.hidePopover();}catch{}popup.hidden=true;cancelAnimationFrame(frame);frame=0;if(focus&&trigger.isConnected&&!trigger.disabled)trigger.focus({preventScroll:true});
 }
 function show({edge}={}){
  sync();if(disposed||disabled()||select.hidden||open)return;
  for(const control of mounted)if(control.select!==select)control.close();
  trigger.focus({preventScroll:true});open=true;popup.hidden=false;wrapper.classList.add('is-open');trigger.setAttribute('aria-expanded','true');
  try{popup.showPopover();}catch{close();destroy();select.focus();try{select.showPicker?.();}catch{}return;}
  position();if(!open)return;const enabled=rows(),selected=enabled.find(row=>Number(row.dataset.selectOption)===select.selectedIndex);setActive(edge==='first'?enabled[0]:edge==='last'?enabled.at(-1):selected||enabled[0]);
 }
 function choose(index){const option=select.options[index];if(!option||option.hidden||option.disabled||option.parentElement?.matches('optgroup:disabled,optgroup[hidden]')||disabled())return;const changed=select.selectedIndex!==index;select.selectedIndex=index;sync();close({focus:true});if(changed){select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));}}
 function sync(){
  if(disposed)return;if(!select.isConnected||select.multiple||select.size>1||select.hasAttribute('data-native-select')){destroy();return;}const records=options(),next=JSON.stringify(records.map(({value,label,disabled,hidden,group})=>[value,label,!!disabled,!!hidden,group?.label||'',group?Array.prototype.indexOf.call(select.children,group):-1]));
  if(select.validity.valid)reportedInvalid=false;const invalid=select.getAttribute('aria-invalid')==='true'||reportedInvalid,name=plainUI(accessibleName(select));trigger.disabled=disabled();trigger.setAttribute('aria-required',String(select.required));trigger.setAttribute('aria-invalid',String(invalid));trigger.setAttribute('aria-label',name);list.setAttribute('aria-label',name);wrapper.hidden=select.hidden;wrapper.classList.toggle('is-disabled',trigger.disabled);wrapper.classList.toggle('is-invalid',invalid);
  for(const attribute of ['aria-labelledby','aria-describedby','aria-errormessage']){const text=select.getAttribute(attribute);if(text)trigger.setAttribute(attribute,text);else trigger.removeAttribute(attribute);}
  if(next!==signature){const fragment=document.createDocumentFragment();let group=null;for(const record of records){if(record.hidden)continue;if(record.group&&record.group!==group){const heading=document.createElement('div');heading.className='select-control-group';heading.textContent=record.group.label;heading.setAttribute('role','presentation');fragment.append(heading);}group=record.group;const row=document.createElement('button'),label=document.createElement('span'),tick=document.createElement('span');row.type='button';row.className='select-control-option';row.id=`${popup.id}-option-${record.index}`;row.dataset.selectOption=record.index;row.setAttribute('role','option');row.tabIndex=-1;row.disabled=Boolean(record.disabled);label.textContent=record.label;tick.className='select-control-tick';tick.textContent='✓';tick.setAttribute('aria-hidden','true');row.append(label,tick);fragment.append(row);}list.replaceChildren(fragment);signature=next;}
  const selected=select.options[select.selectedIndex];uiText(value,selected?.label||message('Choose an option','Chọn một mục'));trigger.title=selected?.label||'';for(const row of list.querySelectorAll('[data-select-option]'))row.setAttribute('aria-selected',String(Number(row.dataset.selectOption)===select.selectedIndex));
  if(trigger.disabled||select.hidden)close();else if(open){const enabled=rows();setActive(enabled.find(row=>Number(row.dataset.selectOption)===activeIndex)||enabled.find(row=>Number(row.dataset.selectOption)===select.selectedIndex)||enabled[0],{scroll:false});schedule();}
 }
 function destroy(){if(disposed)return;close();disposed=true;observer.disconnect();clearTimeout(searchTimer);clearTimeout(resetTimer);for(const remove of listeners)remove();select.classList.remove('select-control-native');for(const[name,saved]of[['tabindex',original.tabindex],['aria-hidden',original.ariaHidden]])if(saved===null)select.removeAttribute(name);else select.setAttribute(name,saved);if(wrapper.parentNode){wrapper.before(select);wrapper.remove();}mounted.delete(controller);controls.delete(select);}
 const keydown=event=>{
  if(event.isComposing||event.ctrlKey||event.metaKey)return;
  if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();close({focus:true});return;}
  if(event.key==='Tab'){close();return;}
  if(event.altKey&&event.key==='ArrowUp'&&open){event.preventDefault();close({focus:true});return;}
  if(event.key==='Enter'||event.key===' '){event.preventDefault();if(open)choose(activeIndex);else show();return;}
  if(['ArrowDown','ArrowUp','Home','End','PageDown','PageUp'].includes(event.key)){
   event.preventDefault();if(!open){show({edge:event.key==='Home'?'first':event.key==='End'?'last':select.selectedIndex<0&&event.key==='ArrowUp'?'last':undefined});return;}
   const enabled=rows(),current=enabled.findIndex(row=>Number(row.dataset.selectOption)===activeIndex),step=event.key.startsWith('Page')?Math.max(1,Math.floor(popup.clientHeight/(enabled[0]?.offsetHeight||44))):1,index=event.key==='Home'?0:event.key==='End'?enabled.length-1:Math.max(0,Math.min(enabled.length-1,current+(['ArrowDown','PageDown'].includes(event.key)?step:-step)));setActive(enabled[index]);return;
  }
  if(event.key.length===1&&!event.altKey&&event.key!==' '){
   event.preventDefault();if(!open)show();if(!open)return;search+=event.key.toLocaleLowerCase();clearTimeout(searchTimer);searchTimer=setTimeout(()=>search='',650);const repeated=[...search].every(character=>character===search[0]),query=repeated?search[0]:search,enabled=rows(),current=enabled.findIndex(row=>Number(row.dataset.selectOption)===activeIndex),start=Math.max(0,current+(repeated?1:0)),ordered=[...enabled.slice(start),...enabled.slice(0,start)],match=ordered.find(row=>select.options[Number(row.dataset.selectOption)].label.trim().toLocaleLowerCase().startsWith(query));if(match)setActive(match);
  }
 };
 listen(trigger,'click',()=>open?close({focus:true}):show());listen(wrapper,'keydown',keydown);
 // Touch pointerdown stays native so a scroll gesture never chooses an option.
 listen(list,'pointerdown',event=>{if(event.pointerType==='mouse'&&event.button===0&&event.target.closest('[data-select-option]'))event.preventDefault();});
 listen(list,'click',event=>{const row=event.target.closest('[data-select-option]');if(row)choose(Number(row.dataset.selectOption));});
 listen(list,'focusin',event=>{const row=event.target.closest('[data-select-option]:not(:disabled)');if(row)setActive(row,{scroll:false});});
 listen(select,'change',sync);listen(select,'input',sync);listen(select,'focus',()=>{if(!trigger.disabled)trigger.focus();});
 listen(select,'invalid',event=>{event.preventDefault();reportedInvalid=true;sync();const first=select.form?[...select.form.elements].find(control=>control.willValidate&&!control.validity.valid):select;if(first===select&&!pendingInvalidFocus){pendingInvalidFocus={select,trigger};queueMicrotask(()=>{const target=pendingInvalidFocus;pendingInvalidFocus=null;if(target?.trigger.isConnected&&!target.trigger.disabled&&!target.select.validity.valid)target.trigger.focus();});}});
 listen(document,'click',event=>{const label=event.target.closest?.('label');if(label?.control===select&&!event.defaultPrevented&&!event.target.closest('a,button,input,select,textarea,[contenteditable]')){event.preventDefault();if(!trigger.disabled)trigger.focus();}});
 listen(document,'pointerdown',event=>{if(!select.isConnected){destroy();return;}if(open&&!wrapper.contains(event.target))close();},true);listen(document,'focusin',event=>{if(open&&!wrapper.contains(event.target))close();},true);listen(document,'scroll',schedule,true);listen(window,'resize',schedule);
 if(window.visualViewport){listen(window.visualViewport,'resize',schedule);listen(window.visualViewport,'scroll',schedule);}
 listen(select.form||select,'reset',()=>{clearTimeout(resetTimer);resetTimer=setTimeout(()=>{reportedInvalid=false;sync();},0);});
 listen(popup,'toggle',event=>{if(event.newState==='closed'&&open&&!popup.matches(':popover-open'))close();});
 const ownerDialog=select.closest('dialog');if(ownerDialog){listen(ownerDialog,'close',()=>close());listen(ownerDialog,'cancel',()=>close());}
 const observer=new MutationObserver(sync);observer.observe(select,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','selected','label','value','hidden','required','multiple','size','data-native-select','aria-label','aria-labelledby','aria-describedby','aria-errormessage','aria-invalid']});
 for(let ancestor=select.parentElement;ancestor;ancestor=ancestor.parentElement)if(ancestor.tagName==='FIELDSET')observer.observe(ancestor,{attributes:true,attributeFilter:['disabled']});
 const controller={select,sync,destroy,open:show,close};controls.set(select,controller);mounted.add(controller);sync();return controller;
}
export function enhanceSelects(root=document,{selector='select'}={}){for(const control of [...mounted])if(!control.select.isConnected)control.destroy();for(const select of candidates(root,selector))enhance(select);return{sync:()=>syncSelects(root),destroy:()=>destroySelects(root)};}
export function syncSelects(root=document){for(const control of [...mounted])if(!control.select.isConnected)control.destroy();else if(root===control.select||root.contains(control.select))control.sync();}
export function destroySelects(root=document){for(const control of [...mounted])if(root===control.select||root.contains(control.select))control.destroy();}
