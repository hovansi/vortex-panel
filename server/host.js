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
const location = createHostLocation({ enabled: process.platform === 'linux' && process.env.VORTEX_GEOLOCATION !== 'off' });
export async function getHostInfo(dataDir = process.env.DATA_DIR || path.resolve('data')) {
  const key = path.resolve(dataDir);
  if (!samplers.has(key)) { if (samplers.size >= 32) samplers.delete(samplers.keys().next().value); samplers.set(key, createHostSampler({ location: () => location.snapshot() })); }
  return samplers.get(key)(key);
}
// Decode each pipe across chunk boundaries; a Unicode character need not arrive
// in one OS read. Dependencies remain internal process boundaries, never API input.
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
export function createHostRouter({ store, dataDir, powerController, zramController, panelRemovalController, panelUpdateController, timezoneController, networkController, tlsController, reauthenticateAdmin, manager }) {
  const router = express.Router();
  const enabled = process.platform === 'linux' && process.env.ALLOW_HOST_TERMINAL === 'true';
  const info = async () => ({ ...await getHostInfo(dataDir), systemTimezone: timezoneController?.current?.()?.timezone || null });
  let running = false;
  let diagnosticsCache;
  let diagnosticsFlight;
  const scrubSSH = input => { for (const row of [...(Array.isArray(input?.ssh)?input.ssh:[input?.ssh]),...(Array.isArray(input?.connections)?input.connections.map(row=>row?.ssh):[])]) if (row && typeof row === 'object') for (const key of ['password', 'privateKey', 'passphrase']) delete row[key]; };
  if (timezoneController) {
    router.get('/timezone', async (_req, res) => res.json({ nodeId: 'local', timezone: await timezoneController.read() }));
    router.post('/timezone', async (req, res) => {
      const perform = () => timezoneController.request(req.body, { user: req.session.user });
      res.json(await (manager?.withHostOperation ? manager.withHostOperation(perform) : perform()));
    });
  }
  if (networkController) {
    router.get('/network', async (_req, res) => res.json({ network: await networkController.read() }));
    router.post('/network', async (req, res) => res.json(await networkController.request(req.body, { user: req.session.user })));
  }
  if (tlsController) {
    router.get('/tls', async (_req, res) => res.json({ tls: await tlsController.read() }));
    router.get('/tls/jobs/:id', async (req, res) => res.json({ job: await tlsController.job(req.params.id) }));
    for (const action of ['start', 'recover']) router.post(action === 'start' ? '/tls' : '/tls/recover', async (req, res) => {
      const input = { ...(req.body || {}) }, password = input.adminPassword; delete input.adminPassword;
      if (req.body && typeof req.body === 'object') delete req.body.adminPassword;
      await reauthenticateAdmin(req, password);
      res.status(202).json(await tlsController[action](input, req.session.user));
    });
  }
  if(panelUpdateController){
    router.get('/update',async(req,res)=>res.json(await panelUpdateController.plan({refresh:req.query.refresh==='true'})));
    router.get('/update/jobs',(_req,res)=>res.json({jobs:panelUpdateController.jobs()}));
    router.get('/update/jobs/:id',async(req,res)=>res.json({job:await panelUpdateController.job(req.params.id)}));
    router.post('/update',async(req,res)=>{
      const input=req.body||{},adminPassword=input.adminPassword;delete input.adminPassword;
      try{await reauthenticateAdmin(req,adminPassword);res.status(202).json({job:await panelUpdateController.start(input,req.session.user)});}finally{scrubSSH(input);}
    });
    router.post('/update/recover',async(req,res)=>{
      const input=req.body||{},adminPassword=input.adminPassword;delete input.adminPassword;
      try{await reauthenticateAdmin(req,adminPassword);res.status(202).json({job:await panelUpdateController.recover(input,req.session.user)});}finally{scrubSSH(input);}
    });
  }
  router.get('/uninstall', async (_req, res) => res.json(await panelRemovalController.plan()));
  router.get('/uninstall/jobs', (_req, res) => res.json({ jobs: panelRemovalController.jobs() }));
  router.get('/uninstall/jobs/:id', (req, res) => {
    const job = panelRemovalController.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Uninstall operation was not found.' });
    res.json({ job });
  });
  router.post('/uninstall/check', async (req, res) => {
    try { res.json(await panelRemovalController.check(req.body, req.session.user)); }
    finally { scrubSSH(req.body); }
  });
  router.post('/uninstall', async (req, res) => {
    const input = req.body || {}, adminPassword = input.adminPassword;
    delete input.adminPassword;
    try {
      await reauthenticateAdmin(req, adminPassword);
      res.status(202).json({ job: await panelRemovalController.start(input, req.session.user) });
    } finally { scrubSSH(input); }
  });
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
  router.get('/info', async (_req, res) => res.json({ host: await info(), capabilities: { linux: process.platform === 'linux', hostTerminal: enabled, root: process.getuid?.() === 0 } }));
  router.get('/diagnostics', async (_req, res) => {
    if (!diagnosticsCache || Date.now() - Date.parse(diagnosticsCache.generatedAt) > 10000) {
      diagnosticsFlight ||= collectDiagnostics({ dataDir, host: await info() }).then(value => { diagnosticsCache = value; return value; }).finally(() => { diagnosticsFlight = null; });
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
