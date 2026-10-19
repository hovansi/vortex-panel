import { fail } from './safety.js';
import { nativeGameplayBody } from './gameplay.js';

export function validateSchedule(input, previous = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['serverId', 'action', 'intervalMinutes', 'enabled', 'command'].includes(key))) fail('Thiết lập lịch tác vụ không hợp lệ.');
  const action = input.action === undefined ? previous.action : input.action;
  if (!['backup', 'restart', 'command'].includes(action)) fail('Tác vụ lịch không hợp lệ.');
  const intervalMinutes = Number(input.intervalMinutes ?? previous.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 525600) fail('Chu kỳ phải từ 1 phút đến 1 năm.');
  const enabled = input.enabled === undefined ? previous.enabled ?? true : input.enabled;
  if (typeof enabled !== 'boolean') fail('Trạng thái lịch phải là boolean.');
  const value = input.command === undefined ? previous.command ?? null : input.command;
  if (value !== null && typeof value !== 'string') fail('Lệnh lịch không hợp lệ.');
  const command = typeof value === 'string' ? value.trim() : null;
  if ((action === 'command' && !command) || (typeof value === 'string' && (value.length > 2048 || /[\r\n\0]/.test(value))) || (command && /^\/?(?:stop|restart)(?:\s|$)/i.test(command))) fail('Lệnh lịch phải là một dòng không quá 2048 ký tự; dùng tác vụ restart để điều khiển vòng đời.');
  // Backup and restart may carry a command that runs before their main action.
  // A missing PATCH field preserves it; an explicit empty field removes it.
  return { action, intervalMinutes, enabled, command: command || null };
}

const nativeInfo = /^\[(?:\d{4}-\d{2}-\d{2}[^\]\r\n]*\s)?INFO\]\s*/;
const nativeError = /^\[(?:\d{4}-\d{2}-\d{2}[^\]\r\n]*\s)?ERROR\]\s*/;

export function parseScheduleCommandFeedback(line, command) {
  const body = nativeGameplayBody(line);
  if (!body) return null;
  if (nativeError.test(line) || /^(?:No targets matched selector\.?|That (?:player|entity) cannot be found\.?|You (?:do not|don't) have permission\b|Incorrect permission level\b|Cheats (?:are not|aren't) enabled\b|Commands (?:are not|aren't) enabled\b|Syntax error:|Unknown command:|Invalid command syntax:|Incorrect argument for command\b|Cannot |Could not |Couldn't |Failed to )/i.test(body)) return { status: 'rejected', confirmedApplied: false, reasonCode: 'native-command-rejected', nativeFeedback: body.slice(0, 2048) };
  const say = /^\/?say\s+(.+)$/i.exec(command);
  // Native console output can acknowledge the broadcast, but it cannot prove
  // that a particular game client received or displayed the message.
  if (say && nativeInfo.test(line) && body === `[Server] ${say[1]}`) return { status: 'confirmed', confirmedApplied: true, reasonCode: 'native-say-acknowledgement', nativeFeedback: body.slice(0, 2048) };
  return null;
}

export async function dispatchScheduledCommand({ command, console, send }) {
  if (!console) {
    const result = send(command);
    const acceptedToConsole = result?.acceptedToConsole === true;
    return { ...result, status: acceptedToConsole ? 'dispatched' : 'not-sent', acceptedToConsole, confirmedApplied: false, clientReceiptConfirmed: false, correlation: { method: 'application-stdin', completed: false }, reasonCode: acceptedToConsole ? 'application-stdin-enqueued' : 'application-stdin-not-accepted' };
  }
  return console.run(async channel => {
    try { await channel.fence(); }
    catch (error) { return { status: 'not-sent', acceptedToConsole: false, confirmedApplied: false, clientReceiptConfirmed: false, reasonCode: 'native-fence-unavailable', message: error.message, correlation: { method: 'native-console-fences', completed: false } }; }
    const result = await channel.exchange(command, line => parseScheduleCommandFeedback(line, command), { endFence: true });
    const ordered = result.boundaryConfirmed === true;
    // Generic commands do not expose a universal success response. Reaching
    // the closing fence establishes ordering, never arbitrary gameplay success.
    const status = result.status === 'rejected' ? 'rejected' : result.status === 'confirmed' ? 'confirmed' : ordered && result.reasonCode === 'feedback-unconfirmed' ? 'dispatched' : 'unconfirmed';
    return { ...result, status, acceptedToConsole: result.acceptedToConsole === true, confirmedApplied: status === 'confirmed' && result.confirmedApplied === true, clientReceiptConfirmed: false, reasonCode: status === 'dispatched' ? 'native-console-ordered' : result.reasonCode, correlation: { method: 'native-console-fences', completed: ordered } };
  });
}
