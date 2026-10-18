const intents = new Set(['positive','danger','warning','primary','neutral']);
const actions = {
 start:'positive',stop:'danger',kill:'danger',restart:'warning',
 'update-server':'warning','delete-server':'danger','delete-file':'danger','world-delete':'danger',
 'delete-backup':'danger','restore-backup':'danger','delete-pack':'danger','delete-player':'danger',
 'delete-user':'danger','delete-schedule':'danger','node-remove':'danger','node-uninstall':'danger','panel-uninstall':'danger',
 'mfa-disable':'danger','reset-user-mfa':'warning','mfa-recovery':'warning',
 'file-access-toggle':'warning','node-maintenance':'warning','vps-power':'warning'
};
export function buttonIntent(action,{intent,primary=false,danger=false,task,enabled}={}){
 if(intents.has(intent))return intent;
 if(action==='run-schedule')return task==='restart'?'warning':task==='stop'?'danger':task==='start'?'positive':'primary';
 if(action==='toggle-schedule')return enabled==='true'||enabled===true?'warning':'positive';
 return actions[action]||(danger?'danger':primary?'primary':'neutral');
}
export function setButtonIntent(button,intent){
 if(!button||!intents.has(intent))return;
 if(intent!=='primary')button.classList.remove('primary');
 if(intent!=='danger')button.classList.remove('danger');
 button.classList.remove('soft');
 for(const value of intents)if(value!==intent)button.classList.remove(`intent-${value}`);
 button.classList.add(`intent-${intent}`);button.dataset.intent=intent;
}
export function syncButtonIntents(root=document){
 const buttons=[...(root.matches?.('button')?[root]:[]),...root.querySelectorAll('button')];
 for(const button of buttons){
  const intent=buttonIntent(button.dataset.action,{intent:button.dataset.intent,primary:button.classList.contains('primary'),danger:button.classList.contains('danger'),task:button.dataset.scheduleAction,enabled:button.dataset.enabled});
  setButtonIntent(button,intent);
 }
}
export function watchButtonIntents(root=document){
 syncButtonIntents(root);
 const observer=new MutationObserver(changes=>{for(const change of changes)for(const node of change.addedNodes)if(node.nodeType===1)syncButtonIntents(node);});
 observer.observe(root,{childList:true,subtree:true});return()=>observer.disconnect();
}
