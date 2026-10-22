// Keep focused forms inside the visible viewport when a touch keyboard opens.
export function installWorkspaceViewport({ window: view = globalThis.window, document: doc = globalThis.document } = {}) {
  if (!view?.visualViewport || !doc?.documentElement) return () => {};
  const viewport = view.visualViewport, root = doc.documentElement;
  const coarse = view.matchMedia('(any-pointer: coarse)');
  const excluded = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'hidden', 'image']);
  const properties = ['--keyboard-viewport-height', '--keyboard-viewport-top'];
  let frame = 0, disposed = false;
  function update() {
    frame = 0;
    if (disposed) return;
    const active = doc.activeElement;
    const editable = active?.isContentEditable || active?.tagName === 'TEXTAREA' || active?.tagName === 'INPUT' && !excluded.has(active.type);
    const height = Number(viewport.height), top = Number(viewport.offsetTop);
    const keyboard = Boolean(coarse.matches && editable && Math.abs(Number(viewport.scale) - 1) < .025 && Number.isFinite(height) && height > 0 && view.innerHeight - height > 120);
    if (keyboard) {
      root.dataset.virtualKeyboard = 'open';
      const values = [Math.round(height) + 'px', Math.max(0, Number.isFinite(top) ? Math.round(top) : 0) + 'px'];
      properties.forEach((property, index) => { if (root.style.getPropertyValue(property) !== values[index]) root.style.setProperty(property, values[index]); });
    } else {
      delete root.dataset.virtualKeyboard;
      for (const property of properties) root.style.removeProperty(property);
    }
  }
  function schedule() { if (!disposed && !frame) frame = view.requestAnimationFrame(update); }
  const targets = [[viewport, 'resize'], [viewport, 'scroll'], [view, 'resize'], [doc, 'focusin'], [doc, 'focusout']];
  for (const [target, event] of targets) target.addEventListener(event, schedule, { passive: true });
  schedule();
  return () => {
    disposed = true;
    if (frame) view.cancelAnimationFrame(frame);
    for (const [target, event] of targets) target.removeEventListener(event, schedule);
    delete root.dataset.virtualKeyboard;
    for (const property of properties) root.style.removeProperty(property);
  };
}

if (typeof window !== 'undefined') installWorkspaceViewport();
