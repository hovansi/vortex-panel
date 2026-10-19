// Persist only a bounded failure window. Panel restarts must not silently reset
// the crash budget and repeatedly relaunch a broken world/application.
export const RESTART_POLICY = Object.freeze({ maxAttempts: 5, windowMs: 10 * 60 * 1000, initialDelayMs: 2000, maxDelayMs: 60000 });

export function restartRecoveryState(input, time = Date.now()) {
  const attempts = (Array.isArray(input?.attempts) ? input.attempts : [])
    .filter(value => Number.isSafeInteger(value) && value > time - RESTART_POLICY.windowMs)
    .map(value => Math.min(value, time)).sort((a, b) => a - b).slice(-RESTART_POLICY.maxAttempts - 1);
  const deadline = typeof input?.nextAttemptAt === 'string' ? Date.parse(input.nextAttemptAt) : NaN;
  return { attempts, paused: input?.paused === true, nextAttemptAt: Number.isFinite(deadline) ? new Date(Math.min(deadline, time + RESTART_POLICY.maxDelayMs)).toISOString() : null };
}

export function recordRestartFailure(input, time = Date.now()) {
  const previous = restartRecoveryState(input, time), attempts = [...previous.attempts, time].slice(-RESTART_POLICY.maxAttempts - 1);
  const paused = previous.paused || attempts.length > RESTART_POLICY.maxAttempts;
  const delay = paused ? null : Math.min(RESTART_POLICY.maxDelayMs, RESTART_POLICY.initialDelayMs * 2 ** (attempts.length - 1));
  return { attempts, paused, nextAttemptAt: delay === null ? null : new Date(time + delay).toISOString() };
}

export function publicRestartRecovery(input, time = Date.now()) {
  const state = restartRecoveryState(input, time);
  return { attempt: state.paused ? RESTART_POLICY.maxAttempts : Math.min(state.attempts.length, RESTART_POLICY.maxAttempts), maxAttempts: RESTART_POLICY.maxAttempts, windowSeconds: RESTART_POLICY.windowMs / 1000, paused: state.paused, nextAttemptAt: state.nextAttemptAt };
}
