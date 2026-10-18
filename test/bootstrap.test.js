import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const source = await fs.readFile(new URL('../deploy/bootstrap.sh', import.meta.url), 'utf8');
const pythonSource = source.match(/<<'VORTEX_BOOTSTRAP_PYTHON'\n([\s\S]+?)\nVORTEX_BOOTSTRAP_PYTHON/)[1];
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const python = process.platform === 'win32' ? 'python' : 'python3';
const sourceDefinitions = source.replace(/\nbootstrap_main "\$@"\s*$/, '\n');

async function temporary(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-bootstrap-test-'));
  try { return await run(directory); }
  finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('vortex-bootstrap-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function bashProbe(body, args = []) {
  return temporary(async directory => {
    const script = path.join(directory, 'probe.sh');
    await fs.writeFile(script, `${sourceDefinitions}\n${body}\n`);
    return spawnSync(bash, [script.replaceAll('\\', '/'), ...args], { encoding: 'utf8', timeout: 15000, env: { ...process.env, BASH_ENV: '' } });
  });
}

async function entrypointProbe({ requested = '', mode = '', accessArgs = [], missingSS = false } = {}) {
  return temporary(async directory => {
    await fs.mkdir(path.join(directory, 'systemd'));
    await fs.writeFile(path.join(directory, 'os-release'), 'ID=ubuntu\nVERSION="24.04.3 LTS (Noble Numbat)"\nVERSION_ID="24.04"\n');
    await fs.writeFile(path.join(directory, 'ca.crt'), 'SYNTHETIC_OS_CA_PRESENT');
    await fs.writeFile(path.join(directory, 'apt-args'), '');
    await fs.writeFile(path.join(directory, 'events'), '');
    await fs.writeFile(path.join(directory, 'python3'), `#!/usr/bin/env bash
printf 'python\\n' >> "$BOOTSTRAP_EVENTS"
printf '%s\\0' "$@" > "$BOOTSTRAP_CAPTURE"
cat >/dev/null
`, { mode: 0o755 });
    // Model fixed Ubuntu filesystem/command boundaries only. The actual parser,
    // OS sourcing, missing-prerequisite logic and main entry point all execute.
    // The Python boundary captures argv and consumes source without downloading.
    const modeled = sourceDefinitions.replaceAll('/etc/os-release', '"$WORK_DIR/os-release"')
      .replaceAll('/usr/bin/python3', '"$WORK_DIR/python3"')
      .replaceAll('/etc/ssl/certs/ca-certificates.crt', '"$WORK_DIR/ca.crt"')
      .replaceAll('/run/systemd/system', '"$WORK_DIR/systemd"');
    const script = path.join(directory, 'probe.sh');
    await fs.writeFile(script, `set -Eeuo pipefail
WORK_DIR=$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd -P)
export BOOTSTRAP_CAPTURE=$WORK_DIR/capture BOOTSTRAP_EVENTS=$WORK_DIR/events
SS_READY=${missingSS ? 'false' : 'true'}
chmod +x "$WORK_DIR/python3"
id() { printf '0\\n'; }
uname() { if [[ $1 == -s ]]; then printf 'Linux\\n'; else printf 'x86_64\\n'; fi; }
dpkg() { [[ $* == '--compare-versions 24.04 ge 22.04' ]]; }
systemctl() { :; }
curl() { :; }
ss() { :; }
command() {
  if [[ \${1:-} == -v && \${2:-} == ss && $SS_READY == false ]]; then return 1; fi
  builtin command "$@"
}
apt-get() {
  ${missingSS ? ':' : "echo 'UNEXPECTED_APT' >&2; return 99"}
  printf 'apt:%s\\n' "$1" >> "$BOOTSTRAP_EVENTS"
  printf '%s\\0' "$@" >> "$WORK_DIR/apt-args"
  printf '\\n' >> "$WORK_DIR/apt-args"
  if [[ $* == update ]]; then return 0; fi
  [[ $* == 'install -y --no-install-recommends --no-remove iproute2' ]] || return 98
  [[ \${DEBIAN_FRONTEND:-} == noninteractive && \${NEEDRESTART_MODE:-} == l && \${NEEDRESTART_SUSPEND:-} == 1 ]] || return 97
  SS_READY=true
}
${modeled}
bootstrap_main "$@"
[[ $VERSION == '24.04.3 LTS (Noble Numbat)' && $SS_READY == true ]]
`);
    const args = ['--repository', 'Example/Vortex', ...(mode ? [mode] : []),
      ...(requested ? ['--version', requested] : []), ...accessArgs];
    const result = spawnSync(bash, [script.replaceAll('\\', '/'), ...args], {
      encoding: 'utf8', timeout: 15000, env: { ...process.env, BASH_ENV: '' },
    });
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /UNEXPECTED_APT/);
    return {
      argv: (await fs.readFile(path.join(directory, 'capture'), 'utf8')).split('\0').slice(0, -1),
      events: (await fs.readFile(path.join(directory, 'events'), 'utf8')).trimEnd().split(/\r?\n/),
      apt: (await fs.readFile(path.join(directory, 'apt-args'), 'utf8')).split('\n').slice(0, -1)
        .map(line => line.split('\0').slice(0, -1)),
    };
  });
}

