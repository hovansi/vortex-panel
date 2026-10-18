/* Decode the local scene before revealing authentication; never replace a fallback mid-session. */
const root=document.documentElement;
const artwork=new Image(2172,724);
artwork.className='auth-art';artwork.alt='';artwork.setAttribute('aria-hidden','true');
artwork.decoding='async';artwork.fetchPriority='high';artwork.src='/assets/vortex-world.webp';
let scene=null,settle,deadline,epoch=0;
const ready=new Promise(resolve=>{settle=value=>{if(scene!==null)return;scene=value;clearTimeout(deadline);resolve(value);};});
deadline=setTimeout(()=>settle('fallback'),2400);
const decoded=typeof artwork.decode==='function'?artwork.decode():new Promise((resolve,reject)=>{if(artwork.complete){artwork.naturalWidth?resolve():reject();return;}artwork.addEventListener('load',resolve,{once:true});artwork.addEventListener('error',reject,{once:true});});
decoded.then(()=>settle(artwork.naturalWidth?'image':'fallback'),()=>settle('fallback'));

/** Calling again replaces pending work, while leaving the freshly rendered form intact. */
export function showAuth(auth){
  const current=++epoch,card=auth.querySelector('.auth-card');
  auth.hidden=false;auth.dataset.authReady='false';auth.setAttribute('aria-busy','true');
  if(card)card.inert=true;
  const reveal=value=>{
    if(current!==epoch||auth.hidden)return;
    auth.dataset.authScene=value;
    if(value==='image')auth.prepend(artwork);
    auth.dataset.authReady='true';auth.setAttribute('aria-busy','false');
    if(card)card.inert=false;
    root.dataset.authBoot='ready';
    const loader=document.getElementById('auth-loader');if(loader)loader.hidden=true;
  };
  // Already decoded, failed or timed out: logout and MFA do not wait or fade again.
  if(scene!==null)reveal(scene);else ready.then(reveal);
}

/** Restoring an authenticated session does not wait for the decorative image. */
export function showWorkspace(auth){
  ++epoch;auth.hidden=true;auth.setAttribute('aria-busy','false');
  root.dataset.authBoot='workspace';
  const loader=document.getElementById('auth-loader');if(loader)loader.hidden=true;
}
