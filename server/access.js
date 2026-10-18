export const ROLES = ['admin', 'operator', 'viewer'];
export function canAccessServer(user, serverId, write = false) {
  if (!user || user.disabled || !ROLES.includes(user.role)) return false;
  if (write && user.role === 'viewer') return false;
  return user.role === 'admin' || user.allServers === true || (Array.isArray(user.serverIds) && user.serverIds.includes(serverId));
}
export function requireAdmin(req, res, next) {
  if (req.session?.user?.role !== 'admin' || req.session.user.disabled) return res.status(403).json({ error: 'Thao tác này cần quyền quản trị viên.' });
  next();
}
export function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, allServers: user.role === 'admin' || user.allServers === true, serverIds: [...(user.serverIds || [])], disabled: Boolean(user.disabled), mfaEnabled: Boolean(user.mfaSecret), createdAt: user.createdAt, updatedAt: user.updatedAt || user.createdAt };
}
export function serverPermissions(user, serverId) {
  return { read: canAccessServer(user, serverId), manage: canAccessServer(user, serverId, true), delete: user?.role === 'admin', clone: user?.role === 'admin' };
}
