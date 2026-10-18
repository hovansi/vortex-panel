// One bounded historical sample. It must never be used as a live enforcement
// or usage claim after the owned process/cgroup has been removed.
const counters = ['memoryCurrentBytes', 'memoryPeakBytes', 'cpuUsageUsec', 'nrThrottled', 'throttledUsec', 'oomKills', 'oomEvents', 'memoryMaxEvents'];
export const MEMORY_LIMIT_EXIT_MESSAGE = 'Bedrock bị hệ điều hành dừng vì vượt giới hạn RAM đã cấu hình của server.';
export const RESOURCE_EXIT_MESSAGES = Object.freeze(['Node.js', 'Python'].map(name => Object.freeze({
  id: `panel.application.memory-limit.${name === 'Python' ? 'python' : 'nodejs'}`,
  en: `${name} was stopped by the operating system after exceeding this application's configured memory limit.`,
  vi: `${name} bị hệ điều hành dừng vì vượt giới hạn RAM đã cấu hình của ứng dụng.`,
})));
export function memoryLimitExitMessage(kind) {
  return RESOURCE_EXIT_MESSAGES.find(message => message.id.endsWith('.' + kind))?.vi || MEMORY_LIMIT_EXIT_MESSAGE;
}
export function recordResourceExit({ policy, stats, pid, code, signal, time = new Date().toISOString() }) {
  if (policy?.mode !== 'fixed') return null;
  const usage = stats ? Object.fromEntries(counters.map(key => [key, Number.isSafeInteger(stats[key]) && stats[key] >= 0 ? stats[key] : null])) : null;
  return {
    time: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) ? time : new Date().toISOString(),
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    code: Number.isInteger(code) && code >= 0 && code <= 255 ? code : null,
    signal: typeof signal === 'string' && /^SIG[A-Z0-9]{1,24}$/.test(signal) ? signal : null,
    policy: { mode: 'fixed', cpuCores: policy.cpuCores, memoryMiB: policy.memoryMiB },
    usage,
    kernelEnforcedAtExit: stats?.effective?.kernelEnforced === true,
    reason: usage?.oomKills > 0 ? 'memory-limit' : 'native-exit'
  };
}
