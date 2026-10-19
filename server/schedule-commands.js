import { fail } from './safety.js';
import { nativeGameplayBody } from './gameplay.js';

export const SCHEDULE_COMMAND_CAPABILITIES = Object.freeze({ schemaVersion: 1, optionalPreCommands: true });
const compatibilityMessages = Object.freeze({
  SCHEDULE_NODE_UPGRADE_REQUIRED: ['This worker cannot preserve and run commands before backups or restarts. Upgrade its agent first. No schedule request was sent.', 'Worker này chưa hỗ trợ lưu và chạy lệnh trước khi sao lưu hoặc khởi động lại. Hãy cập nhật agent của VPS này trước. Chưa gửi yêu cầu thay đổi lịch.'],
  SCHEDULE_NODE_UNVERIFIED: ['The worker’s current schedule support could not be verified. No schedule request was sent. Reconnect the worker and try again.', 'Không xác minh được khả năng hỗ trợ lịch hiện tại của worker. Chưa gửi yêu cầu thay đổi lịch. Kết nối lại worker rồi thử lại.'],
  SCHEDULE_NODE_ACK_MISMATCH: ['The worker did not confirm the requested schedule and command. The change may already exist on that VPS. Refresh its schedules and upgrade the agent before retrying; this request was not retried.', 'Worker không xác nhận đúng lịch và lệnh được yêu cầu. Thay đổi có thể đã được lưu trên VPS đó. Tải lại danh sách lịch và cập nhật agent trước khi thử lại; panel không tự gửi lại yêu cầu.'],
});
export function scheduleCommandIssue(code) {
  const [en, vi] = compatibilityMessages[code];
  const outcomeUnknown = code === 'SCHEDULE_NODE_ACK_MISMATCH';
  return Object.assign(new Error(en), { code, status: outcomeUnknown ? 502 : code === 'SCHEDULE_NODE_UPGRADE_REQUIRED' ? 409 : 503, outcomeUnknown });
}
export function scheduleCommandErrorPayload(error, language = 'en') {
  if (!Object.hasOwn(compatibilityMessages, error?.code)) return null;
  const pair = compatibilityMessages[error.code];
  const [en, vi] = pair;
  return { error: language === 'vi' ? vi : en, code: error.code, errorI18n: { id: `panel.schedules.${error.code.toLowerCase()}`, en, vi, params: [] }, outcomeUnknown: error.code === 'SCHEDULE_NODE_ACK_MISMATCH', retryable: false };
}
export function supportsSchedulePreCommands(capability, version) {
  // Explicit contracts take precedence, including an explicit unsupported value.
  if (capability !== undefined) return capability?.schemaVersion === 1 && capability.optionalPreCommands === true;
  // Released 0.20.1 already preserved optional commands. Older or unrecognized
  // agents must never silently downgrade a backup/restart to command:null.
  if (typeof version !== 'string' || version.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
  const [major, minor, patch] = version.split('.').map(Number);
  return [major, minor, patch].every(Number.isSafeInteger) && (major > 0 || minor > 20 || minor === 20 && patch >= 1);
}

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
