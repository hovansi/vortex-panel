import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const installers = await Promise.all(['install.sh', 'install-node.sh'].map(name => fs.readFile(new URL('../deploy/' + name, import.meta.url), 'utf8')));
const blocks = installers.map(source => source.replaceAll('\r\n', '\n').match(/# BEGIN optional kernel module\n([\s\S]+?)# END optional kernel module/)[1]);
assert.equal(blocks[0], blocks[1], 'Main and worker execute the same narrowly scoped kernel-module preparation');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

async function run(t, scenario, { kernel = '6.8.0-134-generic', candidate = '6.8.0-134.134', dependency = false, dependencyStatus = 'absent', dependencyCandidate = '2026.05.30-0ubuntu1~24.04.1' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-module-installer-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('vortex-module-installer-')); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.writeFile(path.join(directory, 'customer-marker'), 'pre-existing unrelated bytes');
  const script = path.join(directory, 'probe.sh');
  await fs.writeFile(script, `set -Eeuo pipefail
WORK_DIR=$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd -P)
trap 'printf unexpected-error > "$WORK_DIR/trap-fired"; exit 77' ERR
uname() { [[ $* == -r ]] || return 93; printf '%s\\n' "$FIXTURE_KERNEL"; }
modprobe() {
  [[ $* == '--dry-run --ignore-install zram num_devices=0' ]] || return 94
  printf '%s\\n' "$*" >> "$WORK_DIR/probe-calls"
  if [[ $FIXTURE_SCENARIO == ready || -f $WORK_DIR/module-ready ]]; then return 0; fi
  return 1
}
apt-cache() {
  printf '%s\\n' "$*" >> "$WORK_DIR/cache-calls"
  [[ $FIXTURE_SCENARIO != cache-fails ]] || return 65
  case "$*" in
    "policy linux-modules-extra-$FIXTURE_KERNEL") printf 'linux-modules-extra-%s:\\n  Installed: (none)\\n  Candidate: %s\\n' "$FIXTURE_KERNEL" "$FIXTURE_CANDIDATE";;
    "policy wireless-regdb") printf 'wireless-regdb:\\n  Installed: (none)\\n  Candidate: %s\\n' "$FIXTURE_DEPENDENCY_CANDIDATE";;
    "show linux-modules-extra-$FIXTURE_KERNEL=$FIXTURE_CANDIDATE")
      [[ $FIXTURE_SCENARIO != metadata-fails ]] || return 65
      printf 'Package: linux-modules-extra-%s\\nVersion: %s\\nDepends: linux-modules-%s' "$FIXTURE_KERNEL" "$FIXTURE_CANDIDATE" "$FIXTURE_KERNEL"
      if [[ $FIXTURE_DEPENDENCY == true ]]; then printf ', wireless-regdb'; fi
      printf '\\n'
      ;;
    *) return 95;;
  esac
}
dpkg() {
  [[ $* == '--audit' ]] || return 95
  printf audit > "$WORK_DIR/audit-calls"
  [[ $FIXTURE_SCENARIO != audit-fails ]] || return 65
  if [[ $FIXTURE_SCENARIO == dirty-dpkg ]]; then printf 'customer-package awaits configuration\\n'; fi
  return 0
}
dpkg-query() {
  [[ $1 == -W && $2 == '-f=\${Status}' && $3 == wireless-regdb && $# == 3 ]] || return 95
  printf query > "$WORK_DIR/dependency-query-calls"
  case $FIXTURE_DEPENDENCY_STATUS in
    installed) printf 'install ok installed';;
    absent) return 1;;
    not-installed) printf 'unknown ok not-installed';;
    residual) printf 'deinstall ok config-files';;
    unknown) return 65;;
    *) return 95;;
  esac
}
apt-get() {
  local target=linux-modules-extra-$FIXTURE_KERNEL targets="linux-modules-extra-$FIXTURE_KERNEL=$FIXTURE_CANDIDATE"
  if [[ $FIXTURE_DEPENDENCY == true && ( $FIXTURE_DEPENDENCY_STATUS == absent || $FIXTURE_DEPENDENCY_STATUS == not-installed ) ]]; then targets+=" wireless-regdb=$FIXTURE_DEPENDENCY_CANDIDATE"; fi
  [[ $* == *'--no-install-recommends --no-remove --no-upgrade install'* && $* == *"$targets" ]] || return 96
  if [[ $* == *--simulate* ]]; then
    printf '%s\\n' "$*" >> "$WORK_DIR/simulation-calls"
    [[ $FIXTURE_SCENARIO != simulation-fails ]] || return 66
    [[ $FIXTURE_SCENARIO != no-action ]] || return 0
    if [[ $FIXTURE_SCENARIO == target-upgrade ]]; then printf 'Inst %s [old-version] (%s Ubuntu [amd64])\\n' "$target" "$FIXTURE_CANDIDATE"
    elif [[ $FIXTURE_SCENARIO != conf-only ]]; then printf 'Inst %s (%s Ubuntu:24.04/noble-updates [amd64])\\n' "$target" "$FIXTURE_CANDIDATE"; fi
    printf 'Conf %s (%s Ubuntu:24.04/noble-updates [amd64])\\n' "$target" "$FIXTURE_CANDIDATE"
    if [[ $FIXTURE_DEPENDENCY == true && ( $FIXTURE_DEPENDENCY_STATUS == absent || $FIXTURE_DEPENDENCY_STATUS == not-installed ) ]]; then
      if [[ $FIXTURE_SCENARIO == dependency-version-mismatch ]]; then printf 'Inst wireless-regdb (9.9 Ubuntu [all])\\n'
      elif [[ $FIXTURE_SCENARIO != dependency-conf-only ]]; then printf 'Inst wireless-regdb (%s Ubuntu [all])\\n' "$FIXTURE_DEPENDENCY_CANDIDATE"; fi
      printf 'Conf wireless-regdb (%s Ubuntu [all])\\n' "$FIXTURE_DEPENDENCY_CANDIDATE"
    fi
    if [[ $FIXTURE_SCENARIO == dependency-upgrade ]]; then printf 'Inst wireless-regdb [1.0] (%s Ubuntu [all])\\n' "$FIXTURE_DEPENDENCY_CANDIDATE"; fi
    if [[ $FIXTURE_SCENARIO == dependency-unlisted ]]; then printf 'Inst wireless-regdb (%s Ubuntu [all])\\n' "$FIXTURE_DEPENDENCY_CANDIDATE"; fi
    if [[ $FIXTURE_SCENARIO == foreign-install ]]; then printf 'Inst linux-image-other (1.0 Ubuntu [amd64])\\n'; fi
    if [[ $FIXTURE_SCENARIO == foreign-configure ]]; then printf 'Conf unrelated-customer-package (2.0 Ubuntu [amd64])\\n'; fi
    if [[ $FIXTURE_SCENARIO == removal ]]; then printf 'Remv existing-customer-package [1.0]\\n'; fi
    if [[ $FIXTURE_SCENARIO == purge ]]; then printf 'Purg existing-customer-package [1.0]\\n'; fi
    return 0
  fi
  [[ $NEEDRESTART_MODE == l && $NEEDRESTART_SUSPEND == 1 ]] || return 96
  printf '%s\\n' "$*" >> "$WORK_DIR/install-calls"
  [[ $FIXTURE_SCENARIO != install-fails ]] || return 67
  if [[ $FIXTURE_SCENARIO != still-unavailable ]]; then printf 'matching module files prepared' > "$WORK_DIR/module-ready"; fi
  return 0
}
systemctl() { printf 'forbidden' > "$WORK_DIR/service-action"; return 97; }
reboot() { printf 'forbidden' > "$WORK_DIR/reboot-action"; return 98; }
${blocks[0]}
printf 'working service installation continues' > "$WORK_DIR/continues"
`);
  const result = spawnSync(bash, [script], { env: { ...process.env, FIXTURE_SCENARIO: scenario, FIXTURE_KERNEL: kernel, FIXTURE_CANDIDATE: candidate, FIXTURE_DEPENDENCY: String(dependency), FIXTURE_DEPENDENCY_STATUS: dependencyStatus, FIXTURE_DEPENDENCY_CANDIDATE: dependencyCandidate }, timeout: 20000, encoding: 'utf8', windowsHide: true });
  const read = name => fs.readFile(path.join(directory, name), 'utf8').catch(() => '');
  return { ...result, probes: await read('probe-calls'), cache: await read('cache-calls'), audit: await read('audit-calls'), dependencyQuery: await read('dependency-query-calls'), simulation: await read('simulation-calls'), installed: await read('install-calls'), marker: await read('customer-marker'), continued: await read('continues'), trap: await read('trap-fired'), service: await read('service-action'), reboot: await read('reboot-action') };
}
const unchanged = result => { assert.equal(result.status, 0, result.stderr); assert.equal(result.marker, 'pre-existing unrelated bytes'); assert.equal(result.continued, 'working service installation continues'); assert.equal(result.trap, ''); assert.equal(result.service, ''); assert.equal(result.reboot, ''); };

test('existing kernel module skips package lookup and every mutation', async t => {
  const result = await run(t, 'ready'); unchanged(result); assert.equal(result.cache, ''); assert.equal(result.simulation, ''); assert.equal(result.installed, ''); assert.equal(result.probes.trim().split('\n').length, 1);
});

test('missing module prepares only the candidate pinned to the currently running kernel and confirms by dry run', async t => {
  const result = await run(t, 'eligible'); unchanged(result); assert.match(result.cache, /policy linux-modules-extra-6\.8\.0-134-generic/); assert.match(result.installed, /--no-remove --no-upgrade install -y linux-modules-extra-6\.8\.0-134-generic=6\.8\.0-134\.134/); assert.equal(result.installed.trim().split('\n').length, 1); assert.equal(result.probes.trim().split('\n').length, 2); assert.equal(result.stderr, '');
});

test('missing candidate, unsafe kernel/version or unavailable repository remain optional without interrupting installation', async t => {
  for (const [scenario, values] of [['no-candidate', { candidate: '(none)' }], ['invalid-kernel', { kernel: '6.8.0; touch /tmp/forbidden' }], ['invalid-candidate', { candidate: '6.8.0; touch /tmp/forbidden' }], ['cache-fails', {}]]) {
    const result = await run(t, scenario, values); unchanged(result); assert.equal(result.installed, ''); assert.equal(result.simulation, ''); assert.match(result.stderr, /Optional memory assistance is unavailable/);
  }
});

test('package plans that install, configure or remove unrelated packages are refused before real apt installation', async t => {
  for (const scenario of ['foreign-install', 'foreign-configure', 'removal', 'purge', 'simulation-fails', 'no-action', 'target-upgrade', 'conf-only', 'dependency-unlisted']) {
    const result = await run(t, scenario); unchanged(result); assert.equal(result.installed, ''); assert.ok(result.simulation); assert.match(result.stderr, /preparation was skipped/);
  }
});

test('a declared, absent wireless-regdb dependency is version-pinned alongside the exact kernel module', async t => {
  for (const dependencyStatus of ['absent', 'not-installed']) {
    const result = await run(t, 'eligible', { dependency: true, dependencyStatus }); unchanged(result);
    assert.equal(result.stderr, ''); assert.equal(result.audit, 'audit'); assert.equal(result.dependencyQuery, 'query');
    assert.match(result.installed, /install -y linux-modules-extra-6\.8\.0-134-generic=6\.8\.0-134\.134 wireless-regdb=2026\.05\.30-0ubuntu1~24\.04\.1/);
    assert.match(result.cache, /show linux-modules-extra-6\.8\.0-134-generic=6\.8\.0-134\.134/);
    assert.match(result.cache, /policy wireless-regdb/);
  }
});

test('an installed wireless-regdb stays untouched and any proposed upgrade or mismatched fresh version is rejected', async t => {
  const installed = await run(t, 'eligible', { dependency: true, dependencyStatus: 'installed' }); unchanged(installed);
  assert.ok(installed.installed); assert.doesNotMatch(installed.installed, /wireless-regdb/); assert.doesNotMatch(installed.cache, /policy wireless-regdb/);
  for (const [scenario, values] of [['dependency-upgrade', { dependency: true, dependencyStatus: 'installed' }], ['dependency-version-mismatch', { dependency: true }], ['dependency-conf-only', { dependency: true }]]) {
    const result = await run(t, scenario, values); unchanged(result); assert.equal(result.installed, ''); assert.ok(result.simulation); assert.match(result.stderr, /preparation was skipped/);
  }
});

test('dirty package transactions, uncertain dependency state and unavailable exact metadata skip all apt writes', async t => {
  for (const [scenario, values] of [['dirty-dpkg', {}], ['audit-fails', {}], ['metadata-fails', {}], ['eligible', { dependency: true, dependencyStatus: 'residual' }], ['eligible', { dependency: true, dependencyStatus: 'unknown' }], ['eligible', { dependency: true, dependencyCandidate: '(none)' }]]) {
    const result = await run(t, scenario, values); unchanged(result); assert.equal(result.installed, ''); assert.equal(result.simulation, ''); assert.match(result.stderr, /preparation was skipped/);
  }
});

test('failed package installation or unavailable post-install module never enables memory assistance or fails the working service install', async t => {
  for (const scenario of ['install-fails', 'still-unavailable']) {
    const result = await run(t, scenario); unchanged(result); assert.ok(result.installed); assert.match(result.stderr, /preparation failed|still unavailable/);
  }
});
