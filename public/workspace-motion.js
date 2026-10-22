// Keep selection and arrival motion outside scrolling containers and app state.
export function createWorkspaceMotion({workspace,navigation,mobileNavigation}={}){
 const doc=workspace?.ownerDocument,view=doc?.defaultView;
 if(!workspace||!view)return{capture(){},syncNavigation(){},reveal(){},revealSection(){},reset(){}};
 const reduced=view.matchMedia('(prefers-reduced-motion: reduce)'),entries=new Map(),arrivals=new Set();
 const easing='cubic-bezier(.2,.85,.25,1)';
 let pending=false,frame=0,currentRoute='',disposed=false;
 const rect=element=>{const box=element?.getBoundingClientRect();return box&&box.width>0&&box.height>0?{left:box.left,top:box.top,width:box.width,height:box.height}:null;};
 const sameBox=(a,b)=>a&&b&&['left','top','width','height'].every(key=>Math.abs(a[key]-b[key])<.5);
 const cancelEntry=entry=>{entry.animation?.cancel();entry.animation=null;};
 function finishArrivals(){for(const animation of arrivals)animation.cancel();arrivals.clear();}
 function entryFor(key,root){
  let entry=entries.get(key);
  if(!entry){const indicator=doc.createElement('span');indicator.className='workspace-nav-indicator';indicator.setAttribute('aria-hidden','true');entry={root,indicator,identity:'',target:null,snapshot:null,animation:null};entries.set(key,entry);}
  if(entry.root!==root){resize?.unobserve(entry.root);entry.root=root;}
  resize?.observe(root);
  return entry;
 }
 function plan(key,root,selector,animate){
  if(!root||!root.isConnected)return null;
  const active=root.querySelector(selector),box=rect(active),container=rect(root);
  if(!box||!container)return null;
  const entry=entryFor(key,root),connected=entry.indicator.isConnected;
  const identity=active.dataset.tab||active.dataset.settingsTarget||active.getAttribute('href')||active.dataset.action||'';
  if(connected&&entry.identity===identity&&sameBox(entry.target,box))return null;
  const previous=entry.snapshot||(connected?rect(entry.indicator):null);
  return{entry,root,active,box,identity,previous,animate:animate&&!reduced.matches,
   left:box.left-container.left+root.scrollLeft-root.clientLeft,top:box.top-container.top+root.scrollTop-root.clientTop};
 }
 function apply(job){
  if(!job)return;
  const{entry,root,active,box,identity,previous,left,top}=job;
  cancelEntry(entry);entry.snapshot=null;entry.identity=identity;entry.target=box;
  root.dataset.motionReady='true';
  const indicator=entry.indicator;
  indicator.dataset.intent=active.classList.contains('settings-navigation-danger')?'danger':'neutral';
  Object.assign(indicator.style,{left:left+'px',top:top+'px',width:box.width+'px',height:box.height+'px'});
  if(indicator.parentElement!==root)root.append(indicator);
  if(!job.animate||!previous||sameBox(previous,box)||typeof indicator.animate!=='function')return;
  // FLIP only the decoration. Width/height settle once; surrounding layout is static.
  const dx=previous.left-box.left,dy=previous.top-box.top;
  if(Math.abs(dx)>view.innerWidth||Math.abs(dy)>view.innerHeight)return;
  const animation=indicator.animate([{transform:`translate(${dx}px,${dy}px) scale(${previous.width/box.width},${previous.height/box.height})`},{transform:'none'}],{duration:340,easing});
  entry.animation=animation;animation.finished.then(()=>{if(entry.animation===animation)entry.animation=null;},()=>{});
 }
 function syncNavigation({animate=true}={}){
  const jobs=[plan('sidebar',navigation,':scope > .nav-item.active',animate),plan('mobile',mobileNavigation,':scope > a.active,:scope > button.active',animate)];
  for(const job of jobs)apply(job);
 }
 function syncContentIndicators({animate=false}={}){
  const strip=workspace.querySelector('.server-tabs'),server=strip?.closest('[data-server-id]')?.dataset.serverId;
  const settings=workspace.querySelector('.settings-navigation');
  const jobs=[strip&&server?plan('server:'+server,strip,':scope > [role=tab][aria-selected=true]',animate):null,
   settings?plan('settings',settings,':scope > button[aria-current=page]',animate):null];
  for(const job of jobs)apply(job);
  // Retain only current strips plus a small recent cache for route transitions.
  while(entries.size>34){const key=[...entries.keys()].find(key=>!['sidebar','mobile','settings','server:'+server].includes(key));if(!key)break;const entry=entries.get(key);cancelEntry(entry);resize?.unobserve(entry.root);entry.indicator.remove();entries.delete(key);}
 }
 function capture(){
  pending=true;finishArrivals();
  for(const entry of entries.values()){entry.snapshot=entry.indicator.isConnected?rect(entry.indicator):null;cancelEntry(entry);}
 }
 function arrivalTargets(root){
  const children=[...root.children].flatMap(child=>child.matches('.server-workspace')?[...child.children].filter(item=>!item.matches('.server-context')):[child]);
  const bounds=workspace.getBoundingClientRect();
  return children.filter(child=>{if(child.hidden||child.matches('script,style,.workspace-loading'))return false;const box=child.getBoundingClientRect();return box.width>0&&box.height>0&&box.bottom>bounds.top&&box.top<bounds.bottom;}).slice(0,7);
 }
 function arrive(root){
  if(reduced.matches)return;
  const targets=arrivalTargets(root),jobs=targets.map(element=>{
   const style=view.getComputedStyle(element),scrolling=/(auto|scroll|hidden|clip)/.test(style.overflowX+' '+style.overflowY);
   // Large composite panes and scroll boxes fade without becoming containing blocks.
   const move=!scrolling&&!element.matches('.settings-layout,.overview-workbench,.server-workspace,[data-operation-view]');
   return{element,move};
  });
  for(const[{element,move},index]of jobs.map((job,index)=>[job,index])){
   if(typeof element.animate!=='function')continue;
   const animation=element.animate([{opacity:.08,...(move?{transform:'translateY(12px)'}:{})},{opacity:1,...(move?{transform:'none'}:{})}],{duration:360,delay:index*30,easing,fill:'backwards'});
   arrivals.add(animation);animation.finished.then(()=>arrivals.delete(animation),()=>arrivals.delete(animation));
  }
 }
 function reveal({route='',animate=true}={}){
  const changed=route!==currentRoute;currentRoute=route;pending=false;
  syncNavigation({animate:false});syncContentIndicators({animate:changed&&animate});
  workspace.dataset.motionReady='true';
  if(changed&&animate){finishArrivals();arrive(workspace);}
 }
 function revealSection(section){
  if(!section?.isConnected||section.hidden||!workspace.contains(section))return;
  finishArrivals();syncContentIndicators({animate:true});arrive(section);
 }
 function schedule(){if(disposed||frame)return;frame=view.requestAnimationFrame(()=>{frame=0;syncNavigation({animate:false});if(!pending)syncContentIndicators();});}
 const resize=typeof view.ResizeObserver==='function'?new view.ResizeObserver(schedule):null;
 const mutation=new view.MutationObserver(()=>{if(!pending)schedule();});mutation.observe(workspace,{childList:true});
 const settleOnInteraction=event=>{if(event.type==='pointerdown'||event.target?.closest?.('button,a,input,select,textarea,summary,[role=combobox],[role=tab]'))finishArrivals();};
 const motionPreference=()=>{if(reduced.matches){finishArrivals();for(const entry of entries.values())cancelEntry(entry);}schedule();};
 view.addEventListener('resize',schedule,{passive:true});reduced.addEventListener('change',motionPreference);
 workspace.addEventListener('pointerdown',settleOnInteraction,{capture:true,passive:true});workspace.addEventListener('focusin',settleOnInteraction,true);
 function reset(){
  pending=false;currentRoute='';finishArrivals();if(frame){view.cancelAnimationFrame(frame);frame=0;}
  for(const entry of entries.values()){cancelEntry(entry);resize?.unobserve(entry.root);delete entry.root.dataset.motionReady;entry.indicator.remove();}entries.clear();delete workspace.dataset.motionReady;
 }
 function destroy(){reset();disposed=true;resize?.disconnect();mutation.disconnect();view.removeEventListener('resize',schedule);reduced.removeEventListener('change',motionPreference);workspace.removeEventListener('pointerdown',settleOnInteraction,true);workspace.removeEventListener('focusin',settleOnInteraction,true);}
 return{capture,syncNavigation,reveal,revealSection,reset,destroy};
}
