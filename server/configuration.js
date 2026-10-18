import { fail, validateProperties } from './safety.js';
import { normalizeResourcePolicy } from './resource-control.js';

const booleans = new Set(['allow-cheats', 'online-mode', 'allow-list', 'force-gamemode', 'enable-lan-visibility', 'texturepack-required', 'content-log-file-enabled', 'server-authoritative-movement-strict', 'server-authoritative-dismount-strict', 'server-authoritative-entity-interactions-strict', 'server-authoritative-block-breaking', 'disable-player-interaction', 'client-side-chunk-generation-enabled', 'block-network-ids-are-hashes', 'disable-custom-skins', 'allow-outbound-script-debugging', 'allow-inbound-script-debugging', 'script-watchdog-enable', 'script-watchdog-enable-exception-handling', 'script-watchdog-enable-shutdown', 'script-watchdog-hang-exception', 'diagnostics-capture-auto-start', 'disable-client-vibrant-visuals']);
const enums = { gamemode: ['survival', 'creative', 'adventure'], difficulty: ['peaceful', 'easy', 'normal', 'hard'], 'default-player-permission-level': ['visitor', 'member', 'operator'], 'compression-algorithm': ['zlib', 'snappy'], 'chat-restriction': ['None', 'Dropped', 'Disabled'], 'script-debugger-auto-attach': ['disabled', 'connect', 'listen'], transport: ['raknet', 'nethernet'] };
const integers = { 'max-players': [1, 1000], 'server-port': [1024, 65535], 'server-portv6': [1024, 65535], 'view-distance': [5, 2147483647], 'tick-distance': [4, 12], 'player-idle-timeout': [0, 2147483647], 'max-threads': [0, 2147483647], 'compression-threshold': [0, 65535], 'force-inbound-debug-port': [1024, 65535], 'script-debugger-auto-attach-timeout': [0, 2147483647], 'script-watchdog-spike-threshold': [1, 2147483647], 'script-watchdog-slow-threshold': [1, 2147483647], 'script-watchdog-memory-warning': [0, 2000], 'script-watchdog-memory-limit': [0, 2000], 'diagnostics-capture-max-files': [0, 2147483647], 'diagnostics-capture-max-file-size': [1, 2147483647] };

export function validateServerSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Thiết lập panel phải là đối tượng.');
  const fields = {};
  for (const key of Object.keys(input)) if (!['name', 'autoStart', 'autoRestart', 'backupRetention', 'messageLanguage', 'worldVoiceEnabled', 'resourcePolicy'].includes(key)) fail(`Thiết lập panel không hỗ trợ: ${key}.`);
  if (Object.hasOwn(input, 'resourcePolicy')) fields.resourcePolicy = normalizeResourcePolicy(input.resourcePolicy);
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80 || /[\x00-\x1f]/.test(input.name)) fail('Tên server phải từ 1–80 ký tự, không chứa ký tự điều khiển.');
    fields.name = input.name.trim();
  }
  for (const key of ['autoStart', 'autoRestart', 'worldVoiceEnabled']) if (input[key] !== undefined) { if (typeof input[key] !== 'boolean') fail(`${key} phải là boolean.`); fields[key] = input[key]; }
  if (Object.hasOwn(input, 'messageLanguage')) {
    if (!['en', 'vi'].includes(input.messageLanguage)) fail('Ngôn ngữ thông báo server phải là en hoặc vi.');
    fields.messageLanguage = input.messageLanguage;
  }
  if (input.backupRetention !== undefined) { const value = input.backupRetention; if (!Number.isInteger(value) || value < 1 || value > 50) fail('Số bản sao lưu giữ lại phải từ 1–50.'); fields.backupRetention = value; }
  return fields;
}

export function validateBedrockProperties(input) {
  const properties = validateProperties(input);
  for (const [key, text] of Object.entries(properties)) {
    if (booleans.has(key) && !['true', 'false'].includes(text)) fail(`${key} phải là true hoặc false.`);
    if (enums[key] && !enums[key].includes(text)) fail(`${key} phải là ${enums[key].join(', ')}.`);
    if (integers[key]) { const [minimum, maximum] = integers[key]; if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < minimum || Number(text) > maximum) fail(`${key} phải là số nguyên từ ${minimum}–${maximum}.`); }
    if (key === 'level-name' && (text !== text.trim() || /[\x00-\x1f\x7f]/.test(text) || Buffer.byteLength(text) > 255 || /[<>"|?*]/.test(text) || /[. ]$/.test(text))) fail('Tên thế giới không hợp lệ cho thư mục: tối đa 255 byte, không chứa ký tự điều khiển hoặc ký tự đặc biệt.');
    if (key === 'server-name' && text.includes(';')) fail('server-name không được chứa dấu chấm phẩy.');
    if (['player-position-acceptance-threshold', 'player-movement-action-direction-threshold', 'server-authoritative-block-breaking-range-scalar'].includes(key)) {
      const value = Number(text); if (!text.trim() || !Number.isFinite(value) || (key === 'player-position-acceptance-threshold' && value <= 0) || (key === 'player-movement-action-direction-threshold' && (value < 0 || value > 1)) || (key === 'server-authoritative-block-breaking-range-scalar' && value <= 1)) fail(`${key} vượt khoảng giá trị hợp lệ.`);
    }
    if (key === 'server-build-radius-ratio' && text !== 'Disabled' && (!text.trim() || !Number.isFinite(Number(text)) || Number(text) < 0 || Number(text) > 1)) fail('server-build-radius-ratio phải là Disabled hoặc số từ 0–1.');
  }
  if (properties['enable-lan-visibility'] !== 'false') fail('Panel đa server cần enable-lan-visibility=false để giữ cổng riêng.');
  if (properties['allow-list'] === 'true' && properties['online-mode'] === 'false') fail('Allowlist cần online-mode=true để xác thực người chơi.');
  return properties;
}

export function debuggerPort(properties) { return properties['allow-inbound-script-debugging'] === 'true' ? Number(properties['force-inbound-debug-port'] || 19144) : null; }
