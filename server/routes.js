import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './safety.js';
import { canAccessServer, requireAdmin, serverPermissions } from './access.js';
import { isIdentityPath, IDENTITY_READ_PROTECTION } from './file-privacy.js';
import { createServerFirewall } from './server-firewall.js';
import { panelFirewallScope } from './panel-layout.js';

export function createRouter(manager, { dataDir, store, timezoneController } = {}) {
  const router = express.Router();
  const firewall = dataDir ? createServerFirewall({ scope: panelFirewallScope(dataDir) }) : null;
  router.use((req, res, next) => { req.body ??= {}; next(); });
  router.use((req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.session.user.role === 'viewer') return res.status(403).json({ error: 'Tài khoản viewer chỉ được xem dữ liệu.' });
    const proceed = () => manager.withFileAccess ? manager.withFileAccess(req.fileAccess, next) : next();
    if (manager.withActor) manager.withActor(req.session.user, proceed); else proceed();
  });
  router.use('/servers/:id', (req, res, next) => {
    if (!canAccessServer(req.session.user, req.params.id, !['GET', 'HEAD', 'OPTIONS'].includes(req.method))) return res.status(403).json({ error: 'Bạn không có quyền truy cập server này.' });
    // Reject Minecraft-only APIs before their handlers or multipart parsers.
    // Generic files, console, configuration and backups remain shared tools.
    if (/^\/(?:properties|players|worlds|packs|experiments|gameplay|gamerules|announcement(?:s)?|player-actions|update|versions|clone)(?:\/|$)/i.test(req.path) && ['nodejs', 'python'].includes(manager.getServer(req.params.id).kind)) {
      const errorI18n = { id: 'panel.application.bedrock-only', en: 'This operation is only available for Minecraft Bedrock servers.', vi: 'Thao tác này chỉ dành cho server Minecraft Bedrock.', params: [] };
      return res.status(409).json({ code: 'APPLICATION_KIND', error: errorI18n[req.panelLanguage === 'vi' ? 'vi' : 'en'], errorI18n });
    }
    next();
  });
  const scoped = (user, records) => records.filter(record => (!record.adminOnly || user.role === 'admin') && canAccessServer(user, record.serverId || record.id));
  const describe = (user, server) => ({ ...server, permissions: serverPermissions(user, server.id) });
  const requireIdentityRead = (req, res, next) => {
    if (isIdentityPath(req.query.path) && !canAccessServer(req.session.user, req.params.id, true)) fail(IDENTITY_READ_PROTECTION, 403);
    next();
  };
  const destination = (req, _file, cb) => Promise.resolve(manager.uploadStagingDirectory ? manager.uploadStagingDirectory(req.params.id) : os.tmpdir()).then(directory => cb(null, directory), cb);
  const upload = multer({ storage: multer.diskStorage({ destination, filename: (req, file, cb) => cb(null, `bedrock-upload-${randomUUID()}`) }), limits: { fileSize: 1024 ** 3, files: 1, fields: 4, fieldSize: 4096 } });
  const fileUpload = multer({ storage: multer.diskStorage({ destination, filename: (req, file, cb) => cb(null, `bedrock-file-${randomUUID()}`) }), limits: { fileSize: 100 * 1024 ** 2, files: 1, fields: 2 } });
  const packUpload = multer({ storage: multer.diskStorage({ destination, filename: (req, file, cb) => cb(null, `vortex-pack-${randomUUID()}`) }), limits: { fileSize: 100 * 1024 ** 2, files: 1, fields: 0 } });
  const worldUpload = multer({ storage: multer.diskStorage({ destination, filename: (req, file, cb) => cb(null, `vortex-world-${randomUUID()}`) }), limits: { fileSize: 1024 ** 3, files: 1, fields: 1, fieldSize: 4096 } });
  const multipart = parser => async (req, res, next) => {
    let release;
    try {
      const fixed = req.params.id && manager.getServer(req.params.id).storagePolicy?.mode === 'fixed';
      if (!fixed && manager.reserveDiskWorkspace) release = await manager.reserveDiskWorkspace(parser.limits.fileSize);
      const finish = () => { release?.(); release = null; };
      res.once('close', finish); res.once('finish', finish);
      parser.single('file')(req, res, async error => { if (error && req.file) await fs.rm(req.file.path, { force: true }).catch(() => {}); if (error) finish(); next(error); });
    } catch (error) { release?.(); next(error); }
  };
  const download = async (req, res, result, next) => {
    if (result.path) {
      let cleaned = false;
      const cleanup = () => { if (cleaned) return; cleaned = true; Promise.resolve(result.cleanup?.()).catch(error => console.warn(`[Vortex Panel] Export cleanup failed: ${error.message}`)); };
      if (result.cleanup) { res.once('close', cleanup); res.once('finish', cleanup); }
      if (req.aborted || res.destroyed) { cleanup(); return; }
      // Generated exports live under private dot-prefixed filenames, outside
      // the instance's editable run directory. Allow only that owned artifact.
      return res.download(result.path, result.name, result.cleanup ? { dotfiles: 'allow' } : {}, error => { cleanup(); if (error) { if (res.headersSent) res.destroy(error); else next(error); } });
    }
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`);
    res.type('application/octet-stream').send(result.content);
  };
  router.get('/dashboard', async (req, res) => {
    const data = await manager.dashboard(); const user = req.session.user; const admin = user.role === 'admin';
    const systemTimezone = timezoneController?.current?.()?.timezone || null;
    data.panelTimezone = systemTimezone;
    if (data.host) data.host = { ...data.host, systemTimezone };
    data.servers = scoped(user, data.servers).map(server => describe(user, server)); data.jobs = scoped(user, data.jobs);
    data.activity = admin ? data.activity : []; if (!admin) { data.host = null; data.history = []; }
    if (Array.isArray(data.nodes) && !admin) data.nodes = data.nodes.filter(node => data.servers.some(server => server.nodeId === node.id)).map(node => ({ id: node.id, name: node.name, publicAddress: node.publicAddress, local: node.local, online: node.online, status: node.status, stale: node.stale, lastSeen: node.lastSeen }));
    data.capabilities = { ...data.capabilities, admin, canCreate: admin, root: admin && data.capabilities.root, hostTerminal: admin && data.capabilities.hostTerminal, linux: admin && data.capabilities.linux };
    res.json(data);
  });
  router.get('/servers', (req, res) => res.json({ servers: scoped(req.session.user, manager.listServers()).map(server => describe(req.session.user, server)) }));
  router.get('/application-runtimes', requireAdmin, async (_req, res) => res.json({ applicationRuntime: await manager.applicationCapabilities({ refresh: true }) }));
  router.post('/servers', requireAdmin, async (req, res) => { const data = await manager.createServer(req.body); data.server = describe(req.session.user, data.server); res.status(201).json(data); });
  router.get('/servers/:id', (req, res) => res.json({ server: describe(req.session.user, manager.getServer(req.params.id)) }));
  const appearanceUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:6*1024**2,files:1,fields:1,fieldSize:128,parts:2}}).single('file');
  const appearanceUploads=new Set();let appearanceUploadCount=0;
  const parseAppearanceUpload=(req,res,next)=>{
    manager.getServer(req.params.id);
    if(!['icon','cover'].includes(req.params.slot))fail('Unknown appearance image slot.',400);
    if(appearanceUploadCount>=2||appearanceUploads.has(req.params.id))fail('An image upload is already in progress. Try again shortly.',409);
    appearanceUploadCount++;appearanceUploads.add(req.params.id);let released=false,processing=false;
    const release=()=>{if(released)return;released=true;appearanceUploadCount--;appearanceUploads.delete(req.params.id);};
    req.releaseAppearanceUpload=release;
    res.once('close',()=>{if(!processing)release();});
    appearanceUpload(req,res,error=>{if(error){release();return next(error);}processing=true;next();});
  };
  const appearanceResult=(req,data)=>({...data,server:describe(req.session.user,data.server||manager.getServer(req.params.id))});
  router.get('/servers/:id/appearance',async(req,res)=>res.json(appearanceResult(req,await manager.appearance(req.params.id))));
  router.patch('/servers/:id/appearance',async(req,res)=>res.json(appearanceResult(req,await manager.saveAppearance(req.params.id,req.body))));
  router.get('/servers/:id/appearance/media/:slot',async(req,res)=>{
    const media=await manager.appearanceMedia(req.params.id,req.params.slot);
    res.set({'Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff','ETag':`"${media.revision}"`}).type(media.mimeType).send(media.content);
  });
  router.post('/servers/:id/appearance/media/:slot',parseAppearanceUpload,async(req,res)=>{
    try{
      if(req.aborted||res.destroyed)fail('Image upload was interrupted.',409);
      if(!req.file||Object.keys(req.body||{}).some(key=>key!=='revision'))fail('Choose one image and its appearance revision.',400);
      res.json(appearanceResult(req,await manager.uploadAppearance(req.params.id,req.params.slot,req.file.buffer,req.file.mimetype,req.body)));
    }finally{req.releaseAppearanceUpload?.();}
  });
  router.delete('/servers/:id/appearance/media/:slot',async(req,res)=>res.json(appearanceResult(req,await manager.removeAppearance(req.params.id,req.params.slot,req.body))));
  router.get('/servers/:id/versions', (req, res) => { manager.getServer(req.params.id); res.json(manager.versions()); });
  router.patch('/servers/:id', async (req, res) => res.json(await manager.updateServer(req.params.id, req.body)));
  router.delete('/servers/:id', requireAdmin, async (req, res) => res.json(await manager.deleteServer(req.params.id)));
  router.post('/servers/:id/clone', requireAdmin, async (req, res) => { const data = await manager.cloneServer(req.params.id, req.body); data.server = describe(req.session.user, data.server); res.status(201).json(data); });
  router.post('/servers/:id/storage/grow', requireAdmin, async (req, res) => { const data = await manager.growStorage(req.params.id, req.body); data.server = describe(req.session.user, data.server); res.status(202).json(data); });
  router.get('/servers/:id/metrics', (req, res) => res.json(manager.serverHistory(req.params.id)));
  for (const action of ['start', 'stop', 'restart', 'kill']) router.post(`/servers/:id/${action}`, async (req, res) => res.json(await manager.action(req.params.id, action)));
  router.post('/servers/:id/command', (req, res) => res.json(manager.command(req.params.id, req.body.command)));
  router.post('/servers/:id/announcement', (req, res) => res.json(manager.announcement(req.params.id, req.body)));
  router.get('/servers/:id/gameplay', async (req, res) => { const data = await manager.gameplay(req.params.id); data.server = describe(req.session.user, data.server); data.queryAvailable = data.queryAvailable && canAccessServer(req.session.user, req.params.id, true); res.json(data); });
  router.post('/servers/:id/gamerules/query', async (req, res) => res.json(await manager.queryGameRules(req.params.id, req.body)));
  router.patch('/servers/:id/gamerules', async (req, res) => res.json(await manager.changeGameRules(req.params.id, req.body)));
  router.post('/servers/:id/player-actions', async (req, res) => res.json(await manager.playerAction(req.params.id, req.body)));
  router.get('/servers/:id/logs', (req, res) => res.json({ logs: manager.logs(req.params.id), ...manager.consoleState?.(req.params.id) }));
  router.get('/servers/:id/properties', async (req, res) => res.json({ properties: await manager.properties(req.params.id) }));
  router.put('/servers/:id/properties', async (req, res) => res.json(await manager.saveProperties(req.params.id, req.body.properties)));
  router.get('/servers/:id/configuration', async (req, res) => { const data = await manager.configuration(req.params.id); data.server = describe(req.session.user, data.server); res.json(data); });
  router.patch('/servers/:id/configuration', async (req, res) => { const data = await manager.saveConfiguration(req.params.id, req.body); data.server = describe(req.session.user, data.server); res.json(data); });
  router.get('/servers/:id/application', async (req, res) => { const data = await manager.application(req.params.id); data.server = describe(req.session.user, data.server); res.json(data); });
  router.patch('/servers/:id/application', async (req, res) => { const data = await manager.saveApplication(req.params.id, req.body); data.server = describe(req.session.user, data.server); res.json(data); });
  router.post('/servers/:id/dependencies', async (req, res) => res.status(202).json({ job: await manager.installApplicationDependencies(req.params.id, req.body) }));
  router.get('/servers/:id/network-access', requireAdmin, async (req, res) => {
    if (!firewall) throw Object.assign(new Error('FIREWALL_CONTEXT'), { code: 'FIREWALL_CONTEXT', status: 409 });
    res.json(await firewall.inspect(manager.getServer(req.params.id)));
  });
  const changeNetworkAccess = async (req, res) => {
    if (!firewall) throw Object.assign(new Error('FIREWALL_CONTEXT'), { code: 'FIREWALL_CONTEXT', status: 409 });
    const current = manager.getServer(req.params.id);
    const operation = req.method === 'DELETE' ? 'remove' : 'apply';
    const apply = () => firewall[operation](current, req.body, () => manager.getServer(req.params.id));
    const result = await (manager.withHostOperation ? manager.withHostOperation(apply) : apply());
    if (store && (result.added?.length || result.removed?.length || result.errors?.length)) {
      try {
        const counts = [result.added?.length || 0, result.removed?.length || 0, result.errors?.length || 0];
        const en = `${current.name}: firewall rules added ${counts[0]}, removed ${counts[1]}, errors ${counts[2]}.`;
        const vi = `${current.name}: quy tắc firewall thêm ${counts[0]}, xóa ${counts[1]}, lỗi ${counts[2]}.`;
        store.audit(`server.firewall.${operation}`, en, req.session.user.username, { id: 'panel.audit.firewall.apply', en, vi, params: [] }, current.id);
        result.auditRecorded = true;
      } catch {
        const en = 'Firewall changes were observed, but their audit record could not be saved.';
        const vi = 'Đã quan sát thay đổi firewall nhưng chưa lưu được nhật ký thao tác.';
        result.warningsI18n = [...(result.warningsI18n || (result.warnings || []).map(() => null)), { id: 'panel.firewall.audit.failed', en, vi, params: [] }];
        result.warnings = [...(result.warnings || []), en]; result.auditRecorded = false;
      }
    }
    res.json(result);
  };
  router.post('/servers/:id/network-access', requireAdmin, changeNetworkAccess);
  router.delete('/servers/:id/network-access', requireAdmin, changeNetworkAccess);
  router.get('/servers/:id/files', async (req, res) => {
    const data = await manager.files(req.params.id, req.query.path || '');
    if (!canAccessServer(req.session.user, req.params.id, true)) for (const file of data.files) {
      for (const key of ['edit', 'copy', 'move', 'rename', 'delete', 'compress', 'extract']) file.capabilities[key] = false;
      if (isIdentityPath(file.path)) { file.capabilities.read = false; file.capabilities.download = false; file.protected = true; file.protection = IDENTITY_READ_PROTECTION; }
    }
    res.json(data);
  });
  router.get('/servers/:id/file', requireIdentityRead, async (req, res) => { const data = await manager.readFile(req.params.id, req.query.path); data.editable = data.editable && canAccessServer(req.session.user, req.params.id, true); res.json(data); });
  router.put('/servers/:id/file', async (req, res) => res.json(await manager.writeFile(req.params.id, req.body.path, req.body.content, { revision: req.body.revision, requireRevision: true })));
  router.post('/servers/:id/files/mkdir', async (req, res) => res.json(await manager.mkdir(req.params.id, req.body.path)));
  router.post('/servers/:id/files/move', async (req, res) => res.json(await manager.moveFile(req.params.id, req.body)));
  router.post('/servers/:id/files/rename', async (req, res) => res.json(await manager.renameFile(req.params.id, req.body)));
  router.post('/servers/:id/files/copy', async (req, res) => res.json(await manager.copyFiles(req.params.id, req.body)));
  router.post('/servers/:id/files/compress', async (req, res) => res.json(await manager.compressFiles(req.params.id, req.body)));
  router.post('/servers/:id/files/extract', async (req, res) => res.json(await manager.extractFiles(req.params.id, req.body)));
  router.post('/servers/:id/files/create', async (req, res) => res.status(201).json(await manager.createFile(req.params.id, req.body)));
  router.post('/servers/:id/files/upload', multipart(fileUpload), async (req, res) => {
    if (!req.file) fail('Hãy chọn tệp tải lên.');
    try { res.json(await manager.upload(req.params.id, req.query.path || '', req.file.originalname, req.file.path)); }
    finally { await fs.rm(req.file.path, { force: true }).catch(() => {}); }
  });
  router.delete('/servers/:id/file', async (req, res) => res.json(await manager.deleteFile(req.params.id, req.query.path)));
  router.get('/servers/:id/files/download', requireIdentityRead, async (req, res, next) => download(req, res, await manager.downloadFile(req.params.id, req.query.path), next));
  router.get('/servers/:id/players', async (req, res) => res.json(await manager.players(req.params.id)));
  router.put('/servers/:id/players', async (req, res) => res.json(await manager.savePlayers(req.params.id, req.body)));
  router.get('/servers/:id/packs', async (req, res) => res.json(await manager.packs(req.params.id)));
  router.patch('/servers/:id/packs/order/:kind', async (req, res) => res.json(await manager.reorderPacks(req.params.id, req.params.kind, req.body)));
  router.get('/servers/:id/experiments', async (req, res) => res.json(await manager.experiments(req.params.id)));
  router.patch('/servers/:id/experiments', async (req, res) => res.status(202).json(await manager.changeExperiments(req.params.id, req.body)));
  router.post('/servers/:id/packs/import', multipart(packUpload), async (req, res) => {
    if (!req.file) fail('Hãy chọn .mcpack hoặc .mcaddon.');
    try { res.status(201).json(await manager.importPacks(req.params.id, req.file.path, req.file.originalname)); }
    finally { await fs.rm(req.file.path, { force: true }).catch(() => {}); }
  });
  router.patch('/servers/:id/packs/:uuid', async (req, res) => res.json(await manager.setPackEnabled(req.params.id, req.params.uuid, req.body.enabled)));
  router.delete('/servers/:id/packs/:uuid', async (req, res) => res.json(await manager.removePack(req.params.id, req.params.uuid)));
  router.get('/servers/:id/worlds', async (req, res) => res.json(await manager.worlds(req.params.id)));
  router.get('/servers/:id/activity', (req, res) => res.json({ activity: manager.serverActivity(req.params.id) }));
  router.post('/servers/:id/worlds/import', multipart(worldUpload), async (req, res) => {
    if (!req.file) fail('Hãy chọn tệp world Bedrock .mcworld hoặc .zip.');
    try {
      if (Object.keys(req.body).some(key => key !== 'name')) fail('Yêu cầu nhập world không hợp lệ.');
      res.status(202).json({ job: await manager.importWorld(req.params.id, req.file.path, { name: req.body.name, filename: req.file.originalname }) });
    } finally { await fs.rm(req.file.path, { force: true }).catch(() => {}); }
  });
  router.post('/servers/:id/worlds/select', async (req, res) => res.json(await manager.selectWorld(req.params.id, req.body)));
  router.post('/servers/:id/worlds/create', async (req, res) => res.status(201).json(await manager.createWorld(req.params.id, req.body)));
  const requireWorldExport = (req, res, next) => { if (!canAccessServer(req.session.user, req.params.id, true)) fail('Xuất world chứa dữ liệu người chơi cần quyền quản lý server.', 403); next(); };
  router.head('/servers/:id/worlds/:name/export', requireWorldExport, async (req, res) => { const result = await manager.exportWorldInfo(req.params.id, req.params.name); res.attachment(result.name).type('application/octet-stream').end(); });
  router.get('/servers/:id/worlds/:name/export', requireWorldExport, async (req, res, next) => {
    const controller = new AbortController(), cancel = () => controller.abort();
    req.once('aborted', cancel); res.once('close', cancel);
    try { return await download(req, res, await manager.exportWorld(req.params.id, req.params.name, { signal: controller.signal }), next); }
    finally { req.removeListener('aborted', cancel); res.removeListener('close', cancel); }
  });
  router.delete('/servers/:id/worlds/:name', async (req, res) => res.json(await manager.deleteWorld(req.params.id, req.params.name, req.body)));
  router.get('/servers/:id/backups', (req, res) => res.json({ backups: manager.backups(req.params.id), limits: manager.backupLimits() }));
  router.post('/servers/:id/backups', async (req, res) => res.status(202).json({ job: await manager.backup(req.params.id) }));
  router.post('/servers/:id/backups/:backupId/restore', async (req, res) => res.status(202).json({ job: await manager.restore(req.params.id, req.params.backupId) }));
  router.get('/servers/:id/backups/:backupId/download', async (req, res, next) => { if (!canAccessServer(req.session.user, req.params.id, true)) fail('Tải bản sao lưu chứa dữ liệu riêng tư cần quyền quản lý server.', 403); return download(req, res, await manager.downloadBackup(req.params.id, req.params.backupId), next); });
  router.post('/servers/:id/backups/:backupId/verify', async (req, res) => res.status(202).json({ job: await manager.verifyBackup(req.params.id, req.params.backupId) }));
  router.patch('/servers/:id/backups/:backupId', async (req, res) => res.json(await manager.setBackupLocked(req.params.id, req.params.backupId, req.body)));
  router.delete('/servers/:id/backups/:backupId', async (req, res) => res.json(await manager.deleteBackup(req.params.id, req.params.backupId)));
  router.post('/servers/:id/update', async (req, res) => res.status(202).json({ job: await manager.upgrade(req.params.id, req.body) }));
  router.get('/versions', (req, res) => res.json(manager.versions()));
  router.post('/versions/refresh', requireAdmin, async (req, res) => res.json(await manager.refreshVersions()));
  router.post('/versions/:channel/:version/verify', requireAdmin, async (req, res) => res.json({ version: await manager.verifyVersion(req.params.version, req.params.channel) }));
  router.post('/versions/import', requireAdmin, multipart(upload), async (req, res) => {
    if (!req.file) fail('Hãy chọn ZIP Bedrock Linux chính thức.');
    try { res.status(201).json({ version: await manager.importVersion(req.file.path, req.body.version, req.body.channel || 'stable') }); }
    finally { await fs.rm(req.file.path, { force: true }).catch(() => {}); }
  });
  router.get('/jobs', (req, res) => res.json({ jobs: scoped(req.session.user, manager.jobs()) }));
  router.get('/jobs/:id', async (req, res) => {
    const job = manager.getJob ? await manager.getJob(req.params.id) : manager.jobs().find(row => row.id === req.params.id);
    if (!job || !scoped(req.session.user, [job]).length) {
      const errorI18n = { id: 'panel.jobs.not-found', params: [], en: 'Job was not found or you do not have permission to view it.', vi: 'Không tìm thấy tác vụ hoặc bạn không có quyền xem.' };
      return res.status(404).json({ error: errorI18n[req.panelLanguage === 'vi' ? 'vi' : 'en'], errorI18n });
    }
    res.json({ job });
  });
  router.get('/schedules', (req, res) => res.json({ schedules: scoped(req.session.user, manager.schedules()) }));
  router.post('/schedules', (req, res) => { if (!canAccessServer(req.session.user, req.body.serverId, true)) fail('Bạn không có quyền tạo lịch cho server này.', 403); res.status(201).json({ schedule: manager.createSchedule(req.body) }); });
  router.use('/schedules/:id', (req, res, next) => { const record = manager.schedules().find(item => item.id === req.params.id); if (!record) fail('Không tìm thấy lịch.', 404); if (!canAccessServer(req.session.user, record.serverId, !['GET', 'HEAD', 'OPTIONS'].includes(req.method))) fail('Bạn không có quyền truy cập lịch của server này.', 403); next(); });
  router.patch('/schedules/:id', (req, res) => res.json({ schedule: manager.updateSchedule(req.params.id, req.body) }));
  router.post('/schedules/:id/run', (req, res) => res.status(202).json(manager.runSchedule(req.params.id)));
  router.delete('/schedules/:id', (req, res) => res.json(manager.deleteSchedule(req.params.id)));
  router.get('/activity', requireAdmin, (req, res) => res.json({ activity: manager.activity() }));
  router.get('/admin/log-retention', requireAdmin, (req, res) => res.json(manager.logRetention()));
  router.patch('/admin/log-retention', requireAdmin, async (req, res) => res.json(await manager.updateLogRetention(req.body)));
  router.post('/admin/log-retention/clear', requireAdmin, (req, res) => res.json(manager.clearHistory(req.body)));
  router.get('/admin/log-retention/export', requireAdmin, (req, res) => res.attachment('vortex-history.json').type('application/json').send(JSON.stringify(manager.exportHistory(), null, 2)));
  return router;
}
