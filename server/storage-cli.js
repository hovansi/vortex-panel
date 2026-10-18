import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStorageController } from './storage-volumes.js';
import { normalizeStoragePolicy } from './storage-policy.js';
import { STORE_MAX_LOAD_BYTES } from './log-retention.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = row => ({ ino: row.ino, dev: row.dev });
const same = (a, b) => a.ino === b.ino && a.dev === b.dev;
const receiptContext = row => sha(JSON.stringify({ dataDir:row.dataDir,dataIdentity:row.dataIdentity,storeSHA256:row.storeSHA256,lock:row.lock,originalMountedIds:row.originalMountedIds }));
function invalid(message) { throw new Error(message); }
export function parseStorageMaintenanceArgs(args) {
  const command = args[0]; if (!['unmount-all', 'mount-all'].includes(command)) invalid('Use unmount-all or mount-all.');
  const result = { command };
  const fields = { '--data-dir':'dataDir', '--receipt':'receipt', '--lock-owner-pid':'lockOwnerPid' };
  for (let index=1;index<args.length;index+=2) {
    const key=fields[args[index]],value=args[index+1];if(!key||!value||Object.hasOwn(result,key))invalid('Invalid or duplicate storage maintenance argument.');result[key]=value;
  }
  if(!result.dataDir||!result.receipt||!/^\d+$/.test(result.lockOwnerPid||''))invalid('Explicit data directory, receipt and backup lock owner PID are required.');
  result.lockOwnerPid=Number(result.lockOwnerPid);if(!Number.isSafeInteger(result.lockOwnerPid)||result.lockOwnerPid<2)invalid('Invalid backup lock owner PID.');return result;
}
async function realDirectory(io, directory, { privateOwner=false, uid=0 }={}) {
  const target=path.resolve(directory);if(target!==directory)invalid('Maintenance paths must be canonical absolute paths.');
  let current=target;
  while(true){const info=await io.lstat(current);if(!info.isDirectory()||info.isSymbolicLink())invalid('Maintenance paths cannot contain symlinks.');const parent=path.dirname(current);if(parent===current)break;current=parent;}
  if(await io.realpath(target)!==target)invalid('Maintenance path identity changed.');
  const info=await io.lstat(target);
  if(privateOwner&&(info.uid!==uid||(info.mode&0o077)))invalid('The receipt directory must be private and owned by the backup user.');
  return stamp(info);
}
async function privateFile(io, filename, maximum, uid, { enforceMode=true }={}) {
  const info=await io.lstat(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>maximum||info.uid!==uid||enforceMode&&(info.mode&0o077))invalid('Maintenance metadata must be a private regular file.');
  return info;
}
async function applicationUIDs(dataDir, { io, fileOwnerUid, enforceMode, passwdPath, groupPath }) {
  const scope=sha(dataDir).slice(0,8),prefix=`vxapp_${scope}_`,privateRoot=path.join(dataDir,'.application-users');
  const readMetadata=async(filename,maximum,{privateMode=false}={})=>{
    await realDirectory(io,path.dirname(filename));
    const stat=await privateFile(io,filename,maximum,fileOwnerUid,{enforceMode:privateMode&&enforceMode});
    if(await io.realpath(filename)!==filename)invalid('Application ownership metadata cannot be linked.');
    const text=await io.readFile(filename,'utf8');
    if(Buffer.byteLength(text)>maximum||!same(await io.lstat(filename),stat))invalid('Application ownership metadata changed.');
    return text;
  };
  const passwd=(await readMetadata(passwdPath,2*1024**2)).trim().split('\n').filter(Boolean).map(line=>line.split(':'));
  const groups=(await readMetadata(groupPath,2*1024**2)).trim().split('\n').filter(Boolean).map(line=>line.split(':'));
  let entries;
  try{await realDirectory(io,privateRoot,{privateOwner:enforceMode,uid:fileOwnerUid});entries=await io.readdir(privateRoot,{withFileTypes:true});}
  catch(error){if(error.code!=='ENOENT')throw error;entries=[];}
  if(entries.length>10000)invalid('Application ownership inventory exceeds its safe limit.');
  const owned=new Set(),names=new Set(),integer=value=>Number.isSafeInteger(value)&&value>0&&value<4294967295;
  for(const entry of entries){
    if(/^\.(?:record-[a-f0-9-]+|probe-[A-Za-z0-9_-]+)$/.test(entry.name))continue;
    if(!entry.isFile()||!UUID.test(entry.name.slice(0,-5))||!entry.name.endsWith('.json'))invalid('Application ownership inventory contains an unexpected entry.');
    const value=JSON.parse(await readMetadata(path.join(privateRoot,entry.name),16384,{privateMode:true}));
    const username=prefix+value.serverId?.replaceAll('-','').slice(0,16);
    if(value.schema!==1||!UUID.test(value.serverId||'')||value.serverId+'.json'!==entry.name||value.scope!==scope||value.username!==username||!UUID.test(value.ownerId||'')||!['creating','active','releasing'].includes(value.state)||names.has(username))invalid('Application ownership record is invalid.');
    names.add(username);
    const users=passwd.filter(row=>row[0]===username),matchingGroups=groups.filter(row=>row[0]===username);
    if(users.length>1||matchingGroups.length>1)invalid('Application account identity is ambiguous.');
    const user=users[0],group=matchingGroups[0];
    if(user){
      if(user.length!==7||!group||group.length!==4||user[4]!==`vortex-app,${scope},${value.serverId},${value.ownerId}`||user[5]!=='/nonexistent'||user[6]!=='/usr/sbin/nologin'||!/^\d+$/.test(user[2])||!/^\d+$/.test(user[3])||!integer(Number(user[2]))||!integer(Number(user[3]))||group[2]!==user[3]||group[3]||value.uid!=null&&value.uid!==Number(user[2])||value.gid!=null&&value.gid!==Number(user[3]))invalid('Application account does not match its ownership record.');
      owned.add(Number(user[2]));
    }else{
      // A release may remove the account before its receipt. Still guard its
      // recorded UID: deleting a passwd row does not terminate its processes.
      if(value.state!=='releasing'||!integer(value.uid)||!integer(value.gid)||group&&(group[2]!==String(value.gid)||group[3]))invalid('Application account ownership is incomplete.');
      owned.add(value.uid);
    }
    if(value.state!=='creating'&&(!integer(value.uid)||!integer(value.gid)))invalid('Application account ownership is incomplete.');
  }
  if([...passwd,...groups].some(row=>row[0].startsWith(prefix)&&!names.has(row[0])))invalid('An application account has no validated ownership record.');
  return owned;
}
export async function activeDataProcesses(dataDir, { io=fs, procRoot='/proc', fileOwnerUid=process.getuid?.()??0, enforceMode=process.platform!=='win32', passwdPath='/etc/passwd', groupPath='/etc/group' }={}) {
  const appUIDs=await applicationUIDs(dataDir,{io,fileOwnerUid,enforceMode,passwdPath,groupPath});
  const found=[];const prefix=dataDir+path.sep;
  for(const entry of await io.readdir(procRoot,{withFileTypes:true})) {
    if(!entry.isDirectory()||!/^\d+$/.test(entry.name))continue;
    if(appUIDs.size){
      let status;
      try{status=await io.readFile(path.join(procRoot,entry.name,'status'),'utf8');}
      catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw new Error('Cannot verify the application process inventory.');}
      const ids=status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m);
      if(Buffer.byteLength(status)>131072||!ids||ids.slice(1).some(value=>!Number.isSafeInteger(Number(value))))invalid('Application process identity is unavailable.');
      if(ids.slice(1).some(value=>appUIDs.has(Number(value)))){found.push(Number(entry.name));continue;}
    }
    let executable,cwd;
    try{executable=(await io.readlink(path.join(procRoot,entry.name,'exe'))).replace(/ \(deleted\)$/,'');}
    catch(error){if(['ENOENT','ESRCH','EINVAL'].includes(error.code))continue;throw new Error('Cannot verify the native process inventory.');}
    if(path.basename(executable)!=='bedrock_server')continue;
    try{cwd=(await io.readlink(path.join(procRoot,entry.name,'cwd'))).replace(/ \(deleted\)$/,'');}catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw new Error('Cannot verify a native process directory.');}
    if(executable.startsWith(prefix)||cwd===dataDir||cwd.startsWith(prefix))found.push(Number(entry.name));
  }
  return found;
}

