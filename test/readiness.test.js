import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const source = await fs.readFile(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const start = source.indexOf('READY=false\n'), end = source.indexOf('[[ $READY == true ]]', start);
assert.ok(start >= 0 && end > start, 'Installer readiness block exists');
const block = source.slice(start, end);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
const cases = [
  { name: 'inactive managed unit despite foreign healthy Vortex response', active: 0, pid: '42', health: { ok: true, service: 'vortex-mc', processId: 43 }, ready: false },
  { name: 'active managed unit with a foreign process answering health', active: 1, pid: '42', health: { ok: true, service: 'vortex-mc', processId: 43 }, ready: false },
  { name: 'active owned Node process with valid strict JSON', active: 2, pid: '42', health: { ok: true, service: 'vortex-mc', processId: 42 }, ready: true },
  { name: 'malformed JSON even when service marker text is present', active: 1, pid: '42', raw: '{"service":"vortex-mc","processId":42,this is malformed', ready: false },
  { name: 'MainPID changes during the health request', active: 1, pid: '42', swapped: true, health: { ok: true, service: 'vortex-mc', processId: 42 }, ready: false },
  { name: 'unit becomes inactive after owned health response', active: 1, pid: '42', health: { ok: true, service: 'vortex-mc', processId: 42 }, ready: false },
  { name: 'non-numeric health processId is not coerced into an owned process', active: 1, pid: '42', health: { ok: true, service: 'vortex-mc', processId: '42' }, ready: false }
];
for (const item of cases) test('installer rejects false readiness: ' + item.name, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-readiness-test-'));
  try {
    const script = path.join(directory, 'probe.sh');
    await fs.writeFile(script, `set -Eeuo pipefail\nPANEL_CHECK_HOST=127.0.0.1\nPANEL_PORT=3000\nNODE_BIN=${quote(process.execPath.replaceAll('\\', '/'))}\nWORK_DIR=$(dirname -- "\${BASH_SOURCE[0]}")\nACTIVE_CHECKS=0\nsystemctl() {\n  if [[ $1 == show ]]; then\n    printf 'show\\n' >> "$WORK_DIR/show-count"\n    local count\n    count=$(wc -l < "$WORK_DIR/show-count")\n    if [[ ${item.swapped ? 'true' : 'false'} == true && $count -ge 2 ]]; then printf '43\\n'; else printf '%s\\n' ${quote(item.pid)}; fi\n  else ACTIVE_CHECKS=$((ACTIVE_CHECKS + 1)); [[ $ACTIVE_CHECKS -le ${item.active} ]]; fi\n}\ncurl() { printf '%s' ${quote(item.raw ?? JSON.stringify(item.health))}; }\nsleep() { :; }\n${block}\nprintf 'READY=%s\\n' "$READY"\n`);
    const result = spawnSync(bash, [script.replaceAll('\\', '/')], { encoding: 'utf8', timeout: 20000 }); assert.equal(result.status, 0, result.stderr || result.error?.message); assert.equal(result.stdout.trim(), `READY=${item.ready}`);
  } finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('vortex-readiness-test-')); await fs.rm(directory, { recursive: true, force: true }); }
});
