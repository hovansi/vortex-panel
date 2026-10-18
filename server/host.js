import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import express from 'express';
import { collectDiagnostics } from './diagnostics.js';
import { createHostSampler } from './host-telemetry.js';
import { createHostLocation } from './host-location.js';
import { sendPowerRequest } from './system-power.js';
import { sendZramRequest, validateZramRequest } from './host-zram.js';

const samplers = new Map();
const location = createHostLocation({ enabled: process.platform === 'linux' && process.env.VORTEX_GEOLOCATION !== 'off' && !process.env.NODE_TEST_CONTEXT });
export async function getHostInfo(dataDir = process.env.DATA_DIR || path.resolve('data')) {
  const key = path.resolve(dataDir);
  if (!samplers.has(key)) { if (samplers.size >= 32) samplers.delete(samplers.keys().next().value); samplers.set(key, createHostSampler({ location: () => location.snapshot() })); }
  return samplers.get(key)(key);
}
// Decode each pipe across chunk boundaries; a Unicode character need not arrive
// in one OS read. Dependencies here are trusted test boundaries, never API input.
export function runHostTerminal(command, { cwd, spawnProcess = spawn, killGroup = pid => process.kill(-pid, 'SIGKILL'), timeoutMs = 15000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    const child = spawnProcess('/bin/bash', ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let stdout = '', stderr = '', size = 0, timedOut = false, settled = false;
    const kill = () => { try { killGroup(child.pid); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const capture = key => chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) { kill(); return; }
      const text = decoders[key].write(chunk);
      if (key === 'stdout') stdout += text; else stderr += text;
    };
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    const finish = exitCode => {
      if (settled) return; settled = true; clearTimeout(timer);
      stdout += decoders.stdout.end(); stderr += decoders.stderr.end(); kill();
      resolve({ stdout, stderr, exitCode, timedOut, truncated: size > maxBytes });
    };
    child.on('error', error => { stderr += error.message; finish(-1); });
    child.on('close', code => finish(code ?? -1));
  });
}
export function createHostRouter({ store, dataDir, demo, powerController, zramController, reauthenticateAdmin, manager }) {
  const router = express.Router();
  const enabled = !demo && process.platform === 'linux' && process.env.ALLOW_HOST_TERMINAL === 'true';
  const info = () => demo ? Promise.resolve({ hostname: 'vortex-demo', platform: 'linux', arch: 'x64', release: 'Ubuntu 24.04 LTS', cpus: 8, cpuPercent: 14.2, memoryTotal: 16 * 1024 ** 3, memoryUsed: 3.6 * 1024 ** 3, uptime: 86412, diskTotal: 120 * 1024 ** 3, diskUsed: 24 * 1024 ** 3, load: [0.62, 0.48, 0.41], nodeVersion: 'v22.x', user: 'vortex-mc', root: false, demo: true }) : getHostInfo(dataDir);
  let running = false;
  let diagnosticsCache;
  let diagnosticsFlight;
  router.get('/power', async (_req, res) => res.json({ nodeId: 'local', power: await powerController.read() }));
  router.post('/power', async (req, res) => sendPowerRequest(powerController, req, res, 'local'));
  router.get('/zram', async (_req, res) => res.json({ nodeId: 'local', zram: await zramController.read() }));
  router.post('/zram', async (req, res) => {
    const { password, ...input } = req.body || {};
    if (req.body && typeof req.body === 'object') delete req.body.password;
    validateZramRequest(input);
    if (input.nodeId !== 'local') throw Object.assign(new Error('The selected VPS changed.'), { code: 'ZRAM_TARGET', status: 409 });
    await reauthenticateAdmin(req, password);
    req.body = input;
    return sendZramRequest(zramController, req, res, 'local');
  });
  router.get('/info', async (_req, res) => res.json({ host: await info(), capabilities: { linux: demo || process.platform === 'linux', hostTerminal: enabled, root: !demo && process.getuid?.() === 0, demo } }));
  router.get('/diagnostics', async (_req, res) => {
    if (!diagnosticsCache || Date.now() - Date.parse(diagnosticsCache.generatedAt) > 10000) {
      diagnosticsFlight ||= collectDiagnostics({ dataDir, demo, host: await info() }).then(value => { diagnosticsCache = value; return value; }).finally(() => { diagnosticsFlight = null; });
      await diagnosticsFlight;
    }
    res.json(diagnosticsCache);
  });
  router.post('/terminal', async (req, res) => {
    const run = async () => {
    if (!enabled) return res.status(403).json({ error: 'Host terminal cần Ubuntu và ALLOW_HOST_TERMINAL=true. Lệnh chạy với quyền tài khoản của dịch vụ panel.' });
    if (running) return res.status(409).json({ error: 'Một lệnh đang chạy. Chờ lệnh hoàn tất.' });
    const command = req.body.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 4096 || command.includes('\0')) return res.status(400).json({ error: 'Lệnh không hợp lệ.' });
    running = true;
    try {
      store.audit('host.terminal', command, req.session.user.username);
      const result = await runHostTerminal(command, { cwd: dataDir });
      res.json(result);
    } finally { running = false; }
    };
    return manager?.withHostOperation ? manager.withHostOperation(run) : run();
  });
  return router;
}