const fixture = String.raw`
import types, unittest.mock, socket
socket.socket.connect = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('network forbidden'))
socket.create_connection = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('network forbidden'))
scope = {'__name__': 'vortex_bootstrap_offline'}
exec(compile(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'), '<actual-bootstrap>', 'exec'), scope)
# Windows-only OS boundary: production preflight requires Ubuntu; archive
# symlink rejection is still exercised before any extraction on both platforms.
if not hasattr(scope['os'],'O_NOFOLLOW'):scope['os'].O_NOFOLLOW=0
VERSION = '0.16.0'
REPOSITORY = 'Example/Vortex'
ZIP_NAME = 'vortex-panel-' + VERSION + '.zip'
base = {
 'package.json': json.dumps({'name':'vortex-panel','version':VERSION}),
 'package-lock.json': json.dumps({'version':VERSION,'packages':{'':{'version':VERSION}}}),
 'README.md':'fixture source', '.env.example':'PORT=3000\n', 'server/index.js':'fixture source',
 'server/host-zram.py':'fixture source', 'public/index.html':'fixture source',
 'deploy/install.sh':'#!/bin/bash\necho MUST_NOT_EXECUTE\n', 'deploy/application-isolation.py':'fixture source',
 'deploy/configure-access.py':'fixture source'
}
def archive(extra=(), overrides=None):
 data = io.BytesIO()
 with zipfile.ZipFile(data,'w',zipfile.ZIP_DEFLATED) as z:
  for name,body in (base | (overrides or {})).items():z.writestr(name,body)
  for name,body in extra:z.writestr(name,body)
 return data.getvalue()
class Response(io.BytesIO):
 status = 200
 def __init__(self,body):super().__init__(body);self.headers={'Content-Length':str(len(body))}
class Opener:
 def __init__(self,zip_bytes=None, sums=None, modify=None, error=None):
  self.zip=archive() if zip_bytes is None else zip_bytes
  self.sums=sums or (hashlib.sha256(self.zip).hexdigest()+'  '+ZIP_NAME+'\n').encode()
  self.calls=[];self.error=error
  prefix='https://github.com/'+REPOSITORY+'/releases/download/v'+VERSION+'/'
  self.metadata={'draft':False,'prerelease':False,'tag_name':'v'+VERSION,'assets':[{'name':ZIP_NAME,'state':'uploaded','size':len(self.zip),'browser_download_url':prefix+ZIP_NAME},{'name':'SHA256SUMS','state':'uploaded','size':len(self.sums),'browser_download_url':prefix+'SHA256SUMS'}]}
  if modify:modify(self.metadata)
 def open(self,request,timeout):
  self.calls.append(request.full_url);assert timeout==30
  if self.error:raise self.error
  if request.full_url.startswith('https://api.github.com/'):return Response(json.dumps(self.metadata).encode())
  if request.full_url.endswith('/SHA256SUMS'):return Response(self.sums)
  if request.full_url.endswith('/'+ZIP_NAME):return Response(self.zip)
  raise AssertionError('unexpected URL')
installer_calls=[]
def installer(command,cwd,check):
 assert command[0]=='/bin/bash' and pathlib.Path(command[1])==pathlib.Path(cwd)/'deploy/install.sh'
 assert pathlib.Path(command[1]).read_text()==base['deploy/install.sh']
 assert json.loads((pathlib.Path(cwd)/'package.json').read_text())['version']==VERSION
 assert check is False
 installer_calls.append(command)
 return types.SimpleNamespace(returncode=0)
scope['subprocess']=types.SimpleNamespace(run=installer)
def install(opener,requested='',mode=''):
 return scope['install_release'](opener,REPOSITORY,requested,mode)
def refused(opener,requested='',message=None):
 before=len(installer_calls)
 try:install(opener,requested)
 except (scope['BootstrapError'],zipfile.BadZipFile) as error:
  if message:assert message in str(error),(message,str(error))
 else:raise AssertionError('unsafe release accepted')
 assert len(installer_calls)==before
`;

