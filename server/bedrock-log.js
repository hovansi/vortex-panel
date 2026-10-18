// Native Bedrock output is authoritative about severity. In particular, its
// INFO profiler records contain errorMessage=(null), which is not an error.
const header = /^\[(?:\d{4}-\d{2}-\d{2}[^\]\r\n]*\s)?(INFO|WARN|WARNING|ERROR|FATAL|DEBUG|TRACE)\]\s*/i;

export function bedrockLogLevel(line, fallback = 'info') {
  const native = line.match(header)?.[1]?.toLowerCase();
  if (native) return ['error', 'fatal'].includes(native) ? 'error' : ['warn', 'warning'].includes(native) ? 'warn' : 'info';
  if (/\b(?:error|failed|fatal)\b/i.test(line)) return 'error';
  if (/\b(?:warn|warning)\b/i.test(line)) return 'warn';
  return fallback;
}

export function trackBedrockPlayer(online, line) {
  const message = line.replace(header, '');
  const event = message.match(/^Player (connected|disconnected):\s*(.+?),\s*xuid:\s*(\d*)(?=\s*(?:,|$))/i);
  if (!event) return false;
  const name = event[2].trim(), xuid = event[3];
  if (!name) return false;
  // Offline clients can have an empty or zero XUID. Do not merge all of them
  // into one player, and do not invent an authenticated Xbox identity.
  const key = /[1-9]/.test(xuid) ? `xuid:${xuid}` : `name:${name.toLocaleLowerCase('en-US')}`;
  if (event[1].toLowerCase() === 'connected') online.set(key, { name, xuid });
  else online.delete(key);
  return true;
}
