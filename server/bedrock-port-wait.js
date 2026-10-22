import fs from 'node:fs/promises';

const MAX_TABLE_BYTES = 16 * 1024 ** 2;
export const BEDROCK_PORT_WAIT_POLICY = Object.freeze({ timeoutMs: 65000, intervalMs: 250 });
const MESSAGES = Object.freeze({
  BEDROCK_PORT_WAITING: { id: 'panel.bedrock.port-wait', en: 'Waiting for TCP port {0} to finish closing. The server will start automatically.', vi: 'Đang chờ cổng TCP {0} đóng kết nối cũ. Máy chủ sẽ tự khởi động.' },
  BEDROCK_PORT_WAIT_TIMEOUT: { id: 'panel.bedrock.port-wait-timeout', en: 'TCP port {0} is still closing. Try starting the server again shortly.', vi: 'Cổng TCP {0} vẫn đang đóng kết nối cũ. Hãy thử khởi động lại sau ít phút.' },
  BEDROCK_PORT_WAIT_INVENTORY: { id: 'panel.bedrock.port-wait-inventory', en: 'TCP port {0} could not be verified. Check the node before starting the server again.', vi: 'Không xác minh được cổng TCP {0}. Kiểm tra VPS trước khi khởi động lại máy chủ.' },
  BEDROCK_PORT_WAIT_STALE: { id: 'panel.bedrock.port-wait-stale', en: 'Server settings changed while waiting for TCP port {0}. Start the server again.', vi: 'Cấu hình máy chủ đã thay đổi trong khi chờ cổng TCP {0}. Hãy khởi động lại máy chủ.' },
  BEDROCK_PORT_WAIT_CANCELLED: { id: 'panel.bedrock.port-wait-cancelled', en: 'The pending start on TCP port {0} was cancelled.', vi: 'Đã hủy khởi động đang chờ cổng TCP {0}.' },
});
export const BEDROCK_PORT_WAIT_MESSAGES = Object.freeze(Object.values(MESSAGES));
export function bedrockPortWaitMessage(code, port) {
  const message = MESSAGES[code];
  if (!message) throw new Error('Invalid Bedrock port wait message.');
  return { ...message, en: message.en.replace('{0}', String(port)), vi: message.vi.replace('{0}', String(port)), params: [port] };
}
export function bedrockPortWaitIssue(code, port) {
  const errorI18n = bedrockPortWaitMessage(code, port);
  return Object.assign(new Error(errorI18n.vi), { code, port, status: 409, errorI18n });
}
export function bedrockPortWaitErrorPayload(error, language = 'en') {
  if (!Object.hasOwn(MESSAGES, error?.code) || error.code === 'BEDROCK_PORT_WAITING') return null;
  const params = error?.errorI18n?.params;
  const port = error?.port === undefined ? Array.isArray(params) && params.length === 1 ? params[0] : null : error.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || params !== undefined && (!Array.isArray(params) || params.length !== 1 || params[0] !== port)) return null;
  const errorI18n = bedrockPortWaitMessage(error.code, port);
  return { error: language === 'vi' ? errorI18n.vi : errorI18n.en, code: error.code, errorI18n };
}
export const isPrimaryBedrockTcpBindError = (error, port) => error?.code === 'EADDRINUSE' && error.protocol === 'tcp' && error.port === port;