async function pythonProbe(body) {
  return temporary(async directory => {
    const implementation = path.join(directory, 'bootstrap.py');
    const probe = path.join(directory, 'probe.py');
    await fs.writeFile(implementation, pythonSource);
    await fs.writeFile(probe, `import sys,pathlib,io,json,zipfile,hashlib,stat,urllib.error,ssl\n${fixture}\n${body}\nprint('offline probe passed')\n`);
    const result = spawnSync(python, ['-I', '-B', probe, implementation], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /offline probe passed/);
    return result;
  });
}

test('bootstrap parses before prerequisites and unresolved repository/invalid options make no host changes', async () => {
  for (const args of [[], ['--repository', 'https://github.com/a/b'], ['--repository', 'a/b', '--version', '../bad'], ['--repository', 'a/b', '--root-mode', '--service-user'], ['--version'],
    ['--repository', 'a/b', '--public-ip'], ['--repository', 'a/b', '--public-ip', '$(id)'],
    ['--repository', 'a/b', '--public-ip', '999.8.8.8'], ['--repository', 'a/b', '--public-ip', '8.8.8.999'],
    ['--repository', 'a/b', '--public-ip', '008.8.8.8'], ['--repository', 'a/b', '--public-ip', '8.008.8.8'],
    ['--repository', 'a/b', '--public-ip', '203.0.113.10', '--local-only'], ['--repository', 'a/b', '--local-only', '--public-ip', '203.0.113.10']]) {
    const result = await bashProbe(`bootstrap_preflight() { echo UNEXPECTED_PREFLIGHT; return 99; }
bootstrap_dependencies() { echo UNEXPECTED_APT; return 99; }
bootstrap_main "$@"`, args);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /UNEXPECTED/);
  }
  const help = await bashProbe('bootstrap_main "$@"', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--repository OWNER\/REPO/);
  const valid = await bashProbe(`bootstrap_parse_args "$@"
printf '%s|%s|%s\\n' "$REPOSITORY" "$BOOTSTRAP_VERSION" "$INSTALL_MODE"`, ['--repository', 'Example/Vortex', '--version', '0.16.0', '--root-mode']);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Example\/Vortex\|0\.16\.0\|--root-mode/);
});

test('root/Linux/CPU preflight refuses before download dependency installation', async () => {
  for (const [uid, system, arch] of [['1000', 'Linux', 'x86_64'], ['0', 'Darwin', 'x86_64'], ['0', 'Linux', 'aarch64']]) {
    const result = await bashProbe(`id() { printf '%s\\n' '${uid}'; }
uname() { if [[ $1 == -s ]]; then printf '%s\\n' '${system}'; else printf '%s\\n' '${arch}'; fi; }
bootstrap_dependencies() { echo UNEXPECTED_APT; }
bootstrap_preflight
bootstrap_dependencies`);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_APT/);
  }
});

test('actual Ubuntu bootstrap entrypoint preserves latest/exact release, mode and every access option as literal Python argv', async () => {
  for (const requested of ['', '0.16.0']) {
    for (const mode of ['', '--root-mode', '--service-user']) {
      for (const [accessArgs, accessMode, publicIp] of [[[], '', ''], [['--local-only'], 'local', ''],
        [['--public-ip', '8.8.4.4'], '', '8.8.4.4']]) {
        const result = await entrypointProbe({ requested, mode, accessArgs });
        assert.deepEqual(result.argv, ['-I', '-B', '-', 'Example/Vortex', requested, mode, accessMode, publicIp]);
        assert.deepEqual(result.events, ['python']);
        assert.deepEqual(result.apt, []);
      }
    }
  }
});

