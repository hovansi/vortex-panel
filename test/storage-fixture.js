import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeStoragePolicy, GIB } from '../server/storage-policy.js';

export const directoryFixtureHost = () => ({ cpus:8,cpuPercent:null,memoryTotal:16*GIB,memoryUsed:2*GIB,memoryAvailable:14*GIB,diskTotal:100*GIB,diskAvailable:90*GIB,diskUsed:10*GIB,platform:'test-fixture',sampledAt:new Date().toISOString() });

// Test-only real ordinary directories. This helper NEVER claims a mounted or
// kernel-enforced quota and is deliberately absent from production imports.
export function createDirectoryStorageFixture(dataDir) {
  const base = path.resolve(dataDir, 'servers');
  const directory = server => {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(server.id || '')) throw new Error('Invalid fixture server identity.');
    const target = path.resolve(base, server.id); if (path.dirname(target) !== base) throw new Error('Unsafe fixture storage path.'); return target;
  };
  const capabilities = () => ({ supported:true, fixedSupported:true, testFixture:true, hardEnforced:false, enforcement:null, minGiB:1, maxGiB:1024,
    reason:'Test-only ordinary directory; no hard storage quota is enforced.' });
  const provision = async server => { await fs.mkdir(directory(server), {recursive:true,mode:0o700}); return {ok:true,testFixture:true,hardEnforced:false}; };
  async function bytes(root) {
    let count=0;
    for(const entry of await fs.readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return[];throw error;})) {
      const filename=path.join(root,entry.name);
      if(entry.isDirectory())count+=await bytes(filename);
      else if(entry.isFile())count+=(await fs.stat(filename)).size;
    }
    return count;
  }
  return {capabilities,initialize:async()=>capabilities(),provision,ensureMounted:provision,
    async stats(server){const policy=normalizeStoragePolicy(server.storagePolicy,{legacy:true});const usedBytes=await bytes(directory(server));const limitBytes=policy.diskGiB===null?null:policy.diskGiB*GIB;return{mode:policy.mode,usedBytes,totalBytes:limitBytes,limitBytes,availableBytes:limitBytes===null?null:Math.max(0,limitBytes-usedBytes),hardEnforced:false,testFixture:true,source:'test-directory-real-bytes',sampledAt:new Date().toISOString()};},
    unmount:async()=>({ok:true,unmounted:false,testFixture:true}),remove:async()=>({ok:true,removed:false,testFixture:true}),grow:provision,
    growthAdditionalBytes:async(server,policy)=>Math.max(0,(policy.diskGiB-(server.storagePolicy?.diskGiB||0))*GIB),close:async()=>{}};
}
