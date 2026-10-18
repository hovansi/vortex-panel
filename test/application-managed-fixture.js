// Explicit injected managed-runtime authority for offline manager branch tests.
// This is never a native download, build or kernel-enforcement proof.
export function fixtureRuntimePin(kind) {
  const node = kind === 'nodejs', version = node ? 'v26.12.0' : '3.15.0', arch = process.arch;
  return { schema: 1, mode: 'managed', kind, version, platform: 'linux', arch, method: node ? 'official-binary' : 'official-source', source: node ? 'nodejs.org' : 'python.org', url: node ? `https://nodejs.org/dist/${version}/node-${version}-linux-${arch}.tar.xz` : `https://www.python.org/ftp/python/${version}/Python-${version}.tar.xz`, sha256: 'a'.repeat(64), resolvedAt: '2026-10-18T00:00:00.000Z' };
}
export function fixtureManagedRuntime(capabilities) {
  return {
    runtimeCatalog: async () => { const value = capabilities(); return { ...value, managed: true, selection: 'latest-stable', runtimes: Object.fromEntries(Object.entries(value.runtimes || {}).map(([kind, row]) => [kind, { ...row, managedAvailable: value.supported, startupModes: kind === 'nodejs' ? ['entrypoint', 'npm-script'] : ['entrypoint', 'python-module'], prerequisites: { ready: true, missing: [] } }])) }; },
    resolveRuntime: async kind => fixtureRuntimePin(kind),
    ensureRuntime: async server => ({ kind: server.kind, version: server.runtime.version, fixture: true }),
  };
}
