import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { NODE_RUNTIME_FILES } from '../server/node-runtime.js';

const installer = await fs.readFile(new URL('../deploy/install-node.sh', import.meta.url), 'utf8');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
async function runFixture(t, failHealth, missingTool = '', foreignOwner = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-node-installer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const relative of ['project/deploy', 'project/server', 'project/public', 'project/output', 'private/tls', 'unit', 'install/releases/previous', 'data']) await fs.mkdir(path.join(directory, relative), { recursive: true });
  for (const relative of NODE_RUNTIME_FILES) {
    const file = path.join(directory, 'project', relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture source');
  }
  await fs.copyFile(new URL('../server/node-runtime.js', import.meta.url), path.join(directory, 'project/server/node-runtime.js'));
  await fs.writeFile(path.join(directory, 'project/package.json'), '{"name":"fixture","version":"0.8.0"}');
  await fs.writeFile(path.join(directory, 'project/package-lock.json'), '{}');
  await fs.writeFile(path.join(directory, 'project/server/node-cli.js'), 'fixture source');
  await fs.writeFile(path.join(directory, 'project/server/index.js'), 'panel must never be installed');
  await fs.writeFile(path.join(directory, 'project/server/auth.js'), 'panel accounts must never be installed');
  await fs.writeFile(path.join(directory, 'project/public/index.html'), 'fixture source');
  await fs.writeFile(path.join(directory, 'project/output/private-data.txt'), 'never copy this output');
  await fs.writeFile(path.join(directory, 'private/node.json'), JSON.stringify({ nodeId: 'b109ff15-0c59-44cd-84ae-159da236bdc1', marker: 'existing private config marker' }));
  await fs.writeFile(path.join(directory, 'data/world-marker'), 'existing world bytes');
  await fs.writeFile(path.join(directory, 'unit/vortex-node.service'), '# original fixture unit\n');
  await fs.symlink(path.join(directory, 'install/releases/previous'), path.join(directory, 'install/current'), process.platform === 'win32' ? 'junction' : 'dir');
  // Git Bash cannot create native file symlinks without Windows privileges.
  // Model only the two system activation primitives with owned junctions;
  // Linux uses the original ln/mv commands. Never model config/data writes.
  await fs.writeFile(path.join(directory, 'junction.cjs'), `const fs=require('node:fs'),path=require('node:path'); const [action,a,b]=process.argv.slice(2),root=path.join(__dirname,'install'); if(![a,b].every(p=>path.resolve(p).startsWith(root+path.sep)))throw Error('fixture scope'); if(action==='create'){if(fs.existsSync(b))fs.unlinkSync(b);fs.symlinkSync(a,b,'junction')}else{if(!fs.lstatSync(a).isSymbolicLink())throw Error('fixture link');if(fs.existsSync(b)){if(!fs.lstatSync(b).isSymbolicLink())throw Error('fixture target');fs.unlinkSync(b)}fs.renameSync(a,b)}`);
  // Production runs as root and chown makes created files root-owned. This
  // fixture intentionally runs without sudo and models chown as a no-op. Map
  // only that ownership boundary, only inside this private temporary fixture,
  // and only in the inventory subprocess. Types, links, modes, inode identities,
  // bytes and the production uid!==0 rejection remain unchanged.
  const ownerFixture = path.join(directory, 'root-owner-fixture.mjs');
  await fs.writeFile(ownerFixture, `import fs from 'node:fs'; import path from 'node:path';
const root=path.resolve(process.env.VORTEX_FIXTURE_ROOT),actual=fs.lstatSync.bind(fs),uid=process.getuid?.()??0;
fs.lstatSync=(filename,...args)=>{const info=actual(filename,...args),resolved=path.resolve(String(filename)),relative=path.relative(root,resolved);if(relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)&&info.uid===uid){const copy=Object.assign(Object.create(Object.getPrototypeOf(info)),info);copy.uid=process.env.VORTEX_FIXTURE_FOREIGN_OWNER==='true'&&resolved===path.join(root,'private','host-zram.py')?424242:0;return copy;}return info;};
`);
  const replacements = new Map([
    ['[[ $EUID -eq 0 ]]', '[[ 1 == 1 ]]'],
    ['source /etc/os-release', 'ID=ubuntu; VERSION_ID=24.04'],
    ['INSTALL_ROOT=/opt/vortex-node', 'INSTALL_ROOT=$WORK_DIR/install'],
    ['CONFIG_FILE=/etc/vortex-node.json', 'CONFIG_FILE=$WORK_DIR/private/node.json'],
    ['TLS_DIR=/etc/vortex-node', 'TLS_DIR=$WORK_DIR/private/tls'],
    ['UNIT_FILE=/etc/systemd/system/vortex-node.service', 'UNIT_FILE=$WORK_DIR/unit/vortex-node.service'],
    ['ZRAM_HELPER=/usr/local/libexec/vortex-host-zram.py', 'ZRAM_HELPER=$WORK_DIR/private/host-zram.py'],
    ['RECOVERY_DIR=$(mktemp -d /tmp/vortex-node-install.XXXXXXXX)', 'RECOVERY_DIR=$(mktemp -d "$WORK_DIR/recovery.XXXXXXXX")'],
    ['$RECOVERY_DIR == /tmp/vortex-node-install.*', '$RECOVERY_DIR == "$WORK_DIR"/recovery.*'],
  ]);
  let source = installer;
  for (const [before, after] of replacements) { assert.equal(source.split(before).length, 2, 'Exact fixture substitution: ' + before); source = source.replace(before, after); }
  const prefix = `set -Eeuo pipefail
WORK_DIR=$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")/../.." && pwd -P)
apt-get() { printf '%s\n' "$*" >> "$WORK_DIR/packages-log"; }
modprobe() { [[ $* == '--dry-run --ignore-install zram num_devices=0' ]]; }
command() { if [[ \${1:-} == -v && \${2:-} != node ]]; then [[ \${2:-} != "$VORTEX_MISSING_TOOL" ]]; else builtin command "$@"; fi; }
dpkg() { return 0; }
uname() { printf 'x86_64\n'; }
npm() { :; }
chown() { :; }
sleep() { :; }
openssl() { echo 'Must not replace existing TLS/config on repeat.' >&2; return 77; }
rsync() { local from=\${@: -2:1} to=\${@: -1}; cp -R -- "$from" "$to"; }
ln() { if [[ $VORTEX_TEST_PLATFORM == win32 ]]; then local from=\${@: -2:1} to=\${@: -1}; "$VORTEX_REAL_NODE" "$WORK_DIR/junction.cjs" create "$(cygpath -w -- "$from")" "$(cygpath -w -- "$to")"; else command ln "$@"; fi; }
mv() { if [[ $VORTEX_TEST_PLATFORM == win32 ]]; then local from=\${@: -2:1} to=\${@: -1}; "$VORTEX_REAL_NODE" "$WORK_DIR/junction.cjs" move "$(cygpath -w -- "$from")" "$(cygpath -w -- "$to")"; else command mv "$@"; fi; }
systemctl() {
  [[ $* != *bedrock-panel* ]] || { echo 'Touched panel unit.' >&2; return 77; }
  printf '%s\n' "$*" >> "$WORK_DIR/systemctl-log"
  case $1 in
    show) printf '4242\n';;
    start) grep -q 'original fixture unit' "$WORK_DIR/unit/vortex-node.service" || return 77; printf 'restored\n' > "$WORK_DIR/old-restarted";;
  esac
}
node() {
  if [[ \${1:-} == --input-type=module && \${2:-} == - ]]; then
    if [[ $# -gt 5 ]]; then
      local arguments=("\${@:3}")
      if [[ $VORTEX_TEST_PLATFORM == win32 ]]; then for index in 0 1 2 3 4; do if [[ -n \${arguments[$index]} ]]; then arguments[$index]=$(cygpath -w -- "\${arguments[$index]}"); fi; done; fi
      "$VORTEX_REAL_NODE" --import "$VORTEX_OWNER_FIXTURE_URL" --input-type=module - "\${arguments[@]}"; return
    fi
    local source=$3 destination=$4
    if [[ $VORTEX_TEST_PLATFORM == win32 ]]; then source=$(cygpath -w -- "$source"); destination=$(cygpath -w -- "$destination"); fi
    "$VORTEX_REAL_NODE" --input-type=module - "$source" "$destination"; return
  fi
  if [[ \${1:-} == -p ]]; then printf '22\n'; return; fi
  case \${2:-} in
    initialize) echo 'Must not initialize over existing config.' >&2; return 77;;
    check) if [[ $FAIL_HEALTH == true ]]; then return 1; fi; printf '{"ok":true,"processId":4242}\n';;
    show-connection) printf '{"fixture":"connection intentionally omitted"}\n';;
  esac
}
`;
  const script = path.join(directory, 'project/deploy/install-node.sh');
  await fs.writeFile(script, prefix + '\n' + source);
  const result = spawnSync(bash, [script, '--endpoint', 'https://fixture.invalid:8443'], { env: { ...process.env, FAIL_HEALTH: failHealth ? 'true' : 'false', VORTEX_TEST_PLATFORM: process.platform, VORTEX_REAL_NODE: process.execPath, VORTEX_MISSING_TOOL: missingTool,
    VORTEX_OWNER_FIXTURE_URL: pathToFileURL(ownerFixture).href, VORTEX_FIXTURE_ROOT: directory, VORTEX_FIXTURE_FOREIGN_OWNER: String(foreignOwner) }, encoding: 'utf8', timeout: 120000, windowsHide: true });
  return { directory, result };
}

