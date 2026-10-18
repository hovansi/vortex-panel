import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const source = (await fs.readFile(new URL('../deploy/install.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
function block(name) {
  const marker = `# BEGIN ${name}\n`;
  const start = source.indexOf(marker);
  const end = source.indexOf(`# END ${name}`, start);
  assert.ok(start >= 0 && end > start, `Actual ${name} installer block exists`);
  return source.slice(start + marker.length, end);
}
const options = block('installer options');
const accessPlan = block('automatic access plan');
const adminReceipt = block('first admin receipt');
const transactionLock = block('installer transaction lock');
const lockDefinitions = transactionLock.replace(/^acquire_installer_lock \/run\/vortex-panel-install\.lock\s*$/m, '');
assert.ok(!lockDefinitions.includes('\nacquire_installer_lock /run/'), 'Only the fixed OS lock path is replaced at the test boundary');
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
const CURRENT_TOKEN = 'Current_Invocation_Setup_Token_01';
const OLD_TOKEN = 'Old_Invocation_Setup_Token_999';
const INVOCATION = 'a'.repeat(32);

const scaffold = String.raw`set -Eeuo pipefail
WORK_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
SOURCE_DIR="$WORK_DIR/source with spaces"
RECOVERY_DIR="$WORK_DIR/recovery"
DATA_DIR="$WORK_DIR/data"
CURRENT_EXISTED=false
SS_READY=true
mkdir -p "$SOURCE_DIR/deploy" "$RECOVERY_DIR" "$DATA_DIR"
printf 'unrelated customer bytes' > "$WORK_DIR/customer-marker"
case $FIXTURE_SCENARIO in
  current) CURRENT_EXISTED=true;;
  environment) printf 'HOST=127.0.0.1\n' > "$RECOVERY_DIR/environment";;
  service) printf 'User=bedrock-panel\n' > "$RECOVERY_DIR/service";;
  panel-data) printf '{}' > "$DATA_DIR/panel.json";;
  no-ss) SS_READY=false;;
esac
command() {
  if [[ $1 == -v && $2 == ss ]]; then [[ $SS_READY == true ]];
  elif [[ $1 == -v && $2 == python3 ]]; then [[ $FIXTURE_SCENARIO != no-python ]];
  else builtin command "$@"; fi
}
apt-get() {
  printf 'apt' >> "$WORK_DIR/events"
  printf '|%s' "$@" >> "$WORK_DIR/events"
  printf '\n' >> "$WORK_DIR/events"
  [[ $1 == update ]] && return 0
  [[ $* == 'install -y --no-install-recommends --no-remove iproute2' ]] || return 91
  [[ $DEBIAN_FRONTEND == noninteractive && $NEEDRESTART_MODE == l && $NEEDRESTART_SUSPEND == 1 ]] || return 92
  SS_READY=true
}
python3() {
  printf 'helper\n' >> "$WORK_DIR/events"
  printf '%s\0' "$@" > "$WORK_DIR/helper-args"
  [[ $1 == "$SOURCE_DIR/deploy/configure-access.py" && $2 == preflight && $3 == --plan && $4 == "$RECOVERY_DIR/public-access.json" ]] || return 93
  [[ $SS_READY == true ]] || return 94
  [[ $FIXTURE_SCENARIO != helper-fails ]] || return 24
  printf 'preflight fixture passed\n'
}
sleep() { :; }
`;

async function probe(body, { args = [], scenario = 'fresh', adminScenario = 'current', lockScenario = 'normal' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-installer-auto-'));
  try {
    const script = path.join(directory, 'probe.sh');
    await fs.writeFile(script, scaffold + '\n' + body);
    const result = spawnSync(bash, [script.replaceAll('\\', '/'), ...args], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...process.env, BASH_ENV: '', FIXTURE_SCENARIO: scenario, ADMIN_SCENARIO: adminScenario,
        FIXTURE_CURRENT_TOKEN: CURRENT_TOKEN, FIXTURE_OLD_TOKEN: OLD_TOKEN, LOCK_SCENARIO: lockScenario,
        LOCK_BOUNDARY_PLATFORM: process.platform },
    });
    const read = name => fs.readFile(path.join(directory, name), 'utf8').catch(() => '');
    const values = await Promise.all(['events', 'helper-args', 'journal-args', 'systemctl-args', 'customer-marker'].map(read));
    return { ...result, events: values[0], helperArgs: values[1].split('\0').filter(Boolean),
      journalArgs: values[2].split('\0').filter(Boolean), systemctlArgs: values[3], marker: values[4],
      lockBytes: await read('lock-root/vortex-panel-install.lock'), lockTarget: await read('lock-root/customer-target') };
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('vortex-installer-auto-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function accessProbe(settings) {
  return probe(options + '\nparse_installer_options "$@"\n' + accessPlan +
    '\nprintf "STATE|%s|%s|%s|%s\\n" "$MODE" "$FRESH_INSTALL" "$VORTEX_AUTO_ACCESS" "$VORTEX_MODE_EXPLICIT"\n', settings);
}

test('Installer options reject malformed/conflicting arguments before any prerequisites', async () => {
  for (const args of [['--unknown'], ['--root-mode', '--service-user'], ['--public-ip'],
    ['--public-ip', 'https://example.com'], ['--public-ip', '999.1.1.1'],
    ['--public-ip', '008.1.1.1'], ['--local-only', '--public-ip', '8.8.4.4'],
    ['--public-ip', '8.8.4.4', '--local-only'], ['--local-only', '--local-only']]) {
    const result = await accessProbe({ args });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.events, '', args.join(' '));
    assert.equal(result.helperArgs.length, 0);
    assert.equal(result.marker, 'unrelated customer bytes');
  }
});

test('Fresh no-flags installation chooses root and executes exact preflight arguments', async () => {
  const result = await accessProbe();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /STATE\|root\|true\|true\|false/);
  assert.equal(result.events, 'helper\n');
  assert.equal(result.helperArgs.length, 4);
  assert.ok(result.helperArgs[0].endsWith('/source with spaces/deploy/configure-access.py'));
  assert.equal(result.helperArgs[1], 'preflight');
  assert.equal(result.helperArgs[2], '--plan');
  assert.ok(result.helperArgs[3].endsWith('/recovery/public-access.json'));
});

test('Fresh public-IP override is forwarded as one separate argument without shell evaluation', async () => {
  const result = await accessProbe({ args: ['--public-ip', '8.8.4.4'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.helperArgs.slice(4), ['--public-ip', '8.8.4.4']);
  assert.match(result.stdout, /STATE\|root\|true\|true\|false/);
});

test('Local-only fresh installation skips access setup while retaining its explicit service mode', async () => {
  for (const [args, mode, explicit] of [[['--local-only'], 'root', false],
    [['--service-user', '--local-only'], 'service', true]]) {
    const result = await accessProbe({ args });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.events, '');
    assert.match(result.stdout, new RegExp(`STATE\\|${mode}\\|true\\|false\\|${explicit}`));
  }
});

test('Explicit fresh service-user mode survives automatic HTTPS planning', async () => {
  const result = await accessProbe({ args: ['--service-user'] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /STATE\|service\|true\|true\|true/);
  assert.equal(result.events, 'helper\n');
});

test('Each independent existing-install marker preserves mode and skips public setup', async () => {
  for (const scenario of ['current', 'environment', 'service', 'panel-data']) {
    const result = await accessProbe({ scenario });
    assert.equal(result.status, 0, scenario + ': ' + result.stderr);
    assert.match(result.stdout, /STATE\|preserve\|false\|false\|false/);
    assert.equal(result.events, '');
  }
});

test('Access flags on every existing-install marker fail before dependency or helper actions', async () => {
  for (const scenario of ['current', 'environment', 'service', 'panel-data']) {
    for (const args of [['--local-only'], ['--public-ip', '8.8.4.4']]) {
      const result = await accessProbe({ scenario, args });
      assert.notEqual(result.status, 0, scenario + ' ' + args.join(' '));
      assert.match(result.stderr, /existing installation keeps its access/);
      assert.equal(result.events, '');
    }
  }
});

test('Missing ss installs only iproute2 before executing public preflight', async () => {
  const result = await accessProbe({ scenario: 'no-ss' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.events, 'apt|update\napt|install|-y|--no-install-recommends|--no-remove|iproute2\nhelper\n');
  assert.match(result.stdout, /STATE\|root\|true\|true\|false/);
});

test('A missing Python prerequisite or failed preflight cannot continue installation planning', async () => {
  const missing = await accessProbe({ scenario: 'no-python' });
  assert.notEqual(missing.status, 0);
  assert.equal(missing.events, '');
  assert.doesNotMatch(missing.stdout, /STATE/);
  const failure = await accessProbe({ scenario: 'helper-fails' });
  assert.equal(failure.status, 24);
  assert.equal(failure.events, 'helper\n');
  assert.doesNotMatch(failure.stdout, /STATE/);
});

const receiptBoundary = String.raw`
next_count() {
  local value=0
  [[ ! -f "$WORK_DIR/$1-count" ]] || value=$(cat "$WORK_DIR/$1-count")
  value=$((value + 1))
  printf '%s\n' "$value" > "$WORK_DIR/$1-count"
  printf '%s' "$value"
}
systemctl() {
  printf '%s|' "$@" >> "$WORK_DIR/systemctl-args"
  printf '\n' >> "$WORK_DIR/systemctl-args"
  if [[ $1 == is-active ]]; then [[ $ADMIN_SCENARIO != stopped ]]; return; fi
  [[ $1 == show && $2 == --property && $4 == --value && $5 == bedrock-panel ]] || return 95
  local count
  count=$(next_count "$3")
  case $3 in
    MainPID)
      if [[ $ADMIN_SCENARIO == pid-changes && $((count % 2)) == 0 ]]; then printf '778\n'; else printf '777\n'; fi;;
    InvocationID)
      if [[ $ADMIN_SCENARIO == invocation-changes && $((count % 2)) == 0 || $ADMIN_SCENARIO == reused-pid ]]; then
        printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
      elif [[ $ADMIN_SCENARIO == malformed-invocation ]]; then printf 'not-a-systemd-invocation\n'
      else printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'; fi;;
    *) return 96;;
  esac
}
journalctl() {
  printf '%s\0' "$@" __CALL_END__ >> "$WORK_DIR/journal-args"
  local wanted=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  if [[ $ADMIN_SCENARIO == reused-pid ]]; then wanted=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; fi
  if [[ $* != "-b -u bedrock-panel _PID=777 _SYSTEMD_INVOCATION_ID=$wanted -n 100 --no-pager -o cat" ]]; then
    printf 'SETUP TOKEN: %s\n' "$FIXTURE_OLD_TOKEN"
    return 0
  fi
  case $ADMIN_SCENARIO in
    old-only) :;;
    malformed-token) printf 'SETUP TOKEN: short\nSETUP TOKEN: invalid token with spaces\n';;
    journal-fails) return 33;;
    *) printf 'SETUP TOKEN: %s\n' "$FIXTURE_CURRENT_TOKEN";;
  esac
}
`;

async function receiptProbe(adminScenario = 'current', fresh = true) {
  return probe(receiptBoundary + '\nFRESH_INSTALL=' + String(fresh) + '\n' + adminReceipt,
    { adminScenario });
}

test('Fresh Admin setup output requires current boot, service PID and invocation filters', async () => {
  const result = await receiptProbe();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('One-time setup token: ' + CURRENT_TOKEN));
  assert.doesNotMatch(result.stdout, new RegExp(OLD_TOKEN));
  assert.deepEqual(result.journalArgs, ['-b', '-u', 'bedrock-panel', '_PID=777',
    '_SYSTEMD_INVOCATION_ID=' + INVOCATION, '-n', '100', '--no-pager', '-o', 'cat', '__CALL_END__']);
});

test('Reused PID selects only the new systemd invocation setup token', async () => {
  const result = await receiptProbe('reused-pid');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(CURRENT_TOKEN));
  assert.ok(result.journalArgs.includes('_SYSTEMD_INVOCATION_ID=' + 'b'.repeat(32)));
  assert.doesNotMatch(result.stdout, new RegExp(OLD_TOKEN));
});

test('Restarting PID or invocation and inactive service never expose a candidate setup token', async () => {
  for (const scenario of ['pid-changes', 'invocation-changes', 'stopped']) {
    const result = await receiptProbe(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(CURRENT_TOKEN + '|' + OLD_TOKEN));
    assert.match(result.stdout, /If setup is pending/);
  }
});

test('Old-only, failed journal and malformed token/invocation states never expose stale credentials', async () => {
  for (const scenario of ['old-only', 'journal-fails', 'malformed-token', 'malformed-invocation']) {
    const result = await receiptProbe(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(CURRENT_TOKEN + '|' + OLD_TOKEN));
    assert.match(result.stdout, /If setup is pending/);
    if (scenario === 'malformed-invocation') assert.equal(result.journalArgs.length, 0);
  }
});

test('Existing installation never reads or prints a setup token from its journal', async () => {
  const result = await receiptProbe('current', false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.journalArgs.length, 0);
  assert.equal(result.systemctlArgs, '');
  assert.doesNotMatch(result.stdout, new RegExp(CURRENT_TOKEN + '|' + OLD_TOKEN));
});

// Git for Windows does not ship flock or Linux /proc descriptor metadata. Only
// those OS boundaries are modeled there. On Linux this same transaction invokes
// the real flock executable and checks real descriptor/inode/mode/link metadata;
// the fixture's current UID is mapped to production UID 0 for non-root CI jobs.
const lockBoundary = String.raw`
export LOCK_TEST_PATH="$WORK_DIR/lock-root/vortex-panel-install.lock"
export WORK_DIR
mkdir -p "$WORK_DIR/lock-root"
chmod 700 "$WORK_DIR/lock-root"
command() {
  if [[ $1 == -v && $2 == flock && $LOCK_SCENARIO == missing-flock ]]; then return 1; fi
  builtin command "$@"
}
if [[ $LOCK_BOUNDARY_PLATFORM == win32 ]]; then
  flock() {
    [[ $1 == -n && $2 =~ ^[0-9]+$ ]] || return 97
    [[ $FIXTURE_LOCK_BUSY != true ]]
  }
fi
stat() {
  local inspected argument output uid links mode device inode
  for argument in "$@"; do inspected=$argument; done
  if [[ $LOCK_BOUNDARY_PLATFORM == win32 && $inspected == /proc/*/fd/* ]]; then
    output=$(builtin command stat -c '%u:%h:%a:%d:%i' -- "$LOCK_TEST_PATH")
  else output=$(builtin command stat "$@"); fi
  if [[ $* == *'%u:%h:%a:%d:%i'* ]]; then
    IFS=: read -r uid links mode device inode <<< "$output"
    uid=0
    if [[ $LOCK_BOUNDARY_PLATFORM == win32 ]]; then mode=600; fi
    if [[ $LOCK_SCENARIO == wrong-owner ]]; then uid=1234; fi
    if [[ $LOCK_SCENARIO == wrong-mode ]]; then mode=644; fi
    printf '%s:%s:%s:%s:%s\n' "$uid" "$links" "$mode" "$device" "$inode"
  elif [[ $* == *'%u:%a'* ]]; then
    IFS=: read -r uid mode <<< "$output"
    if [[ $LOCK_BOUNDARY_PLATFORM == win32 ]]; then mode=700; fi
    if [[ $LOCK_SCENARIO == shared-parent ]]; then mode=777; fi
    printf '0:%s\n' "$mode"
  else printf '%s\n' "$output"; fi
}
FIXTURE_LOCK_BUSY=false
export FIXTURE_LOCK_BUSY
case $LOCK_SCENARIO in
  directory) mkdir "$LOCK_TEST_PATH";;
  hardlink)
    printf 'customer lock bytes' > "$WORK_DIR/lock-root/customer-target"
    chmod 600 "$WORK_DIR/lock-root/customer-target"
    ln "$WORK_DIR/lock-root/customer-target" "$LOCK_TEST_PATH";;
  symlink)
    printf 'customer lock bytes' > "$WORK_DIR/lock-root/customer-target"
    ln -s "$WORK_DIR/lock-root/customer-target" "$LOCK_TEST_PATH";;
  wrong-owner|wrong-mode)
    printf 'customer lock bytes' > "$LOCK_TEST_PATH"
    chmod 600 "$LOCK_TEST_PATH";;
esac
`;

test('Transaction lock is acquired before every installer snapshot and mutation', () => {
  assert.ok(source.indexOf('# BEGIN installer transaction lock') > source.indexOf('[[ $EUID -eq 0 ]]'));
  for (const marker of ['SOURCE_DIR=', 'RECOVERY_DIR=$(mktemp', 'CURRENT_EXISTED=false', 'apt-get update']) {
    assert.ok(source.indexOf('# END installer transaction lock') < source.indexOf(marker), marker);
  }
  assert.doesNotMatch(transactionLock.replace(/^\s*#.*$/gm, ''), /\brm\b|\bunlink\b/);
});

test('Lock prerequisite, ownership, permission, hardlink and nonregular failures preserve existing bytes', async () => {
  const scenarios = ['missing-flock', 'shared-parent', 'wrong-owner', 'wrong-mode', 'hardlink', 'directory'];
  if (process.platform !== 'win32') scenarios.push('symlink');
  for (const lockScenario of scenarios) {
    const result = await probe(lockBoundary + '\n' + lockDefinitions + '\nacquire_installer_lock "$LOCK_TEST_PATH"\nprintf "UNEXPECTED_SUCCESS\\n"\n', { lockScenario });
    assert.notEqual(result.status, 0, lockScenario + ': ' + result.stderr);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_SUCCESS/);
    assert.equal(result.events, '', 'No installation helper/package action: ' + lockScenario);
    assert.equal(result.marker, 'unrelated customer bytes');
    if (['wrong-owner', 'wrong-mode', 'hardlink', 'symlink'].includes(lockScenario)) {
      assert.equal(result.lockBytes, 'customer lock bytes', lockScenario);
    }
    if (['hardlink', 'symlink'].includes(lockScenario)) assert.equal(result.lockTarget, 'customer lock bytes');
  }
});

test('Concurrent installer is blocked until the held descriptor closes, and the same inode is reused', async () => {
  const body = lockBoundary + '\n' + lockDefinitions + String.raw`
acquire_installer_lock "$LOCK_TEST_PATH"
printf 'owned persistent lock bytes' >&"$VORTEX_INSTALL_LOCK_FD"
before=$(stat -c '%u:%h:%a:%d:%i' -- "$LOCK_TEST_PATH")
declare -f acquire_installer_lock stat command > "$WORK_DIR/lock-functions.sh"
if [[ $LOCK_BOUNDARY_PLATFORM == win32 ]]; then declare -f flock >> "$WORK_DIR/lock-functions.sh"; fi
export VORTEX_INSTALL_LOCK_FD
FIXTURE_LOCK_BUSY=true
export FIXTURE_LOCK_BUSY
if "$BASH" -c 'set -Eeuo pipefail; exec {VORTEX_INSTALL_LOCK_FD}>&-; source "$WORK_DIR/lock-functions.sh"; acquire_installer_lock "$LOCK_TEST_PATH"'; then
  echo 'Concurrent lock unexpectedly succeeded.' >&2
  exit 98
fi
printf 'CONCURRENT_BLOCKED\n'
exec {VORTEX_INSTALL_LOCK_FD}>&-
FIXTURE_LOCK_BUSY=false
export FIXTURE_LOCK_BUSY
"$BASH" -c 'set -Eeuo pipefail; exec {VORTEX_INSTALL_LOCK_FD}>&-; source "$WORK_DIR/lock-functions.sh"; acquire_installer_lock "$LOCK_TEST_PATH"; printf "REACQUIRED\n"'
after=$(stat -c '%u:%h:%a:%d:%i' -- "$LOCK_TEST_PATH")
[[ $before == "$after" ]] || { echo 'Lock inode was replaced.' >&2; exit 99; }
printf 'SAME_INODE\n'
`;
  const result = await probe(body);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CONCURRENT_BLOCKED/);
  assert.match(result.stdout, /REACQUIRED/);
  assert.match(result.stdout, /SAME_INODE/);
  assert.match(result.stderr, /Another Vortex Panel installation is in progress/);
  assert.equal(result.lockBytes, 'owned persistent lock bytes');
});