test('an Ubuntu host missing only ss installs iproute2 before the Python entrypoint without nginx or openssl', async () => {
  const result = await entrypointProbe({ missingSS: true });
  assert.deepEqual(result.argv, ['-I', '-B', '-', 'Example/Vortex', '', '', '', '']);
  assert.deepEqual(result.events, ['apt:update', 'apt:install', 'python']);
  assert.deepEqual(result.apt, [['update'], ['install', '-y', '--no-install-recommends', '--no-remove', 'iproute2']]);
  assert.ok(result.apt.flat().every(value => value !== 'nginx' && value !== 'openssl'));
});

test('verified stable latest and exact-version archives extract fully before calling installer with exact mode', async () => {
  await pythonProbe(String.raw`
for requested,mode in [('', ''), (VERSION,'--root-mode'), (VERSION,'--service-user')]:
 opener=Opener();install(opener,requested,mode)
 assert opener.calls[0]=='https://api.github.com/repos/'+REPOSITORY+'/releases/'+('tags/v'+VERSION if requested else 'latest')
 assert opener.calls[1].endswith('/SHA256SUMS') and opener.calls[2].endswith('/'+ZIP_NAME)
 assert installer_calls[-1][2:]==([mode] if mode else [])
assert len(installer_calls)==3
`);
});

test('verified installer forwards access options as literal argv without changing the default mode', async () => {
  await pythonProbe(String.raw`
scope['install_release'](Opener(),REPOSITORY,'','','local','')
assert installer_calls[-1][2:]==['--local-only']
scope['install_release'](Opener(),REPOSITORY,VERSION,'--service-user','','203.0.113.10')
assert installer_calls[-1][2:]==['--service-user','--public-ip','203.0.113.10']
assert len(installer_calls)==2
`);
});

test('bad/duplicate checksum and damaged or mismatched package versions never extract or execute', async () => {
  await pythonProbe(String.raw`
bad=Opener(sums=('0'*64+'  '+ZIP_NAME+'\n').encode())
with unittest.mock.patch.object(scope['tempfile'],'TemporaryDirectory',side_effect=AssertionError('must verify first')):refused(bad,message='SHA-256')
line=hashlib.sha256(archive()).hexdigest()+'  '+ZIP_NAME+'\n'
refused(Opener(sums=(line+line).encode()),message='duplicate')
refused(Opener(zip_bytes=archive(overrides={'package.json':json.dumps({'name':'vortex-panel','version':'0.15.9'})})),message='versions')
refused(Opener(zip_bytes=archive(overrides={'package-lock.json':'[]'})),message='versions')
refused(Opener(zip_bytes=b'not a ZIP at all'))
`);
});

test('digest-correct traversal, symlink, special-file and duplicate ZIPs refuse before extraction', async () => {
  await pythonProbe(String.raw`
for name in ['../escape','/tmp/escape','public/../../escape','public//escape','public/./escape','C:/escape','.github/secret.txt']:
 with unittest.mock.patch.object(scope['tempfile'],'TemporaryDirectory',side_effect=AssertionError('unsafe archive must not extract')):refused(Opener(zip_bytes=archive([(name,b'escape')])))
# ZipInfo normalizes separators when a ZIP is authored on Windows. Change the
# raw local/central names so this fixture retains the unsafe archive bytes.
raw=archive([('public/escape',b'escape')]).replace(b'public/escape',b'public'+bytes([92])+b'escape')
with unittest.mock.patch.object(scope['tempfile'],'TemporaryDirectory',side_effect=AssertionError('unsafe archive must not extract')):refused(Opener(zip_bytes=raw))
for kind in [stat.S_IFLNK,stat.S_IFIFO,stat.S_IFCHR]:
 info=zipfile.ZipInfo('server/link');info.create_system=3;info.external_attr=(kind|0o644)<<16
 refused(Opener(zip_bytes=archive([(info,b'../../etc/passwd')])))
refused(Opener(zip_bytes=archive([('server/index.js',b'duplicate')])),message='duplicate')
refused(Opener(zip_bytes=archive([('server/conflict',b'file'),('server/conflict/child',b'file')])),message='collision')
assert not installer_calls
`);
});