test('node installer repeat keeps existing config/data, uses a separate root/delegated unit and copies only release roots', async t => {
  const { directory, result } = await runFixture(t, false); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'private/node.json'), 'utf8')).marker, 'existing private config marker'); assert.equal(await fs.readFile(path.join(directory, 'data/world-marker'), 'utf8'), 'existing world bytes');
  const unit = await fs.readFile(path.join(directory, 'unit/vortex-node.service'), 'utf8'); assert.match(unit, /^User=root$/m); assert.match(unit, /^Delegate=cpu memory pids$/m); assert.match(unit, /^Environment=VORTEX_NODE_UNIT=vortex-node.service$/m); assert.doesNotMatch(unit, /bedrock-panel/);
  const current = await fs.realpath(path.join(directory, 'install/current')); assert.notEqual(current, path.join(directory, 'install/releases/previous')); assert.equal(await fs.readFile(path.join(current, 'server/node-cli.js'), 'utf8'), 'fixture source'); assert.equal(await fs.stat(path.join(current, 'output')).then(() => true, () => false), false);
  for (const relative of ['server/index.js', 'server/auth.js', 'public/index.html', 'deploy/install.sh']) assert.equal(await fs.stat(path.join(current, relative)).then(() => true, () => false), false, relative);
  for (const relative of NODE_RUNTIME_FILES) assert.equal((await fs.stat(path.join(current, relative))).isFile(), true, relative);
  const packages = await fs.readFile(path.join(directory, 'packages-log'), 'utf8');
  for (const name of ['ufw', 'iproute2', 'procps', 'nftables', 'e2fsprogs', 'util-linux', 'bubblewrap', 'python3-venv', 'tar', 'libstdc++6']) assert.equal(packages.split(/\s+/).includes(name), true, name);
  assert.match(unit, /^CPUAccounting=yes$/m); assert.match(unit, /^MemoryAccounting=yes$/m); assert.match(unit, /^IOAccounting=yes$/m);
  assert.match(unit, /^TimeoutStopSec=240$/m);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'private/tls/install-manifest.json'), 'utf8'));
  assert.equal(manifest.nodeId, 'b109ff15-0c59-44cd-84ae-159da236bdc1'); assert.equal(manifest.product, 'vortex-node');
  assert.ok(manifest.components.some(row => row.path === path.join(directory, 'private/host-zram.py') && row.existedBefore === false && row.createdByInstallId === manifest.installId));
  assert.ok(manifest.components.some(row => row.path === path.join(current, 'server/node-cli.js')));
  assert.equal(manifest.components.some(row => row.path.includes('releases' + path.sep + 'previous') || row.path.includes('world-marker')), false, 'Legacy source and existing world data never acquire fabricated installer provenance');
});

