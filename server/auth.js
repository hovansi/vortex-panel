import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { ROLES, canAccessServer, requireAdmin, publicUser } from './access.js';
import { generateSecret, verifyTotp, otpauthUrl, generateRecoveryCodes, consumeRecoveryCode } from './mfa.js';

const scrypt = promisify(scryptCallback);
const SESSION_TTL = 12 * 60 * 60 * 1000;
const COOKIE = 'bedrock.sid';
const token = () => randomBytes(32).toString('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export const constantEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128 || typeof encoded !== 'string') return false;
  const [salt, expected] = encoded.split(':');
  if (!/^[a-f0-9]{32}$/i.test(salt || '') || !/^[a-f0-9]{128}$/i.test(expected || '')) return false;
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail('Mật khẩu cần từ 12 đến 128 ký tự.');
}
function validateUsername(username) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) fail('Tên tài khoản: 3–32 ký tự, chữ, số, dấu chấm hoặc gạch.');
}
export function createAuth({ store, demo = false, setupToken = token(), publicUrl = '', secretVault, serverExists = id => (store.data.servers || []).some(server => server.id === id) }) {
  const router = express.Router();
  const sessions = new Map();
  const attempts = new Map();
  const mfaSetups = new Map();
  const challenges = new Map();
  const mfaAttempts = new Map();
  const fileAccessAttempts = new Map();
  const administratorAttempts = new Map();
  const passwordChangeAttempts = new Map();
  const fileAccessTtl = 10 * 60 * 1000;
  let setupBusy = false;
  router.use((req, res, next) => { req.body ??= {}; next(); });
  for (const user of store.data.users) {
    user.id ||= randomUUID(); user.role ||= 'admin'; user.serverIds ||= [];
    user.allServers = user.role === 'admin' || user.allServers === true; user.sessionVersion ||= 0;
  }
  if (demo && !store.data.users.length) store.data.users.push({ id: randomUUID(), username: 'demo', role: 'admin', allServers: true, serverIds: [], disabled: false, sessionVersion: 0, createdAt: new Date().toISOString() });
  function commit(operation, action, detail, actor) {
    const references = [...store.data.users];
    const users = new Map(references.map(user => [user, structuredClone(user)]));
    const activity = [...(store.data.activity || [])];
    try {
      const result = operation();
      if (action) {
        store.data.activity ||= [];
        store.data.activity.unshift({ id: randomUUID(), time: new Date().toISOString(), action, detail, user: actor || 'system' });
        store.data.activity = store.data.activity.slice(0, 1000);
      }
      store.save();
      return result;
    } catch (error) {
      for (const [reference, snapshot] of users) { for (const key of Object.keys(reference)) delete reference[key]; Object.assign(reference, snapshot); }
      store.data.users = references; store.data.activity = activity;
      throw error;
    }
  }
  const originAllowed = req => {
    if (!req.headers.origin) return true;
    try {
      const protocol = req.protocol || (req.socket?.encrypted ? 'https' : 'http');
      const allowed = publicUrl ? new URL(publicUrl).origin : `${protocol}://${req.headers.host}`;
      return new URL(req.headers.origin).origin === allowed;
    } catch { return false; }
  };
  function readSession(req) {
    const cookie = String(req.headers.cookie || '').split(';').find(value => value.trim().startsWith(`${COOKIE}=`));
    const sid = cookie?.trim().slice(COOKIE.length + 1);
    const session = sessions.get(sid);
    const user = session && store.data.users.find(value => value.id === session.userId);
    if (!session || session.expires < Date.now() || !user || user.disabled || !ROLES.includes(user.role) || user.sessionVersion !== session.version) {
      if (sid) sessions.delete(sid); return null;
    }
    return { user: publicUser(user), csrfToken: session.csrfToken, expires: session.expires, sid };
  }
  function createSession(req, res, user) {
    for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
    if (sessions.size >= 200) sessions.delete(sessions.keys().next().value);
    const sid = token();
    const session = { userId: user.id, version: user.sessionVersion || 0, csrfToken: token(), expires: Date.now() + SESSION_TTL };
    sessions.set(sid, session);
    res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'strict', secure: req.secure || publicUrl.startsWith('https:'), maxAge: SESSION_TTL, path: '/' });
    return { user: publicUser(user), csrfToken: session.csrfToken, expires: session.expires, sid };
  }
  const response = session => ({ setupRequired: !demo && store.data.users.length === 0, authenticated: !!session, ...(session ? { user: session.user, csrfToken: session.csrfToken } : {}), demo });
  function rateLimit(req, res, next) {
    const timestamp = Date.now();
    for (const [key, value] of attempts) if (value.until < timestamp) attempts.delete(key);
    const current = attempts.get(req.ip) || { count: 0, until: timestamp + 15 * 60 * 1000 };
    current.count++; attempts.set(req.ip, current);
    if (current.count > 20) return res.status(429).json({ error: 'Thử lại sau 15 phút.' });
    if (!originAllowed(req)) return res.status(403).json({ error: 'Origin không hợp lệ.' }); next();
  }
  function requireAuth(req, res, next) {
    req.session = readSession(req);
    if (!req.session) return res.status(401).json({ error: 'Vui lòng đăng nhập.' });
    if (!originAllowed(req)) return res.status(403).json({ error: 'Origin không hợp lệ.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !constantEqual(req.headers['x-csrf-token'], req.session.csrfToken)) return res.status(403).json({ error: 'Phiên bảo mật hết hạn. Tải lại trang.' }); next();
  }
  async function reauthenticateAdmin(req, password) {
    const before = readSession(req);
    if (!before || before.user.role !== 'admin') fail('Phiên quản trị đã bị thu hồi.', 401);
    if (demo) fail('Thao tác hệ thống cần tài khoản quản trị thật.', 409);
    const timestamp = Date.now();
    for (const [id, value] of administratorAttempts) if (value.until <= timestamp) administratorAttempts.delete(id);
    const attempt = administratorAttempts.get(before.user.id) || { count: 0, until: timestamp + 15 * 60 * 1000 };
    if (attempt.count >= 5) fail('Thử lại sau 15 phút.', 429);
    attempt.count++; administratorAttempts.set(before.user.id, attempt);
    const user = store.data.users.find(value => value.id === before.user.id), encoded = user?.passwordHash;
    if (!await verifyPassword(password, encoded)) fail('Mật khẩu hiện tại chưa đúng.', 403);
    const after = readSession(req);
    if (!after || after.sid !== before.sid || after.user.id !== before.user.id || after.user.role !== 'admin'
      || !store.data.users.includes(user) || user.passwordHash !== encoded) fail('Phiên quản trị đã bị thu hồi.', 401);
    administratorAttempts.delete(before.user.id);
    return after.user;
  }
  const revokeSessions = userId => { for (const [sid, session] of sessions) if (session.userId === userId) sessions.delete(sid); };
  const fileAccess = (req, serverId) => {
    const session = readSession(req), grant = session && sessions.get(session.sid)?.fileAccess?.get(serverId);
    return session?.user.role === 'admin' && grant?.expires > Date.now() ? { serverId, expires: grant.expires } : null;
  };
  router.get('/file-access', requireAuth, requireAdmin, (req, res) => res.json({ fileAccess: fileAccess(req, req.query.serverId) }));
  router.post('/file-access', requireAuth, requireAdmin, async (req, res) => {
    if (demo) fail('Chế độ can thiệp mạnh cần tài khoản quản trị thật.', 409);
    const { serverId, password, confirmed } = req.body;
    if (typeof serverId !== 'string' || !serverExists(serverId)) fail('Không tìm thấy máy chủ.', 404);
    if (confirmed !== true) fail('Cần xác nhận cảnh báo trước khi bật can thiệp mạnh.');
    const key = req.session.user.id, previous = fileAccessAttempts.get(key), timestamp = Date.now();
    const attempt = previous?.until > timestamp ? previous : { count: 0, until: timestamp + 15 * 60 * 1000 };
    if (attempt.count >= 5) fail('Thử lại sau 15 phút.', 429);
    attempt.count++; fileAccessAttempts.set(key, attempt);
    const user = store.data.users.find(value => value.id === key), encoded = user?.passwordHash;
    if (!await verifyPassword(password, encoded)) fail('Mật khẩu hiện tại chưa đúng.', 403);
    const session = readSession(req);
    if (!session || session.user.role !== 'admin' || user.passwordHash !== encoded) fail('Phiên quản trị đã bị thu hồi.', 401);
    const grant = { serverId, expires: Date.now() + fileAccessTtl };
    commit(() => {}, 'file.access.enable', serverId, user.username);
    const stored = sessions.get(session.sid); stored.fileAccess ||= new Map(); stored.fileAccess.set(serverId, grant);
    fileAccessAttempts.delete(key); res.json({ fileAccess: grant });
  });
  router.delete('/file-access', requireAuth, requireAdmin, (req, res) => {
    const serverId = req.body.serverId;
    if (typeof serverId !== 'string') fail('Máy chủ không hợp lệ.');
    commit(() => {}, 'file.access.disable', serverId, req.session.user.username);
    sessions.get(req.session.sid)?.fileAccess?.delete(serverId); res.json({ fileAccess: null });
  });
  const preserveCurrentSession = (user, sid) => {
    for (const [key, session] of sessions) if (session.userId === user.id) { if (key === sid) session.version = user.sessionVersion; else sessions.delete(key); }
  };
  const requireVault = () => { if (!secretVault) fail('Kho mã hóa MFA chưa được cấu hình trên máy chủ.', 503); return secretVault; };
  function factorAllowed(user) {
    const record = mfaAttempts.get(user.id);
    if (record && record.until > Date.now() && record.failures >= 10) fail('Xác thực hai bước tạm khóa; thử lại sau 15 phút.', 429);
  }
  function useFactor(user, code) {
    factorAllowed(user);
    if (!user.mfaSecret) return false;
    const secret = requireVault().open(user.mfaSecret, user.id);
    const counter = verifyTotp(secret, code, { lastCounter: user.mfaLastCounter ?? -1 });
    if (counter !== null) return { counter };
    const index = consumeRecoveryCode(code, user.mfaRecoveryHashes || []);
    if (index >= 0) return { recoveryIndex: index };
    const previous = mfaAttempts.get(user.id);
    mfaAttempts.set(user.id, { failures: previous && previous.until > Date.now() ? previous.failures + 1 : 1, until: previous && previous.until > Date.now() ? previous.until : Date.now() + 15 * 60 * 1000 });
    return false;
  }
  const consumeFactor = (user, factor) => { if (factor.counter !== undefined) user.mfaLastCounter = factor.counter; else user.mfaRecoveryHashes.splice(factor.recoveryIndex, 1); };
  async function verifyAccountPassword(req) {
    const user = store.data.users.find(value => value.id === req.session.user.id);
    if (demo) fail('Cấu hình MFA không hoạt động trong chế độ demo.', 409);
    factorAllowed(user);
    if (!await verifyPassword(req.body.password, user?.passwordHash)) fail('Mật khẩu hiện tại chưa đúng.', 403);
    if (!readSession(req)) fail('Phiên đăng nhập đã bị thu hồi.', 401);
    return user;
  }
  const securityFields = input => {
    const result = {};
    if (input.role !== undefined) { if (!ROLES.includes(input.role)) fail('Vai trò phải là admin, operator hoặc viewer.'); result.role = input.role; }
    for (const field of ['allServers', 'disabled']) if (input[field] !== undefined) { if (typeof input[field] !== 'boolean') fail(`${field} phải là boolean.`); result[field] = input[field]; }
    if (input.serverIds !== undefined) {
      if (!Array.isArray(input.serverIds) || input.serverIds.length > 1000 || input.serverIds.some(id => typeof id !== 'string' || !serverExists(id))) fail('Danh sách server được phân quyền không hợp lệ.');
      result.serverIds = [...new Set(input.serverIds)];
    }
    return result;
  };
  const guardAdministrator = (user, candidate, actor) => {
    if (user.id === actor.id && (candidate.role !== 'admin' || candidate.disabled)) fail('Không thể hạ quyền hoặc vô hiệu hóa tài khoản quản trị đang đăng nhập.', 409);
    if (user.role === 'admin' && !user.disabled && (candidate.role !== 'admin' || candidate.disabled) && !store.data.users.some(value => value.id !== user.id && value.role === 'admin' && !value.disabled)) fail('Panel cần ít nhất một quản trị viên đang hoạt động.', 409);
  };
  router.get('/status', (req, res) => {
    let session = readSession(req);
    if (demo && !session && !req.headers.cookie) {
      const user = store.data.users.find(value => value.username === 'demo' && value.role === 'admin' && !value.disabled);
      if (user) session = createSession(req, res, user);
    }
    res.json(response(session));
  });
  router.post('/demo', rateLimit, (req, res) => {
    if (!demo) fail('Không tìm thấy chức năng này.', 404);
    const user = store.data.users.find(value => value.username === 'demo' && value.role === 'admin' && !value.disabled);
    if (!user) fail('Tài khoản demo đã được quản trị viên vô hiệu hóa.', 409);
    commit(() => {}, 'auth.demo', 'Mở phiên trải nghiệm demo', user.username);
    res.json(response(createSession(req, res, user)));
  });
  router.post('/setup', rateLimit, async (req, res) => {
    if (demo || store.data.users.length || setupBusy) return res.status(409).json({ error: 'Panel đã được thiết lập.' });
    if (!constantEqual(req.body.token, setupToken)) return res.status(403).json({ error: 'Mã thiết lập không hợp lệ. Xem terminal chạy panel.' });
    const { username, password } = req.body; validateUsername(username); validatePassword(password); setupBusy = true;
    try {
      const user = { id: randomUUID(), username, passwordHash: await hashPassword(password), role: 'admin', allServers: true, serverIds: [], disabled: false, sessionVersion: 0, createdAt: new Date().toISOString() };
      commit(() => store.data.users.push(user), 'auth.setup', 'Tạo tài khoản quản trị', username); res.json(response(createSession(req, res, user)));
    } finally { setupBusy = false; }
  });
  router.post('/login', rateLimit, async (req, res) => {
    const user = store.data.users.find(value => typeof req.body.username === 'string' && value.username.toLowerCase() === req.body.username.toLowerCase());
    const encoded = user?.passwordHash || `00000000000000000000000000000000:${'0'.repeat(128)}`;
    const version = user?.sessionVersion;
    if (!await verifyPassword(req.body.password, encoded) || !user || user.disabled || !store.data.users.includes(user) || user.passwordHash !== encoded || user.sessionVersion !== version || !ROLES.includes(user.role)) return res.status(401).json({ error: 'Tên tài khoản hoặc mật khẩu chưa đúng.' });
    if (user.mfaSecret) {
      factorAllowed(user);
      for (const [key, challenge] of challenges) if (challenge.expires < Date.now()) challenges.delete(key);
      if (challenges.size >= 200) challenges.delete(challenges.keys().next().value);
      const challengeToken = token(); challenges.set(challengeToken, { userId: user.id, version: user.sessionVersion, expires: Date.now() + 5 * 60 * 1000, failures: 0 });
      return res.json({ authenticated: false, mfaRequired: true, challengeToken, expiresIn: 300, demo });
    }
    commit(() => {}, 'auth.login', 'Đăng nhập', user.username); res.json(response(createSession(req, res, user)));
  });
  router.post('/mfa/verify', rateLimit, (req, res) => {
    const challenge = challenges.get(req.body.challengeToken);
    const user = challenge && store.data.users.find(value => value.id === challenge.userId);
    if (!challenge || challenge.expires < Date.now() || challenge.failures >= 5 || !user || user.disabled || !user.mfaSecret || user.sessionVersion !== challenge.version) { challenges.delete(req.body.challengeToken); fail('Thử thách xác thực đã hết hạn. Đăng nhập lại.', 401); }
    const factor = useFactor(user, req.body.code);
    if (!factor) { challenge.failures++; if (challenge.failures >= 5) challenges.delete(req.body.challengeToken); fail('Mã hai bước chưa đúng, đã dùng hoặc hết hạn. Chờ mã mới hoặc dùng mã khôi phục.', 401); }
    commit(() => consumeFactor(user, factor), 'auth.mfa.login', 'Đăng nhập với xác thực hai bước', user.username);
    challenges.delete(req.body.challengeToken); mfaAttempts.delete(user.id);
    res.json(response(createSession(req, res, user)));
  });
  router.post('/logout', requireAuth, (req, res) => { sessions.delete(req.session.sid); res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });
  router.post('/password', requireAuth, async (req, res) => {
    if (demo) return res.status(409).json({ error: 'Không đổi mật khẩu trong chế độ demo.' });
    const user = store.data.users.find(value => value.id === req.session.user.id); validatePassword(req.body.password);
    const timestamp = Date.now();
    for (const [id, value] of passwordChangeAttempts) if (value.until <= timestamp) passwordChangeAttempts.delete(id);
    const attempt = passwordChangeAttempts.get(user.id) || { count: 0, until: timestamp + 15 * 60 * 1000 };
    if (attempt.count >= 5) return res.set('Retry-After', String(Math.max(1, Math.ceil((attempt.until - timestamp) / 1000)))).status(429).json({ error: 'Thử lại sau 15 phút.' });
    // Reserve the attempt before scrypt so concurrent requests and a second
    // session cannot bypass this password-proof limit. Login remains usable.
    attempt.count++; passwordChangeAttempts.set(user.id, attempt);
    if (!await verifyPassword(req.body.currentPassword, user?.passwordHash)) return res.status(403).json({ error: 'Mật khẩu hiện tại chưa đúng.' });
    const passwordHash = await hashPassword(req.body.password); if (!readSession(req)) return res.status(401).json({ error: 'Phiên đăng nhập đã bị thu hồi.' });
    commit(() => { user.passwordHash = passwordHash; user.sessionVersion++; user.updatedAt = new Date().toISOString(); }, 'auth.password', 'Đổi mật khẩu', user.username);
    preserveCurrentSession(user, req.session.sid); passwordChangeAttempts.delete(user.id); res.json({ ok: true });
  });
  router.get('/mfa', requireAuth, (req, res) => {
    const user = store.data.users.find(value => value.id === req.session.user.id);
    res.json({ enabled: Boolean(user.mfaSecret), recoveryCodesRemaining: (user.mfaRecoveryHashes || []).length, demo });
  });
  router.post('/mfa/setup', requireAuth, rateLimit, async (req, res) => {
    const user = await verifyAccountPassword(req); requireVault();
    if (user.mfaSecret) fail('Xác thực hai bước đã được bật.', 409);
    const secret = generateSecret(); const url = otpauthUrl(secret, user.username);
    for (const [id, pending] of mfaSetups) if (pending.expires < Date.now()) mfaSetups.delete(id);
    mfaSetups.set(user.id, { secret, sid: req.session.sid, version: user.sessionVersion, expires: Date.now() + 10 * 60 * 1000, failures: 0 });
    const { default: QRCode } = await import('qrcode');
    res.json({ secret, otpauthUrl: url, qrDataUrl: await QRCode.toDataURL(url, { width: 240, margin: 2 }), expiresIn: 600 });
  });
  router.post('/mfa/enable', requireAuth, rateLimit, (req, res) => {
    if (demo) fail('Cấu hình MFA không hoạt động trong chế độ demo.', 409);
    const user = store.data.users.find(value => value.id === req.session.user.id); const pending = mfaSetups.get(user.id);
    if (user.mfaSecret) fail('Xác thực hai bước đã được bật.', 409);
    if (!pending || pending.sid !== req.session.sid || pending.version !== user.sessionVersion || pending.expires < Date.now() || pending.failures >= 5) { mfaSetups.delete(user.id); fail('Mã thiết lập đã hết hạn. Tạo lại mã QR.', 409); }
    const counter = verifyTotp(pending.secret, req.body.code);
    if (counter === null) { pending.failures++; fail('Mã xác thực chưa đúng.', 400); }
    const recovery = generateRecoveryCodes(); const encrypted = requireVault().seal(pending.secret, user.id);
    commit(() => { user.mfaSecret = encrypted; user.mfaLastCounter = counter; user.mfaRecoveryHashes = recovery.hashes; user.sessionVersion++; user.updatedAt = new Date().toISOString(); }, 'auth.mfa.enable', 'Bật xác thực hai bước', user.username);
    mfaSetups.delete(user.id); preserveCurrentSession(user, req.session.sid);
    res.json({ enabled: true, recoveryCodes: recovery.codes });
  });
  router.post('/mfa/disable', requireAuth, rateLimit, async (req, res) => {
    const user = await verifyAccountPassword(req);
    if (!user.mfaSecret) fail('Xác thực hai bước chưa được bật.', 409);
    if (!useFactor(user, req.body.code)) fail('Mã xác thực hoặc khôi phục chưa đúng.', 403);
    commit(() => { delete user.mfaSecret; delete user.mfaLastCounter; delete user.mfaRecoveryHashes; user.sessionVersion++; user.updatedAt = new Date().toISOString(); }, 'auth.mfa.disable', 'Tắt xác thực hai bước', user.username);
    preserveCurrentSession(user, req.session.sid); mfaAttempts.delete(user.id); res.json({ ok: true });
  });
  router.post('/mfa/recovery', requireAuth, rateLimit, async (req, res) => {
    const user = await verifyAccountPassword(req);
    if (!user.mfaSecret) fail('Xác thực hai bước chưa được bật.', 409);
    const factor = useFactor(user, req.body.code); if (!factor) fail('Mã xác thực hoặc khôi phục chưa đúng.', 403);
    const recovery = generateRecoveryCodes();
    commit(() => { consumeFactor(user, factor); user.mfaRecoveryHashes = recovery.hashes; user.sessionVersion++; }, 'auth.mfa.recovery', 'Tạo lại mã khôi phục', user.username);
    preserveCurrentSession(user, req.session.sid); mfaAttempts.delete(user.id);
    res.json({ recoveryCodes: recovery.codes });
  });
  router.get('/users', requireAuth, requireAdmin, (req, res) => res.json({ users: store.data.users.map(publicUser) }));
  router.post('/users', requireAuth, requireAdmin, async (req, res) => {
    validateUsername(req.body.username); validatePassword(req.body.password);
    const fields = { role: 'viewer', allServers: false, serverIds: [], disabled: false, ...securityFields(req.body) };
    const passwordHash = await hashPassword(req.body.password); const session = readSession(req);
    if (!session || session.user.role !== 'admin') fail('Phiên quản trị đã bị thu hồi.', 401);
    if (store.data.users.length >= 100) fail('Panel hỗ trợ tối đa 100 tài khoản.', 409);
    if (store.data.users.some(user => user.username.toLowerCase() === req.body.username.toLowerCase())) fail('Tên tài khoản đã tồn tại.', 409);
    const user = { id: randomUUID(), username: req.body.username, passwordHash, ...fields, allServers: fields.role === 'admin' || fields.allServers, sessionVersion: 0, createdAt: new Date().toISOString() };
    commit(() => store.data.users.push(user), 'user.create', `${user.username}: ${user.role}`, session.user.username); res.status(201).json({ user: publicUser(user) });
  });
  router.patch('/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const fields = securityFields(req.body);
    if (req.body.password !== undefined) { validatePassword(req.body.password); fields.passwordHash = await hashPassword(req.body.password); }
    const session = readSession(req); if (!session || session.user.role !== 'admin') fail('Phiên quản trị đã bị thu hồi.', 401);
    const user = store.data.users.find(value => value.id === req.params.id) || fail('Không tìm thấy tài khoản.', 404);
    if (req.body.resetMfa === true) { if (user.id === session.user.id) fail('Tắt MFA của bạn bằng mật khẩu và mã xác thực trong phần bảo mật.', 409); fields.mfaSecret = undefined; fields.mfaLastCounter = undefined; fields.mfaRecoveryHashes = []; }
    if (user.role === 'admin' && fields.role && fields.role !== 'admin' && fields.allServers === undefined) fields.allServers = false;
    const candidate = { ...user, ...fields }; guardAdministrator(user, candidate, session.user);
    if (!Object.keys(fields).length) fail('Không có thay đổi tài khoản.');
    commit(() => Object.assign(user, fields, { allServers: candidate.role === 'admin' || candidate.allServers === true, updatedAt: new Date().toISOString(), sessionVersion: user.sessionVersion + 1 }), 'user.update', `${user.username}: ${candidate.role}${candidate.disabled ? ' (disabled)' : ''}`, session.user.username);
    revokeSessions(user.id); res.json({ user: publicUser(user) });
  });
  router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
    const user = store.data.users.find(value => value.id === req.params.id) || fail('Không tìm thấy tài khoản.', 404);
    if (user.id === req.session.user.id) fail('Không thể xóa tài khoản đang đăng nhập.', 409);
    guardAdministrator(user, { ...user, disabled: true }, req.session.user);
    commit(() => { store.data.users = store.data.users.filter(value => value.id !== user.id); }, 'user.delete', user.username, req.session.user.username);
    revokeSessions(user.id); res.json({ ok: true });
  });
  return { router, requireAuth, requireAdmin, readSession, originAllowed, setupToken, canAccessServer, revokeSessions, fileAccess, reauthenticateAdmin };
}
