// Keep pending feedback attached to the original control; never replace its text.
const pending = new WeakMap();
export function beginButtonBusy(button, { delay = 100 } = {}) {
  if (!button?.setAttribute) return () => {};
  const active = pending.get(button);
  if (active) { active.users++; return releaseOnce(button, active); }
  const state = { users: 1, previous: button.getAttribute('aria-busy'), timer: null, styles: new Map() };
  pending.set(button, state);
  button.dataset.pending = 'true';
  button.setAttribute('aria-busy', 'true');
  state.timer = setTimeout(() => {
    if (pending.get(button) !== state || !button.isConnected) return;
    const icon = button.querySelector?.(':scope > .icon');
    button.dataset.busyIcon = icon ? 'true' : 'none';
    const box = button.getBoundingClientRect?.(), glyph = icon?.getBoundingClientRect?.();
    const color = typeof getComputedStyle === 'function' ? getComputedStyle(button).color : 'currentColor';
    for (const [key, value] of [['--busy-ink', color], ['--busy-x', glyph && box ? `${glyph.left - box.left + glyph.width / 2}px` : '50%'], ['--busy-y', glyph && box ? `${glyph.top - box.top + glyph.height / 2}px` : '50%']]) {
      if (!button.style?.setProperty) continue;
      state.styles.set(key, button.style.getPropertyValue(key));
      button.style.setProperty(key, value);
    }
    button.dataset.busy = 'true';
  }, delay);
  return releaseOnce(button, state);
}
function releaseOnce(button, state) { let finished = false; return () => { if (!finished) { finished = true; release(button, state); } }; }
function release(button, state) {
  if (pending.get(button) !== state || --state.users > 0) return;
  clearTimeout(state.timer);
  pending.delete(button);
  delete button.dataset.pending;
  delete button.dataset.busy;
  delete button.dataset.busyIcon;
  for (const [key, value] of state.styles) value ? button.style.setProperty(key, value) : button.style.removeProperty(key);
  if (state.previous === null) button.removeAttribute('aria-busy');
  else button.setAttribute('aria-busy', state.previous);
}
export async function withButtonBusy(button, task, options) {
  const finish = beginButtonBusy(button, options);
  try { return await task(); } finally { finish(); }
}
