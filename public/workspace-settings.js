import {wireText,uiText} from './i18n.js';

const text=(en,vi)=>wireText(en,{en,vi});
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const categories=Object.freeze([
 {id:'account',en:'Account',vi:'Tài khoản',icon:'shield'},
 {id:'appearance',en:'Appearance',vi:'Giao diện',icon:'sun'},
 {id:'administration',en:'Panel administration',vi:'Quản trị panel',icon:'sliders',admin:true},
 {id:'members',en:'Members',vi:'Thành viên',icon:'users',admin:true},
 {id:'workspace',en:'Workspace',vi:'Workspace',icon:'layers'},
 {id:'uninstall',en:'Uninstall',vi:'Gỡ cài đặt',icon:'trash',admin:true,danger:true},
]);
let sequence=0;
const bindings=new WeakMap();

export function settingsNavigationMarkup({icon=()=>'',admin=false}={}){
 return `<nav class="settings-navigation" aria-label="${escape(text('Settings categories','Các mục cài đặt'))}">${categories.filter(category=>admin||!category.admin).map(category=>`<button type="button" data-settings-target="${category.id}"${category.danger?' class="settings-navigation-danger"':''}>${icon(category.icon)}<span class="settings-navigation-label">${escape(text(category.en,category.vi))}</span><span class="settings-navigation-chevron" aria-hidden="true">${icon('chevron')}</span></button>`).join('')}</nav>`;
}

/** Navigation selects existing sections; it never recreates controls or drafts. */
export function bindSettingsNavigation(root,{selected}={}){
 const previous=bindings.get(root),requested=selected??previous?.selected;
 previous?.destroy();
 const navigation=root?.querySelector('.settings-navigation');
 if(!navigation)return {get selected(){return '';},select:()=>false,destroy(){}};
 const id=++sequence,doc=root.ownerDocument,sections=new Map(),buttons=[];
 for(const category of categories){
  const section=root.querySelector(`[data-settings-section="${category.id}"]`),button=navigation.querySelector(`[data-settings-target="${category.id}"]`);
  if(!section||!button)continue;
  let heading=section.querySelector('[data-settings-heading]');
  if(!heading){
   const header=doc.createElement('header');header.className='settings-category-heading';
   heading=doc.createElement('h2');heading.setAttribute('data-settings-heading','');header.append(heading);section.prepend(header);
  }
  heading.id=`settings-title-${id}-${category.id}`;heading.tabIndex=-1;uiText(heading,text(category.en,category.vi));
  section.id=`settings-section-${id}-${category.id}`;section.setAttribute('aria-labelledby',heading.id);
  button.setAttribute('aria-controls',section.id);sections.set(category.id,{section,button,heading});buttons.push(button);
 }
 let active='',destroyed=false;
 function select(category,{focus=false,scroll=false}={}){
  const current=sections.get(category);if(destroyed||!current)return false;
  active=category;
  for(const [key,item] of sections){item.section.hidden=key!==category;if(key===category)item.button.setAttribute('aria-current','page');else item.button.removeAttribute('aria-current');}
  root.dataset.settingsSelection=category;
  if(focus)current.heading.focus({preventScroll:true});
  if(scroll){const workspace=root.matches?.('.workspace')?root:root.closest?.('.workspace');workspace?.scrollTo?.({top:0,behavior:'instant'});}
  return true;
 }
 function click(event){const button=event.target.closest?.('[data-settings-target]');if(button&&navigation.contains(button))select(button.dataset.settingsTarget,{focus:true,scroll:true});}
 function keydown(event){
  if(event.altKey||event.ctrlKey||event.metaKey)return;
  const button=event.target.closest?.('[data-settings-target]'),index=buttons.indexOf(button);if(index<0)return;
  let target;
  if(['ArrowDown','ArrowRight'].includes(event.key))target=(index+1)%buttons.length;
  else if(['ArrowUp','ArrowLeft'].includes(event.key))target=(index+buttons.length-1)%buttons.length;
  else if(event.key==='Home')target=0;else if(event.key==='End')target=buttons.length-1;else return;
  event.preventDefault();buttons[target].focus();
 }
 navigation.addEventListener('click',click);navigation.addEventListener('keydown',keydown);
 select(sections.has(requested)?requested:sections.has('account')?'account':sections.keys().next().value);
 const controls={get selected(){return active;},select,destroy(){if(destroyed)return;destroyed=true;navigation.removeEventListener('click',click);navigation.removeEventListener('keydown',keydown);if(bindings.get(root)===controls)bindings.delete(root);}};
 bindings.set(root,controls);return controls;
}
