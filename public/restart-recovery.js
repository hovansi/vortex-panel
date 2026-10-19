import { uiText, formatUI } from './i18n.js';
import { serviceText as text, serviceEscape as escape } from './service-ui.js';
import { formatPanelDate } from './timezone.js';

const signatures = new WeakMap();
function presentation(server) {
  const value = server?.restartRecovery;
  const instant = typeof value?.nextAttemptAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.nextAttemptAt) ? Date.parse(value.nextAttemptAt) : NaN;
  const scheduled = Number.isFinite(instant) && new Date(instant).toISOString() === value.nextAttemptAt, paused = value?.paused === true;
  const visible = server?.autoRestart === true && server.status !== 'running' && (paused || scheduled);
  const offline = visible && server.nodeOnline === false;
  const budget = Number.isInteger(value?.attempt) && value.attempt > 0 && Number.isInteger(value?.maxAttempts) && value.maxAttempts >= value.attempt && value.maxAttempts <= 100;
  const window = Number.isInteger(value?.windowSeconds) && value.windowSeconds > 0 && value.windowSeconds <= 86400;
  const attempt = budget ? text(`Recovery attempt ${value.attempt} of ${value.maxAttempts}`, `Lần phục hồi ${value.attempt} / ${value.maxAttempts}`) : '';
  const time = scheduled ? formatUI(new Date(instant), (locale, date) => formatPanelDate(date, locale, { dateStyle: 'medium', timeStyle: 'medium' })) : '';
  return { hidden: !visible, state: offline ? 'unconfirmed' : paused ? 'paused' : 'pending',
    title: offline ? text('Recovery state unconfirmed', 'Chưa xác minh trạng thái phục hồi') : paused ? text('Automatic recovery paused', 'Đã tạm dừng tự phục hồi') : text('Automatic restart scheduled', 'Đã lên lịch tự khởi động lại'),
    message: offline ? text('The node is offline. This is its last reported recovery state; reconnect to verify the actual outcome.', 'VPS mất kết nối. Đây là trạng thái phục hồi được báo gần nhất; kết nối lại để xác minh kết quả thực tế.')
      : paused ? text('The crash recovery limit was reached. Review Console, fix the cause, then use Start to try again.', 'Đã đạt giới hạn phục hồi sau sự cố. Kiểm tra Console, khắc phục nguyên nhân rồi chọn Khởi động để thử lại.')
        : text('Vortex is waiting before retrying. The time below is the scheduled attempt, not a confirmed recovery.', 'Vortex đang chờ trước khi thử lại. Thời điểm bên dưới là lịch thử khởi động, chưa phải xác nhận đã phục hồi.'),
    attempt, window: budget && window ? text(`Up to ${value.maxAttempts} attempts within ${value.windowSeconds} seconds`, `Tối đa ${value.maxAttempts} lần trong ${value.windowSeconds} giây`) : '',
    time, datetime: scheduled ? new Date(instant).toISOString() : '' };
}
export function restartRecoveryMarkup(server) {
  if (typeof server?.id !== 'string' || !server.id) return '';
  const view = presentation(server);
  // Keep the mount even when healthy, so refreshes never replace its DOM.
  return `<section class="restart-recovery" data-restart-recovery="${escape(server.id)}" data-recovery-state="${view.state}" role="status" aria-live="polite" aria-atomic="true"${view.hidden ? ' hidden' : ''}><span class="restart-recovery-symbol" aria-hidden="true"></span><div class="restart-recovery-content"><strong data-recovery-title>${escape(view.title)}</strong><p data-recovery-message>${escape(view.message)}</p><div class="restart-recovery-facts"><span data-recovery-attempt${view.attempt ? '' : ' hidden'}>${escape(view.attempt)}</span><span data-recovery-window${view.window ? '' : ' hidden'}>${escape(view.window)}</span><time data-recovery-time datetime="${escape(view.datetime)}"${view.time ? '' : ' hidden'}>${escape(view.time)}</time></div></div></section>`;
}
export function syncRestartRecovery(root, servers) {
  if (!root?.querySelectorAll) return;
  const current = new Map((Array.isArray(servers) ? servers : []).filter(server => typeof server?.id === 'string').map(server => [server.id, server]));
  for (const element of root.querySelectorAll('[data-restart-recovery]')) {
    const server = current.get(element.dataset.restartRecovery);
    if (!server) { element.hidden = true; signatures.delete(element); continue; }
    const view = presentation(server), signature = JSON.stringify(view);
    if (signatures.get(element) === signature) continue;
    signatures.set(element, signature); element.hidden = view.hidden; element.dataset.recoveryState = view.state;
    for (const [selector, message] of [['title', view.title], ['message', view.message], ['attempt', view.attempt], ['window', view.window], ['time', view.time]]) {
      const target = element.querySelector(`[data-recovery-${selector}]`);
      if (!target) continue;
      uiText(target, message); if (['attempt', 'window', 'time'].includes(selector)) target.hidden = !message;
      if (selector === 'time') target.setAttribute('datetime', view.datetime);
    }
  }
}
