import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const source = await fs.readFile(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const helper = source.match(/# BEGIN ownership helper\n([\s\S]+?)# END ownership helper/)[1];
const rollbackStart = source.indexOf('\nrollback() {');
const rollback = source.slice(rollbackStart, source.indexOf('\ntrap cleanup EXIT', rollbackStart));
const identityStart = source.indexOf('\nSERVICE_USER=bedrock-panel\n');
const identity = source.slice(identityStart, source.indexOf('\ninstall -d -m 0755 "$INSTALL_DIR"', identityStart));
const phaseStart = source.indexOf('\nCHANGED_SERVICE=true\n');
const applyPhase = source.slice(phaseStart, source.indexOf('\nif [[ ! -f /etc/bedrock-panel.env ]]', phaseStart));
assert.ok(helper && rollbackStart > 0 && identityStart > 0 && applyPhase.includes('apply_tree_ownership'), 'Actual installer ownership and rollback blocks exist');
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';

// Execute the installer blocks, with OS ownership/immutable/systemctl effects
// modeled explicitly. Real Linux chattr/chown evidence is recorded separately.
async function run(body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-install-owner-test-'));
  try {
    const script = path.join(directory, 'probe.sh');
    await fs.writeFile(script, `set -Eeuo pipefail
WORK_DIR=$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd -P)
export TMPDIR=$WORK_DIR
DATA_DIR=$WORK_DIR/data
RECOVERY_DIR=$WORK_DIR/recovery
INSTALL_ROOT=$WORK_DIR/install
mkdir -p "$DATA_DIR" "$RECOVERY_DIR" "$INSTALL_ROOT"
printf 'User=root\\nGroup=root\\n' > "$RECOVERY_DIR/service"
printf 'HOST=127.0.0.1\\n' > "$RECOVERY_DIR/environment"
printf 'unchanged immutable bytes' > "$DATA_DIR/immutable.bin"
printf 'unchanged mutable bytes' > "$DATA_DIR/mutable.bin"
declare -A owners
paths=("$DATA_DIR" "$DATA_DIR/mutable.bin" "$DATA_DIR/immutable.bin")
for entry in "\${paths[@]}"; do owners["$entry"]=0:0; done
id() { if [[ \${1:-} == -u ]]; then case \${3:-} in root) printf '0\\n';; bedrock-panel) printf '4242\\n';; *) return 1;; esac; else return 0; fi; }
getent() { case $2 in root) printf 'root:x:0:\\n';; bedrock-panel) printf 'bedrock-panel:x:4242:\\n';; *) return 1;; esac; }
find() {
  [[ $1 == -P && $2 == "$DATA_DIR" && ( \${12} == -print0 || \${12} == -printf ) ]] || { echo 'Incorrect no-follow traversal.' >&2; return 1; }
  local wanted=\${6}:\${10}
  for entry in "\${paths[@]}"; do
    [[ \${owners[$entry]} != "$wanted" ]] || continue
    if [[ \${12} == -printf ]]; then printf '%s\\0%s\\0' "\${owners[$entry]}" "$entry"; else printf '%s\\0' "$entry"; fi
  done
}
stat() { local entry=\${!#}; printf '%s\\n' "\${owners[$entry]}"; }
chown() {
  [[ $1 == -h && $2 == --from=* && $3 == -- ]] || { echo 'Unsafe chown flags.' >&2; return 1; }
  local observed=\${2#--from=} wanted=$4 entry failed=0
  shift 4
  for entry in "$@"; do
    [[ \${owners[$entry]} == "$observed" ]] || continue
    printf '%s|%s\\n' "$wanted" "$entry" >> "$WORK_DIR/chown-log"
    if [[ $entry == "$DATA_DIR/immutable.bin" ]]; then echo 'Operation not permitted (modeled immutable file)' >&2; failed=1; else owners["$entry"]=$wanted; fi
  done
  return "$failed"
}
systemctl() {
  printf '%s\\n' "$*" >> "$WORK_DIR/systemctl-log"
  if [[ $1 == start ]]; then
    for entry in "\${paths[@]}"; do [[ \${owners[$entry]} == 0:0 ]] || { echo 'Prior service started before ownership recovery.' >&2; return 1; }; done
    printf 'prior owner restored\\n' > "$WORK_DIR/restarted"
  fi
}
cp() { :; }
ln() { :; }
mv() { :; }
${helper}
${rollback}
${body}
`);
    const result = spawnSync(bash, [script.replaceAll('\\', '/')], { encoding: 'utf8', timeout: 20000 });
    const read = name => fs.readFile(path.join(directory, name), 'utf8').catch(() => '');
    return { ...result, chowns: await read('chown-log'), service: await read('systemctl-log'), restarted: await read('restarted'), immutable: await fs.readFile(path.join(directory, 'data/immutable.bin'), 'utf8'), mutable: await fs.readFile(path.join(directory, 'data/mutable.bin'), 'utf8') };
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('vortex-install-owner-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('root-mode upgrade never chowns correct-owner immutable data through an intermediate service user', async () => {
  const result = await run(`MODE=root
PREVIOUS_ACTIVE=false
${identity}
${applyPhase}
[[ $SERVICE_USER == root ]]
printf 'root ownership unchanged\\n'
`);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.chowns, '', 'No ownership syscall is attempted on already-correct entries');
  assert.equal(result.stdout.trim(), 'root ownership unchanged');
  assert.equal(result.immutable, 'unchanged immutable bytes');
});

test('failed candidate owner change rolls back mutable entries, skips prior-owner immutable entry, and restarts prior service', async () => {
  const result = await run(`MODE=service
PREVIOUS_ACTIVE=true
PREVIOUS_ENABLED=true
CURRENT_EXISTED=true
PREVIOUS_LINK=previous-release
${identity}
trap 'rollback "$LINENO"' ERR
${applyPhase}
echo 'Candidate must never reach this line.'
`);
  assert.equal(result.status, 1, result.stderr || result.error?.message);
  assert.match(result.stderr, /Operation not permitted/);
  assert.match(result.service, /start bedrock-panel/);
  assert.equal(result.restarted.trim(), 'prior owner restored');
  assert.equal((result.chowns.match(/immutable\.bin/g) || []).length, 1, 'Only the failed candidate target touches immutable bytes; rollback sees matching prior owner and skips it');
  assert.equal(result.immutable, 'unchanged immutable bytes');
  assert.equal(result.mutable, 'unchanged mutable bytes');
});

test('ownership enumeration failure performs no partial chown and returns a clear error', async () => {
  const result = await run(`find() { printf '%s\\0' "$DATA_DIR/mutable.bin"; return 1; }
if apply_tree_ownership bedrock-panel bedrock-panel "$DATA_DIR"; then echo 'Incorrect success.'; exit 2; fi
printf 'failed before chown\\n'
`);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.chowns, '');
  assert.match(result.stderr, /Unable to enumerate data ownership/);
  assert.equal(result.stdout.trim(), 'failed before chown');
});
