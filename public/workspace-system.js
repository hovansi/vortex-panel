const keys = ['action', 'id', 'serverId', 'nodeId', 'tab', 'view'];
const scalar = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const routeKey = route => typeof route === 'string' && route.length > 0 && route.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(route);
const offset = value => Number.isFinite(value) ? Math.max(0, Math.min(1e9, value)) : 0;
const focusable = element => element?.matches?.('button,a,[role="tab"]') && !element.disabled && element.getAttribute?.('aria-disabled') !== 'true';

function describeFocus(element) {
  if (!focusable(element)) return null;
  if (scalar(element.id)) return { id: element.id };
  if (!scalar(element.dataset?.action)) return null;
  const data = Object.fromEntries(keys.filter(key => scalar(element.dataset[key])).map(key => [key, element.dataset[key]]));
  return { data, tag: element.tagName };
}

function findFocus(root, descriptor) {
  if (!descriptor) return null;
  const candidates = descriptor.id ? [...root.querySelectorAll('[id]')].filter(element => element.id === descriptor.id)
    : [...root.querySelectorAll('[data-action]')].filter(element => element.tagName === descriptor.tag
      && keys.every(key => (element.dataset?.[key] || undefined) === descriptor.data[key]));
  return candidates.length === 1 && focusable(candidates[0]) ? candidates[0] : null;
}

// Retain viewport continuity, not rendered content or draft form values. Callers
// capture the old route before changing it and restore only after their current
// render commits; asynchronous render/navigation ownership stays with the app.
export function createWorkspaceContinuity({ limit = 32 } = {}) {
  const maximum = Number.isInteger(limit) ? Math.max(1, Math.min(128, limit)) : 32;
  const memory = new Map();
  function remember(route, value) {
    memory.delete(route); memory.set(route, value);
    while (memory.size > maximum) memory.delete(memory.keys().next().value);
  }
  return {
    capture(route, root) {
      if (!routeKey(route) || !root) return false;
      const active = root.ownerDocument?.activeElement;
      remember(route, { top: offset(root.scrollTop), left: offset(root.scrollLeft),
        focus: active && root.contains(active) ? describeFocus(active) : null });
      return true;
    },
    restore(route, root, { focus = false } = {}) {
      if (!routeKey(route) || !root) return false;
      const saved = memory.get(route);
      root.scrollTop = saved?.top || 0; root.scrollLeft = saved?.left || 0;
      if (!saved) return false;
      remember(route, saved);
      const active = root.ownerDocument?.activeElement;
      // A persistent navigation control keeps keyboard ownership. Restoring
      // content must not pull focus away from the user's current interaction.
      const outsideControl = active && active !== root.ownerDocument?.body && active !== root && !root.contains(active);
      if (focus && !outsideControl) findFocus(root, saved.focus)?.focus({ preventScroll: true });
      return true;
    },
    reset() { memory.clear(); },
  };
}