async function readTable(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const chunks = []; let length = 0;
    while (true) {
      const bytes = Buffer.allocUnsafe(Math.min(65536, MAX_TABLE_BYTES + 1 - length));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > MAX_TABLE_BYTES) throw new Error('TCP inventory exceeded its bound.');
      chunks.push(bytes.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally { await handle.close(); }
}
export async function readBedrockTcpPortStates(port, { readFile = readTable, platform = process.platform } = {}) {
  if (platform !== 'linux' || !Number.isInteger(port) || port < 1 || port > 65535) throw bedrockPortWaitIssue('BEDROCK_PORT_WAIT_INVENTORY', port);
  try {
    const values = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(filename => readFile(filename, 'utf8')));
    const states = [];
    for (const [index, value] of values.entries()) {
      if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_TABLE_BYTES) throw new Error('Invalid TCP inventory.');
      const lines = value.trim().split('\n');
      if (!/^\s*sl\s+local_address\s+(?:rem|remote)_address\s+st\b/.test(lines.shift() || '')) throw new Error('Unknown TCP inventory header.');
      const address = new RegExp('^[a-f0-9]{' + (index === 0 ? 8 : 32) + '}:[a-f0-9]{4}$', 'i');
      for (const line of lines) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10 || !/^\d+:$/.test(fields[0]) || !address.test(fields[1]) || !address.test(fields[2]) || !/^(?:0[1-9a-c])$/i.test(fields[3]) || !/^\d+$/.test(fields[7]) || !/^\d+$/.test(fields[9])) throw new Error('Unknown TCP inventory row.');
        if (Number.parseInt(fields[1].slice(-4), 16) === port) states.push(fields[3].toUpperCase());
      }
    }
    return states;
  } catch (error) {
    if (error.code === 'BEDROCK_PORT_WAIT_INVENTORY') throw error;
    throw bedrockPortWaitIssue('BEDROCK_PORT_WAIT_INVENTORY', port);
  }
}
function abortablePause(milliseconds, signal, port) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const abort = () => finish(bedrockPortWaitIssue('BEDROCK_PORT_WAIT_CANCELLED', port));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(), milliseconds);
  });
}
export function createBedrockPortWait({ readFile, platform = process.platform, clock = () => performance.now(), pause = abortablePause, timeoutMs = BEDROCK_PORT_WAIT_POLICY.timeoutMs, intervalMs = BEDROCK_PORT_WAIT_POLICY.intervalMs } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BEDROCK_PORT_WAIT_POLICY.timeoutMs || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 1000) throw new Error('Invalid Bedrock port wait policy.');
  return {
    async wait({ port, initialError, probe, isCurrent, signal, onWait }) {
      if (platform !== 'linux' || !isPrimaryBedrockTcpBindError(initialError, port)) throw initialError;
      const began = clock(); let announced = false, bindError = initialError;
      const check = () => {
        if (signal?.aborted) throw bedrockPortWaitIssue('BEDROCK_PORT_WAIT_CANCELLED', port);
        if (isCurrent() !== true) throw bedrockPortWaitIssue('BEDROCK_PORT_WAIT_STALE', port);
        if (clock() - began >= timeoutMs) throw bedrockPortWaitIssue('BEDROCK_PORT_WAIT_TIMEOUT', port);
      };
      while (true) {
        check();
        if (clock() - began >= timeoutMs) throw bedrockPortWaitIssue('BEDROCK_PORT_WAIT_TIMEOUT', port);
        const states = await readBedrockTcpPortStates(port, { readFile, platform });
        check();
        if (states.some(state => state !== '06')) throw bindError;
        if (states.length) {
          if (!announced) { await onWait({ timeoutMs, remainingMs: Math.max(0, timeoutMs - (clock() - began)) }); announced = true; check(); }
          await pause(Math.min(intervalMs, Math.max(1, timeoutMs - (clock() - began))), signal, port);
          check();
          continue;
        }
        try { await probe(); check(); return { waited: announced }; }
        catch (error) { check(); if (!isPrimaryBedrockTcpBindError(error, port)) throw error; bindError = error; }
        // A new collision must be verified again; an empty/unknown inventory
        // cannot turn an unexplained bind failure into an accepted launch.
        const retryStates = await readBedrockTcpPortStates(port, { readFile, platform });
        check();
        if (!retryStates.length || retryStates.some(state => state !== '06')) throw bindError;
        if (!announced) { await onWait({ timeoutMs, remainingMs: Math.max(0, timeoutMs - (clock() - began)) }); announced = true; check(); }
        await pause(Math.min(intervalMs, Math.max(1, timeoutMs - (clock() - began))), signal, port);
      }
    },
  };
}
