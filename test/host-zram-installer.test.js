import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const installer = await fs.readFile(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const block = installer.match(/python3 - "\$ZRAM_HELPER" "\$SOURCE_DIR\/server\/host-zram\.py" <<'PY'\r?\n([\s\S]*?)\r?\nPY/)[1];
const python = process.platform === 'win32' ? 'python' : 'python3';

// Run the actual passive copy block against an owned temporary directory.
// Root UID/mode/nlink facts are explicitly modeled for Windows portability;
// file creation, bytes, repeat preservation and refusal behavior are real.
async function probe(t, mode, existing) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-zram-installer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.py'), destination = path.join(directory, 'private', 'host-zram.py');
  await fs.writeFile(source, 'inert helper source, never executed\n');
  await fs.mkdir(path.dirname(destination));
  if (existing !== undefined) await fs.writeFile(destination, existing);
  const wrapper = `import json,os,pathlib,stat,subprocess,sys,types
root,source,destination=map(pathlib.Path,sys.argv[1:4]);mode=sys.argv[4]
assert destination.resolve().is_relative_to(root.resolve())
real_lstat=pathlib.Path.lstat;real_open=os.open;writes=[]
def lstat(value,*args,**kwargs):
    info=real_lstat(value,*args,**kwargs);bits=info.st_mode & ~0o022;uid=0;links=info.st_nlink
    if value==destination:
        if mode=='symlink':bits=stat.S_IFLNK|0o777
        if mode=='nonroot':uid=1000
        if mode=='multilink':links=2
        if mode=='writable':bits|=0o022
    if value==destination.parent and mode=='unsafe-parent':bits|=0o022
    return types.SimpleNamespace(st_mode=bits,st_uid=uid,st_nlink=links)
def guarded_open(filename,flags,*args,**kwargs):
    assert pathlib.Path(filename).resolve().is_relative_to(root.resolve())
    if flags & (os.O_WRONLY|os.O_RDWR|os.O_CREAT):writes.append(str(filename))
    return real_open(filename,flags,*args,**kwargs)
def forbidden(*args,**kwargs):raise AssertionError('Passive install attempted an OS operation')
pathlib.Path.lstat=lstat;os.open=guarded_open;os.O_NOFOLLOW=getattr(os,'O_NOFOLLOW',0)
os.system=forbidden;subprocess.run=forbidden;subprocess.Popen=forbidden
sys.argv=['passive-installer',str(destination),str(source)]
try:
    exec(compile(${JSON.stringify(block)},'<actual passive installer block>','exec'),{})
    print(json.dumps({'ok':True,'writes':len(writes)}))
except SystemExit as error:
    print(json.dumps({'ok':False,'reason':str(error),'writes':len(writes)}))
`;
  const result = await promisify(execFile)(python, ['-c', wrapper, directory, source, destination, mode], { timeout: 30000, maxBuffer: 65536, windowsHide: true });
  return { ...JSON.parse(result.stdout), content: await fs.readFile(destination, 'utf8').catch(() => null) };
}

test('main installer provisions only passive helper capability; actual copy block preserves unfamiliar OS components', async t => {
  assert.match(installer, /apt-get install -y[^\n]*\bpython3\b[^\n]*\bkmod\b/);
  assert.match(installer, /^TimeoutStopSec=240$/m);
  assert.doesNotMatch(block, /swapon|swapoff|modprobe|systemctl|\/sys\//);
  const fresh = await probe(t, 'normal');
  assert.equal(fresh.ok, true); assert.equal(fresh.writes, 1); assert.equal(fresh.content, 'inert helper source, never executed\n');
  const repeat = await probe(t, 'normal', 'inert helper source, never executed\n');
  assert.equal(repeat.ok, true); assert.equal(repeat.writes, 0);
  const unfamiliar = await probe(t, 'normal', 'existing administrator component');
  assert.equal(unfamiliar.ok, false); assert.equal(unfamiliar.writes, 0); assert.equal(unfamiliar.content, 'existing administrator component');
  for (const mode of ['symlink', 'nonroot', 'multilink', 'writable', 'unsafe-parent']) {
    const rejected = await probe(t, mode, 'inert helper source, never executed\n');
    assert.equal(rejected.ok, false, mode); assert.equal(rejected.writes, 0, mode);
    assert.equal(rejected.content, 'inert helper source, never executed\n', mode);
  }
});
