import { buildWorldVoice, parseWorldVoicePreview } from '../public/world-voice.js';

// This is server metadata, independent of request or browser UI languages.
export const serverMessageLanguage = server => server.messageLanguage === 'vi' ? 'vi' : 'en';
export const serverWorldVoiceEnabled = server => server.worldVoiceEnabled !== false;

export function dispatchConsoleLine({ write, log, audit }) {
  // The write callback enqueues a line into the owned runtime's stdin. Its
  // boolean return value is backpressure; a synchronous throw is rejection.
  write();
  const result = { ok: true, acceptedToConsole: true, auditRecorded: false }, warnings = [];
  try { log(); } catch { warnings.push('Lệnh đã được nhận nhưng không thể cập nhật log console.'); }
  try { audit(); result.auditRecorded = true; } catch { warnings.push('Lệnh đã được nhận nhưng không thể ghi nhật ký hoạt động.'); }
  if (warnings.length) result.warnings = warnings;
  return result;
}

const nativeInfo = /^\[(?:\d{4}-\d{2}-\d{2}[^\]\r\n]*\s)?INFO\]\s*/;
const playerKey = (name, xuid) => /[1-9]/.test(xuid) ? `xuid:${xuid}` : `name:${name.toLocaleLowerCase('en-US')}`;

// Only called on real child stdout/stderr. Connected alone does not establish
// that a player has reached a world; wait for the separate Player Spawned line.
export function parseNativeWorldVoiceEvent(line) {
  if (typeof line !== 'string' || !nativeInfo.test(line)) return null;
  const message = line.replace(nativeInfo, '');
  const spawned = message.match(/^Player Spawned:\s*(.+?)\s+xuid:\s*(\d*)(?=\s*(?:,|$))/);
  if (spawned?.[1].trim()) return { type: 'spawn', name: spawned[1].trim(), key: playerKey(spawned[1].trim(), spawned[2]) };
  const disconnected = message.match(/^Player disconnected:\s*(.+?),\s*xuid:\s*(\d*)(?=\s*(?:,|$))/i);
  if (disconnected?.[1].trim()) return { type: 'disconnect', name: disconnected[1].trim(), key: playerKey(disconnected[1].trim(), disconnected[2]) };
  return null;
}

export function createNativeWorldVoice({ server, online, send, onWarning = () => {} }) {
  const welcomed = new Set();
  const warn = () => { try { onWarning(); } catch {} };
  return {
    consume(line) {
      const event = parseNativeWorldVoiceEvent(line);
      if (!event) return false;
      if (event.type === 'disconnect') { welcomed.delete(event.key); return false; }
      const player = online.get(event.key);
      if (!player || player.name !== event.name || welcomed.has(event.key) || server.status !== 'running' || !serverWorldVoiceEnabled(server)) return false;
      try {
        const message = buildWorldVoice({ templateId: 'welcome', values: { worldName: server.name, playerName: player.name }, language: serverMessageLanguage(server), method: 'say' });
        const receipt = send(message.command);
        if (receipt?.acceptedToConsole !== true) return false;
        welcomed.add(event.key); return true;
      } catch { warn(); return false; }
    }
  };
}

export function buildGracefulWorldPause(server, reason = 'stop') {
  const language = serverMessageLanguage(server);
  const templateId = reason === 'restart' ? 'restart' : reason === 'backup' ? 'backup' : 'maintenance';
  const values = templateId === 'restart' ? { seconds: 3 } : templateId === 'backup' ? { phase: 'planned' } : { phase: 'planned' };
  const message = buildWorldVoice({ templateId, values, language, method: 'say' });
  if (templateId === 'restart') return message;
  // Unlike a countdown this is one truthful announcement before a bounded
  // three-second grace period. There is no claim that the operation completed.
  const timing = language === 'vi' ? ' §eServer sẽ dừng sau §f3 giây§e.' : ' §eThe server will pause in §f3 seconds§e.';
  message.message = message.message.slice(0, -2) + timing + '§r';
  message.command = `say ${message.message}`;
  message.segments = parseWorldVoicePreview(message.message);
  message.plainText = message.segments.map(segment => segment.text).join('');
  return message;
}

// Failure to compose/send/audit an optional notice must never block a safe
// shutdown. A successful stdin enqueue is not evidence of client receipt.
export async function announceGracefulWorldPause({ server, reason, send, wait, onWarning = () => {} }) {
  if (!serverWorldVoiceEnabled(server) || !(server.players > 0)) return false;
  try {
    const message = buildGracefulWorldPause(server, reason);
    if (send(message.command)?.acceptedToConsole !== true) return false;
    await wait(3000); return true;
  } catch { try { onWarning(); } catch {} return false; }
}