// A trusted backup parent owns panel.lock for the entire unmount/tar/remount
// interval. This module never acquires/removes that lock or writes panel.json.
export async function runStorageMaintenance(options, dependencies={}) {
  const {command,dataDir,receipt,lockOwnerPid}=options;
  const io=dependencies.fs||fs, uid=dependencies.uid??process.getuid?.(), ppid=dependencies.ppid??process.ppid;
  const metadataUid=dependencies.fileOwnerUid??uid;
  const platform=dependencies.platform||process.platform, now=dependencies.now||Date.now;
  const inspectProcesses=dependencies.inspectProcesses||(()=>activeDataProcesses(dataDir,{io}));
  const controllerFactory=dependencies.controllerFactory||((dir)=>createStorageController({dataDir:dir}));
  const enforceMode=dependencies.enforceMode??process.platform!=='win32';
  if(platform!=='linux'||uid!==0)invalid('Storage maintenance requires Linux root.');
  if(!['unmount-all','mount-all'].includes(command)||!Number.isSafeInteger(lockOwnerPid)||lockOwnerPid<2||lockOwnerPid!==ppid)invalid('The backup lock must belong to this command’s direct parent.');
  if(typeof dataDir!=='string'||typeof receipt!=='string'||!path.isAbsolute(dataDir)||!path.isAbsolute(receipt)||path.resolve(dataDir)===path.parse(dataDir).root)invalid('Use dedicated absolute maintenance paths.');
  if(path.resolve(dataDir)!==dataDir||path.resolve(receipt)!==receipt)invalid('Use canonical maintenance paths.');
  const dataIdentity=await realDirectory(io,dataDir),dataOwnerUid=(await io.lstat(dataDir)).uid,receiptParent=path.dirname(receipt);
  if(receipt===dataDir||receipt.startsWith(dataDir+path.sep)||dataDir.startsWith(receiptParent+path.sep)||receiptParent===dataDir)invalid('The private mount receipt must be outside the data tree.');
  await realDirectory(io,receiptParent,{privateOwner:enforceMode,uid:metadataUid});
  const lockPath=path.join(dataDir,'panel.lock'),storePath=path.join(dataDir,'panel.json');
  const initialLockInfo=await privateFile(io,lockPath,4096,metadataUid,{enforceMode});
  const initialLock=JSON.parse(await io.readFile(lockPath,'utf8'));
  if(initialLock.pid!==lockOwnerPid||typeof initialLock.identity!=='string'||!/^backup-[A-Za-z0-9_-]{1,160}$/.test(initialLock.identity))invalid('The data lock is not owned by this backup parent.');
  const storeInfo=await privateFile(io,storePath,STORE_MAX_LOAD_BYTES,dataOwnerUid,{enforceMode});
  const storeBytes=await io.readFile(storePath),store=JSON.parse(storeBytes.toString('utf8')),storeSHA256=sha(storeBytes);
  if(!Array.isArray(store.servers)||store.servers.length>10000)invalid('Invalid server inventory for storage maintenance.');
  const servers=new Map();
  for(const server of store.servers){if(!server||!UUID.test(server.id||'')||servers.has(server.id))invalid('Invalid server identity in storage inventory.');normalizeStoragePolicy(server.storagePolicy,{legacy:true});servers.set(server.id,server);}
  const lockIdentity={pid:initialLock.pid,identity:initialLock.identity,...stamp(initialLockInfo)};
  async function assertContext() {
    if(!same(await realDirectory(io,dataDir),dataIdentity))invalid('The data directory identity changed.');
    const lockInfo=await privateFile(io,lockPath,4096,metadataUid,{enforceMode});const lock=JSON.parse(await io.readFile(lockPath,'utf8'));
    if(!same(lockInfo,lockIdentity)||lock.pid!==lockIdentity.pid||lock.identity!==lockIdentity.identity)invalid('The backup data lock changed.');
    const current=await privateFile(io,storePath,STORE_MAX_LOAD_BYTES,dataOwnerUid,{enforceMode});
    if(!same(current,storeInfo)||sha(await io.readFile(storePath))!==storeSHA256)invalid('The stopped server inventory changed.');
    if((await inspectProcesses()).length)invalid('A managed server or application process is still using this data directory.');
  }
  await assertContext();
  let record,receiptIdentity;
  async function persist({create=false}={}) {
    if(create){const fd=await io.open(receipt,'wx',0o600);try{await fd.writeFile(JSON.stringify(record,null,2)+'\n');await fd.sync();}finally{await fd.close();}receiptIdentity=stamp(await privateFile(io,receipt,4*1024**2,metadataUid,{enforceMode}));return;}
    const before=await privateFile(io,receipt,4*1024**2,metadataUid,{enforceMode});if(!same(before,receiptIdentity))invalid('The storage receipt identity changed.');
    const temporary=path.join(receiptParent,'.vortex-mount-receipt-'+randomUUID()+'.tmp');let created=false;
    try{const fd=await io.open(temporary,'wx',0o600);created=true;try{await fd.writeFile(JSON.stringify(record,null,2)+'\n');await fd.sync();}finally{await fd.close();}if(!same(await io.lstat(receipt),receiptIdentity))invalid('The storage receipt changed before commit.');await io.rename(temporary,receipt);receiptIdentity=stamp(await privateFile(io,receipt,4*1024**2,metadataUid,{enforceMode}));}
    finally{if(created)await io.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  if(command==='mount-all') {
    const info=await privateFile(io,receipt,4*1024**2,metadataUid,{enforceMode});record=JSON.parse(await io.readFile(receipt,'utf8'));receiptIdentity=stamp(info);
    if(record.schemaVersion!==1||record.contextSHA256!==receiptContext(record)||record.dataDir!==dataDir||!same(record.dataIdentity||{},dataIdentity)||record.storeSHA256!==storeSHA256||JSON.stringify(record.lock)!==JSON.stringify(lockIdentity)||!Array.isArray(record.originalMountedIds)||!Array.isArray(record.restoredIds)||!Array.isArray(record.unmountedIds)||new Set(record.originalMountedIds).size!==record.originalMountedIds.length||record.originalMountedIds.some(id=>!servers.has(id)||normalizeStoragePolicy(servers.get(id).storagePolicy,{legacy:true}).mode!=='fixed')||[...record.restoredIds,...record.unmountedIds].some(id=>!record.originalMountedIds.includes(id)))invalid('The receipt does not match this stopped inventory and backup lock.');
  }
  const controller=controllerFactory(dataDir);let initialized=false;
  async function ready(){if(initialized)return;const cap=await controller.initialize();if(!cap.supported)invalid('Fixed storage maintenance is unavailable.');initialized=true;}
  async function restoreAll() {
    const failures=[];
    for(const id of record.originalMountedIds){try{await assertContext();await controller.ensureMounted(servers.get(id));if(!await controller.isMounted(servers.get(id)))invalid('The original storage mount was not restored.');if(!record.restoredIds.includes(id))record.restoredIds.push(id);await persist();}catch{failures.push(id);}}
    record.state=failures.length?'restore-pending':'restored';record.restoreFailedIds=failures;record.updatedAt=new Date(now()).toISOString();await persist();return failures;
  }
  try {
    if(command==='unmount-all') {
      const fixed=[...servers.values()].filter(server=>normalizeStoragePolicy(server.storagePolicy,{legacy:true}).mode==='fixed');
      const originalMountedIds=[];
      if(fixed.length){await ready();for(const server of fixed){await assertContext();if(await controller.isMounted(server))originalMountedIds.push(server.id);}}
      record={schemaVersion:1,dataDir,dataIdentity,storeSHA256,lock:lockIdentity,originalMountedIds,unmountedIds:[],restoredIds:[],state:'unmounting',createdAt:new Date(now()).toISOString()};
      record.contextSHA256=receiptContext(record);
      await persist({create:true});
      try{for(const id of originalMountedIds){await assertContext();const result=await controller.unmount(servers.get(id));if(result?.ok!==true||await controller.isMounted(servers.get(id)))invalid('The original storage mount did not stop.');record.unmountedIds.push(id);record.updatedAt=new Date(now()).toISOString();await persist();}}
      catch(error){try{await restoreAll();}catch{}throw error;}
      record.state='unmounted';record.updatedAt=new Date(now()).toISOString();await persist();
      return{ok:true,command,mountedBefore:originalMountedIds.length,unmounted:record.unmountedIds.length,receipt};
    }
    if(record.originalMountedIds.length)await ready();const failures=await restoreAll();if(failures.length)invalid('Some original storage mounts need recovery; retain the private receipt and backup lock.');
    return{ok:true,command,restored:record.originalMountedIds.length,receipt};
  } finally {await controller.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{console.log(JSON.stringify(await runStorageMaintenance(parseStorageMaintenanceArgs(process.argv.slice(2)))));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