test('missing worker tool fails before replacing the source or restarting a working service', async t => {
  for (const missing of ['nft', 'bwrap', 'setpriv']) {
    const { directory, result } = await runFixture(t, false, missing);
    assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp('Required worker tool is unavailable: ' + missing));
    assert.equal(await fs.realpath(path.join(directory, 'install/current')), path.join(directory, 'install/releases/previous'));
    assert.equal(await fs.readFile(path.join(directory, 'unit/vortex-node.service'), 'utf8'), '# original fixture unit\n');
    assert.doesNotMatch(await fs.readFile(path.join(directory, 'systemctl-log'), 'utf8'), /(?:^|\n)(?:stop|restart) /);
  }
});

test('node installer ownership inventory still rejects a foreign-owned created helper', async t => {
  const { result } = await runFixture(t, false, '', true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsafe created installer file/);
  assert.match(installer, /if\(info\.uid!==0\|\|/);
});
test('failed node candidate readiness restores previous unit/source and restarts the prior node without rewriting config/data', async t => {
  const { directory, result } = await runFixture(t, true); assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /readiness failed/); assert.equal(await fs.realpath(path.join(directory, 'install/current')), path.join(directory, 'install/releases/previous'));
  assert.equal(await fs.readFile(path.join(directory, 'unit/vortex-node.service'), 'utf8'), '# original fixture unit\n'); assert.equal(await fs.readFile(path.join(directory, 'old-restarted'), 'utf8'), 'restored\n');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'private/node.json'), 'utf8')).marker, 'existing private config marker'); assert.equal(await fs.readFile(path.join(directory, 'data/world-marker'), 'utf8'), 'existing world bytes');
  assert.equal(await fs.stat(path.join(directory, 'private/host-zram.py')).then(() => true, () => false), false, 'Failed candidate removes only its freshly created unchanged passive helper');
});
