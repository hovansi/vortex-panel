// Capture scalar UI identity before awaiting a request. An open dialog can be
// replaced by another open dialog, so its revision matters as well as its state.
export function createViewGuard(read){const before={...read()};return()=>{const current=read();return Object.keys(before).every(key=>current[key]===before[key]);};}

export function clearPrivateDialogs(root=document){for(const dialog of root.querySelectorAll('dialog')){if(dialog.open)dialog.close();dialog.returnValue='';dialog.replaceChildren();for(const key of Object.keys(dialog.dataset||{}))if(!key.startsWith('vxI18n'))delete dialog.dataset[key];}}

export async function runInSession(read,work,changed){
 const session=read(),assertCurrent=()=>{if(read()!==session)throw changed();};
 try{const result=await work(session,assertCurrent);assertCurrent();return result;}catch(error){assertCurrent();throw error;}
}

export function resetWorkspaceNavigation(state){Object.assign(state,{view:'overview',serverTab:'console',selected:null,path:'',currentRoute:''});}
