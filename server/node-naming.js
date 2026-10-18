// The counter is an atomic part of panel.json, survives unlink/restart, and is
// reserved before asynchronous enrollment. Failed enrollment can leave gaps.
export function createNodeNaming(store) {
  const pattern = /^Vortex Node (\d+)$/;
  const serial = name => { const match = pattern.exec(name || ''); return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : 0; };
  const label = value => `Vortex Node ${String(value).padStart(3, '0')}`;
  const oldNodes = store.data.nodes, oldSequence = store.data.nodeNameSequence;
  if (oldSequence !== undefined && (!Number.isSafeInteger(oldSequence) || oldSequence < 0)) throw new Error('Invalid persisted node name sequence.');
  let changed = false;
  if (!oldNodes.some(node => node.name === 'Vortex Node 001')) {
    let migrated = false;
    store.data.nodes = oldNodes.map(node => {
      if (!migrated && node.name === 'Vortex Node 02') { migrated = true; changed = true; return { ...node, name: 'Vortex Node 001' }; }
      return node;
    });
  }
  const sequence = Math.max(oldSequence || 0, ...store.data.nodes.map(node => serial(node.name)));
  if (oldSequence !== sequence) { store.data.nodeNameSequence = sequence; changed = true; }
  if (changed) {
    try { store.save(); }
    catch (error) { store.data.nodes = oldNodes; if (oldSequence === undefined) delete store.data.nodeNameSequence; else store.data.nodeNameSequence = oldSequence; throw error; }
  }
  function next() {
    let value = store.data.nodeNameSequence;
    do { if (value >= Number.MAX_SAFE_INTEGER) throw Object.assign(new Error('The automatic node name sequence is exhausted.'), { status: 409 }); value++; }
    while (store.data.nodes.some(node => node.name.toLowerCase() === label(value).toLowerCase()));
    return value;
  }
  return {
    preview: () => label(next()),
    reserve(requested) {
      const automatic = requested === undefined || requested === null || requested === '';
      const value = automatic ? next() : serial(requested);
      const name = automatic ? label(value) : requested;
      const before = store.data.nodeNameSequence;
      if (value > before) {
        store.data.nodeNameSequence = value;
        try { store.save(); } catch (error) { store.data.nodeNameSequence = before; throw error; }
      }
      return name;
    },
  };
}