test('checksum-valid private, backup, log and key paths are refused while public examples/workflows remain allowed', async () => {
  await pythonProbe(String.raw`
private=['output/file','data/file','node_modules/file','.playwright-cli/file','coverage/file','.git/file','__pycache__/file',
         '.env','.env.production','.env.example','old.js.bk','old.js.bk123','old.bak','old.backup','old.orig','old~','file.tmp','server.log','module.pyc',
         'server.pem','server.key','server.p12','server.pfx','id_rsa','id_ed25519','id_ecdsa','id_dsa','.DS_Store','Thumbs.db','vortex-access.json','live-client-api.py']
for name in private:
 with unittest.mock.patch.object(scope['tempfile'],'TemporaryDirectory',side_effect=AssertionError('private archive must not extract')):
  refused(Opener(zip_bytes=archive([('server/'+name,b'PRIVATE_FIXTURE')])),message='private')
for name in ['server/.hidden','public/.ssh/key.pub','.github/workflows/.hidden.yml','server/.github/ci.yml']:
 with unittest.mock.patch.object(scope['tempfile'],'TemporaryDirectory',side_effect=AssertionError('hidden archive must not extract')):
  refused(Opener(zip_bytes=archive([(name,b'PRIVATE_FIXTURE')])),message='hidden')
install(Opener(zip_bytes=archive([('.github/workflows/ci.yml',b'name: Public workflow'),('LICENSE',b'Public fixture license')])) )
assert len(installer_calls)==1
`);
});

test('archive member/count/expanded bounds stop bombs before extraction', async () => {
  await pythonProbe(String.raw`
with unittest.mock.patch.object(scope['tempfile'],'TemporaryDirectory',side_effect=AssertionError('bomb must not extract')):
 refused(Opener(zip_bytes=archive([('public/large',b'0'*(scope['MAX_MEMBER']+1))])),message='member')
 refused(Opener(zip_bytes=archive([('server/e'+str(i),b'') for i in range(scope['MAX_MEMBERS'])])),message='entries')
 refused(Opener(zip_bytes=archive([('public/m'+str(i),b'0'*scope['MAX_MEMBER']) for i in range(17)])),message='Expanded')
assert not installer_calls
`);
});

test('publisher errors, rate limiting, partial/latest prerelease and external asset URL fail closed', async () => {
  await pythonProbe(String.raw`
for error in [urllib.error.URLError('offline'),ssl.SSLCertVerificationError('bad certificate'),urllib.error.HTTPError('https://api.github.com/',429,'rate limited',{},None)]:
 refused(Opener(error=error),message='rate limit' if isinstance(error,urllib.error.HTTPError) else 'download failed')
for change in [lambda row:row.update(prerelease=True),lambda row:row.update(draft=True),lambda row:row.update(tag_name='v0.17.0-beta'),lambda row:row['assets'].pop(),lambda row:row['assets'][0].update(browser_download_url='https://untrusted.invalid/asset'),lambda row:row['assets'][0].update(size=scope['MAX_ZIP']+1)]:refused(Opener(modify=change))
refused(Opener(),requested='0.15.9',message='different release')
assert not installer_calls
`);
});

test('normal verified TLS and redirect allowlist are required; download bytes are bounded without Content-Length', async () => {
  await pythonProbe(String.raw`
contexts=[]
original=scope['ssl'].create_default_context
def context():
 value=original();contexts.append(value);return value
with unittest.mock.patch.object(scope['ssl'],'create_default_context',side_effect=context):scope['normal_opener']()
assert contexts[0].check_hostname and contexts[0].verify_mode==ssl.CERT_REQUIRED
for url in ['http://github.com/a','https://untrusted.invalid/a','https://github.com:444/a','https://name:password@github.com/a','https://github.com/a#fragment']:
 try:scope['approved_url'](url)
 except scope['BootstrapError']:pass
 else:raise AssertionError('unsafe redirect accepted')
for url in ['https://github.com/a','https://release-assets.githubusercontent.com/a?signature=public','https://objects.githubusercontent.com/a']:scope['approved_url'](url)
class Oversize:
 def open(self,*args,**kwargs):
  value=Response(b'x'*101);value.headers={};return value
try:scope['download'](Oversize(),'https://github.com/a',100)
except scope['BootstrapError'] as error:assert 'size limit' in str(error)
else:raise AssertionError('unbounded response accepted')
`);
});
