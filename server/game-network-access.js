import { createServerFirewall } from './server-firewall.js';

const SHA = /^[a-f0-9]{64}$/;
const messages = {
  ready: ['The host firewall allows the configured game ports.', 'Firewall trên VPS đã cho phép các cổng game được cấu hình.'],
  inactive: ['The host firewall is inactive. No firewall was enabled or changed; check cloud firewall rules separately.', 'Firewall trên VPS chưa bật. Panel không bật hoặc thay đổi firewall; hãy kiểm tra riêng rule firewall cloud.'],
  unverified: ['The host firewall could not be managed safely. Check the configured game ports and cloud firewall rules.', 'Chưa thể quản lý firewall trên VPS an toàn. Hãy kiểm tra các cổng game được cấu hình và rule firewall cloud.'],
  blocked: ['The active host firewall could not confirm all configured game ports. Review the server firewall before retrying.', 'Firewall đang bật trên VPS chưa xác nhận được toàn bộ cổng game đã cấu hình. Hãy kiểm tra firewall của máy chủ trước khi thử lại.'],
  changed: ['The server network configuration changed during firewall setup. Retry with the current configuration.', 'Cấu hình mạng của máy chủ đã thay đổi khi thiết lập firewall. Hãy thử lại với cấu hình hiện tại.'],
  removed: ['The deleted server has no remaining owned host firewall rules. Other rules were preserved.', 'Đã dọn rule firewall trên VPS thuộc máy chủ đã xóa. Các rule khác được giữ nguyên.'],
  cleanup: ['The server was deleted, but its owned host firewall rules could not be fully confirmed as removed. Review the host firewall.', 'Máy chủ đã được xóa nhưng chưa xác nhận dọn hết rule firewall riêng trên VPS. Hãy kiểm tra firewall của VPS.'],
};
const present = key => ({ message: messages[key][0], messageI18n: { id: `panel.game-network.${key}`, en: messages[key][0], vi: messages[key][1], params: [] } });
export const GAME_NETWORK_ACCESS_MESSAGES = Object.freeze(Object.keys(messages).map(key => Object.freeze(present(key).messageI18n)));
const identity = server => JSON.stringify([server?.id, server?.kind ?? 'bedrock', server?.transport, server?.port, server?.portV6, server?.udpPorts]);
const isApplication = server => ['nodejs', 'python'].includes(server?.kind);
const complete = state => state?.supported === true && ['ufw', 'iptables'].includes(state.backend) && state.status === 'active' && state.canApply === true && SHA.test(state.revision || '') && Array.isArray(state.ports) && state.ports.length > 0 && state.ports.every(port => {
  if (!['managed', 'covered'].includes(port.state)) return false;
  return state.backend !== 'iptables' || port.live === true && port.saved === true;
}) && Array.isArray(state.obsoleteRules) && state.obsoleteRules.length === 0 && (state.backend !== 'iptables' || state.persistence?.ready === true && state.persistence.verified === true);
function blocked(reason = 'blocked', firewall) {
  const value = present(reason);
  throw Object.assign(new Error(value.message), { code: reason === 'changed' ? 'GAME_NETWORK_CHANGED' : 'GAME_NETWORK_BLOCKED', status: 409, errorI18n: value.messageI18n, ...(firewall ? { firewall } : {}) });
}
export function gameNetworkAccessErrorPayload(error, language = 'en') {
  if (!['GAME_NETWORK_BLOCKED', 'GAME_NETWORK_CHANGED'].includes(error?.code)) return null;
  const value = present(error.code === 'GAME_NETWORK_CHANGED' ? 'changed' : 'blocked');
  return { code: error.code, error: value.messageI18n[language === 'vi' ? 'vi' : 'en'], errorI18n: value.messageI18n };
}

