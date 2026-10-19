import {wireText,uiHTML,uiText} from './i18n.js';

const text=(en,vi)=>wireText(en,{en,vi});
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const VERSION=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.+-]+)?$/,BUILD=/^[a-f0-9]{64}$/;
export function frontendIdentity(value,{requireBuild=false}={}){
 if(!value||typeof value.version!=='string'||!VERSION.test(value.version)||requireBuild&&!BUILD.test(value.buildId||''))return null;
 return {version:value.version,buildId:BUILD.test(value.buildId||'')?value.buildId:null};
}
export function readPageFrontendIdentity(root=document){return frontendIdentity({version:root.querySelector('meta[name="vortex-frontend-version"]')?.content,buildId:root.querySelector('meta[name="vortex-frontend-build"]')?.content},{requireBuild:true});}
export async function readFrontendHealth({signal,fetcher=fetch}={}){
 const response=await fetcher('/healthz',{cache:'no-store',credentials:'same-origin',redirect:'error',signal});
 if(!response.ok)throw Error('Frontend release status is unavailable.');
 const value=await response.json();if(value?.ok!==true||value.service!=='vortex-panel')throw Error('Frontend release status is invalid.');
 const identity=frontendIdentity({version:value.version,buildId:value.frontendBuild});if(!identity)throw Error('Frontend release identity is invalid.');return identity;
}
export function createFrontendReleaseObserver({boot,read=readFrontendHealth,canReload=async()=>false,reload=()=>location.reload(),timeoutMs=12000}={}){
 const initial=frontendIdentity(boot,{requireBuild:true}),listeners=new Set();let closed=false,flight=null,abort=null,pending=null,remote=null,phase=initial?'idle':'unverified',reloadFlight=null,committed=false;
 const snapshot=()=>({phase,boot:initial?{...initial}:null,remote:remote?{...remote}:null,pending:pending?{...pending}:null,reloading:!!reloadFlight||committed});
 const emit=()=>{const value=snapshot();for(const listener of listeners)listener(value);};
 return {state:snapshot,subscribe(listener){listeners.add(listener);listener(snapshot());return()=>listeners.delete(listener);},
  check(){
   if(closed||!initial)return Promise.resolve(snapshot());if(flight)return flight;
   abort=new AbortController();const controller=abort,timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();phase=pending?'update-ready':'checking';emit();
   flight=(async()=>{
    try{const value=frontendIdentity(await read({signal:controller.signal}));if(closed||controller.signal.aborted)return snapshot();if(!value)throw Error();remote=value;
     if(value.version!==initial.version||value.buildId&&value.buildId!==initial.buildId){pending=value;phase='update-ready';}
     else if(value.buildId===initial.buildId){pending=null;phase='idle';}
     else phase=pending?'update-ready':'unverified';
    }catch{if(!closed)phase=pending?'update-ready':'unavailable';}
    finally{clearTimeout(timer);if(abort===controller)abort=null;if(!closed)emit();}
    return snapshot();
   })().finally(()=>{flight=null;});return flight;
  },
  requestReload(){
   if(closed||!pending||committed)return Promise.resolve(false);if(reloadFlight)return reloadFlight;
   reloadFlight=(async()=>{try{if(!await canReload(snapshot())||closed||!pending)return false;committed=true;emit();await reload();return true;}catch{committed=false;return false;}})().finally(()=>{reloadFlight=null;if(!closed)emit();});emit();return reloadFlight;
  },destroy(){closed=true;abort?.abort();listeners.clear();}
 };
}
export function mountFrontendReleaseNotice(observer,{root=document.body}={}){
 const notice=root.ownerDocument.createElement('aside');notice.className='frontend-release-notice';notice.hidden=true;notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
 uiHTML(notice,`<span class="frontend-release-symbol" aria-hidden="true"><svg class="icon"><use href="#i-download"/></svg></span><div class="frontend-release-copy"><strong>${escape(text('A new panel interface is ready','Giao diện panel mới đã sẵn sàng'))}</strong><p data-frontend-release-copy></p></div><button type="button" class="btn soft" data-frontend-reload>${escape(text('Reload interface','Tải lại giao diện'))}<svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg></button>`);root.append(notice);
 // Authentication scrolls as one card. Keep this notice in its flow so it can
 // never cover the sign-in/setup submit button on a narrow or short screen.
 const auth=root.ownerDocument.getElementById('auth');
 const place=()=>{const card=auth&&!auth.hidden?auth.querySelector('.auth-card'):null,target=card||root;notice.classList.toggle('is-auth-notice',Boolean(card));if(notice.parentNode!==target)target.append(notice);};
 const placement=auth&&typeof MutationObserver==='function'?new MutationObserver(place):null;
 placement?.observe(auth,{attributes:true,attributeFilter:['hidden'],childList:true});place();
 const button=notice.querySelector('[data-frontend-reload]');let latest=null;
 const unsubscribe=observer.subscribe(value=>{latest=value;notice.hidden=!value.pending;if(!value.pending)return;uiText(notice.querySelector('[data-frontend-release-copy]'),text(`The server runs ${value.pending.version}. Save your work, then reload this page to use its interface.`,`Máy chủ đang chạy ${value.pending.version}. Lưu công việc rồi tải lại trang để dùng giao diện tương ứng.`));button.disabled=value.reloading;notice.classList.toggle('is-reloading',value.reloading);});
 button.addEventListener('click',async()=>{if(!latest?.pending)return;await observer.requestReload();});
 return {element:notice,destroy(){placement?.disconnect();unsubscribe();notice.remove();}};
}