// Use only the existing scoped controller: this never enables a firewall,
// installs a backend, adopts foreign rules, or asserts Internet reachability.
export function createGameNetworkAccess({ scope, firewall = createServerFirewall({ scope }) } = {}) {
  if (typeof firewall?.inspect !== 'function' || typeof firewall?.apply !== 'function') throw new TypeError('A scoped server firewall controller is required.');
  async function ensure(server, resolveCurrent = async () => server) {
    if (isApplication(server)) return { status: 'skipped', verified: false, changed: false, reason: 'application', cloudVerified: false };
    const serverId = server?.id;
    const current = async () => {
      const value = await resolveCurrent();
      if (value?.id !== serverId || isApplication(value)) blocked('changed');
      return value;
    };
    let changed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const latest = await current(), expected = identity(latest);
      let state;
      try { state = await firewall.inspect(latest); }
      catch (error) {
        if (error?.code === 'FIREWALL_NETWORK' || error?.code === 'FIREWALL_CONTEXT') blocked('blocked');
        return { status: 'warning', verified: false, changed, reason: 'unverified', cloudVerified: false, ...present('unverified') };
      }
      if (identity(await current()) !== expected) {
        if (attempt === 0) continue;
        blocked('changed', state);
      }
      if (state?.status !== 'active' || state.supported !== true || state.backend === 'iptables' && state.persistence?.ready !== true) {
        const reason = state?.status === 'inactive' ? 'inactive' : 'unverified';
        return { status: 'warning', verified: false, changed, reason, cloudVerified: false, ...present(reason) };
      }
      if (!state.canApply || !SHA.test(state.revision || '')) blocked('blocked', state);
      if (!complete(state)) {
        let applied;
        try {
          applied = await firewall.apply(latest, { revision: state.revision, confirmed: true }, current);
        } catch (error) {
          if (error?.code === 'FIREWALL_STALE' && attempt === 0) continue;
          if (error?.code === 'GAME_NETWORK_CHANGED') throw error;
          blocked('blocked', state);
        }
        changed ||= Boolean(applied?.added?.length || applied?.removed?.length);
        if (!applied?.ok || !complete(applied)) blocked('blocked', applied || state);
        changed = true;
      }
      // Reinspect after mutation, or before accepting pre-existing coverage.
      // Every configured port must still match the latest saved network.
      const refreshed = await current();
      if (identity(refreshed) !== expected) {
        if (attempt === 0) continue;
        blocked('changed', state);
      }
      let confirmed;
      try { confirmed = await firewall.inspect(refreshed); }
      catch { blocked('blocked'); }
      if (identity(await current()) !== expected) {
        if (attempt === 0) continue;
        blocked('changed', confirmed);
      }
      if (!complete(confirmed)) blocked('blocked', confirmed);
      return { status: 'ready', verified: true, changed, cloudVerified: false, ...present('ready') };
    }
    blocked('changed');
  }
  async function release(server) {
    if (isApplication(server)) return { status: 'skipped', verified: false, changed: false, pending: false, reason: 'application', cloudVerified: false };
    // Deletion is already committed. Keep its network identity independently of
    // the store, and never resolve another server now using the same ports.
    const retained = { ...server }, serverId = String(retained.id || '').toLowerCase();
    let changed = false;
    const warning = () => ({ status: 'warning', verified: false, changed, pending: true, reason: 'cleanup-unverified', cloudVerified: false, ...present('cleanup') });
    const observable = state => state?.serverId === serverId && state.supported === true && ['ufw', 'iptables'].includes(state.backend) && state.status === 'active' && state.canApply === true && SHA.test(state.revision || '') && typeof state.owner === 'string' && state.owner.endsWith(':' + serverId) && Array.isArray(state.managedRules) && (state.backend !== 'iptables' || state.persistence?.ready === true && Array.isArray(state.savedRules));
    const ownRules = state => state.managedRules.length + (state.backend === 'iptables' ? state.savedRules.length : 0);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const state = await firewall.inspect(retained);
        if (!observable(state)) return warning();
        let removed = false;
        if (ownRules(state) > 0) {
          if (state.canRemove !== true || typeof firewall.remove !== 'function') return warning();
          let result;
          try { result = await firewall.remove(retained, { revision: state.revision, confirmed: true }, async () => ({ ...retained })); }
          catch (error) { if (error?.code === 'FIREWALL_STALE' && attempt === 0) continue; return warning(); }
          changed ||= Boolean(result?.removed?.length);
          if (result?.ok !== true || result.partial === true || !observable(result) || result.owner !== state.owner || result.backend !== state.backend || ownRules(result) !== 0) return warning();
          changed = true;
          removed = true;
        }
        const confirmed = await firewall.inspect(retained);
        if (!observable(confirmed) || confirmed.owner !== state.owner || confirmed.backend !== state.backend || ownRules(confirmed) !== 0) return warning();
        return { status: 'ready', verified: true, changed, pending: false, reason: removed ? 'removed' : 'no-owned-rules', cloudVerified: false, ...present('removed') };
      }
    } catch { return warning(); }
    return warning();
  }
  return { ensure, release };
}
