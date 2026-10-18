import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { applicationIssue } from './application-schema.js';
import { normalizeRuntimePin, PYTHON_BUILD_RESOURCES } from './application-runtime-catalog.js';
import { APPLICATION_RUNTIME_ARTIFACT } from './application-runtime-artifact.js';

export const PYTHON_BUILD_PACKAGES = Object.freeze(['gcc', 'make', 'pkg-config', 'libssl-dev', 'zlib1g-dev', 'libbz2-dev', 'libreadline-dev', 'libsqlite3-dev', 'libffi-dev', 'liblzma-dev', 'libncurses-dev', 'libgdbm-dev', 'uuid-dev', 'libzstd-dev']);
export const PYTHON_BUILD_TOOLS = Object.freeze(['/usr/bin/gcc', '/usr/bin/make', '/usr/bin/pkg-config', '/usr/bin/nice', '/usr/bin/awk']);
export const PYTHON_BUILD_HEADERS = Object.freeze(['/usr/include/openssl/ssl.h', '/usr/include/zlib.h', '/usr/include/bzlib.h', '/usr/include/readline/readline.h', '/usr/include/sqlite3.h', '/usr/include/lzma.h', '/usr/include/ncurses.h', '/usr/include/gdbm.h', '/usr/include/uuid/uuid.h', '/usr/include/zstd.h']);
const noFile = error => error?.code === 'ENOENT';

// Cache contents are immutable, root-owned and read-only inside every sandbox.
// The only downloaded code ever executed is launched by the caller after UID
// drop, through its existing cgroup/private-mount/bubblewrap control path.
export function createManagedRuntimeStore({ dataDir, fs: io = fs, fetch: request = globalThis.fetch, trustedFile, canonical, command, python = '/usr/bin/python3', arch = process.arch, timeoutMs = 120000, downloadTimeoutMs = 15 * 60 * 1000 } = {}) {
  const root = path.join(dataDir, '.application-runtimes'), workRoot = path.join(dataDir, '.application-runtime-builds'), locks = new Map();
  let closed = false; const controllers = new Set();
  let initializingRoots;
  const ensureOpen = () => { if (closed) throw applicationIssue('APPLICATION_CLOSED', 503); };
  const pinOf = pin => normalizeRuntimePin(pin, { arch });
  const keyOf = pin => `${pin.kind}-${pin.version}-linux-${pin.arch}`;
  async function exists(filename) { try { return await io.lstat(filename); } catch (error) { if (noFile(error)) return null; throw error; } }
  async function directory(filename, mode) { if (!await exists(filename)) try { await io.mkdir(filename, { mode }); await io.chmod(filename, mode); } catch (error) { if (error.code !== 'EEXIST') throw error; } await canonical(filename); const stat = await io.lstat(filename); if ((stat.mode & 0o777) !== mode) throw applicationIssue('APPLICATION_PATH'); }
  async function roots() { ensureOpen(); if (!initializingRoots) initializingRoots = (async () => { await canonical(dataDir); await directory(root, 0o755); await directory(workRoot, 0o700); })().catch(error => { initializingRoots = null; throw error; }); await initializingRoots; }
  function descriptor(pin, prefix) {
    return pin.kind === 'nodejs' ? { prefix, mount: '/runtime/node', executable: '/runtime/node/bin/node', hostExecutable: path.join(prefix, 'bin/node'), nodeDirectory: '/runtime/node/bin', npm: '/runtime/node/lib/node_modules/npm/bin/npm-cli.js', version: pin.version }
      : { prefix, mount: '/runtime/python', executable: `/runtime/python/bin/python${pin.version.split('.').slice(0, 2).join('.')}`, hostExecutable: path.join(prefix, 'bin', `python${pin.version.split('.').slice(0, 2).join('.')}`), nodeDirectory: '/usr/bin', version: `Python ${pin.version}` };
  }
  async function verifyTree(prefix) {
    const pending = [prefix]; let count = 0, bytes = 0;
    while (pending.length) {
      const filename = pending.pop(), stat = await io.lstat(filename);
      if (++count > 100000 || stat.uid !== 0 || !stat.isSymbolicLink() && stat.mode & 0o022 || !stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw applicationIssue('APPLICATION_PATH');
      if (stat.isSymbolicLink()) { const resolved = await io.realpath(filename); if (resolved !== prefix && !resolved.startsWith(prefix + path.sep)) throw applicationIssue('APPLICATION_PATH'); }
      else if (stat.isDirectory()) for (const name of await io.readdir(filename)) pending.push(path.join(filename, name));
      else if ((bytes += stat.size) > 2 * 1024 ** 3) throw applicationIssue('APPLICATION_PATH');
    }
  }
  async function installed(input) {
    const pin = pinOf(input), target = path.join(root, keyOf(pin));
    if (!await exists(target)) return null;
    await canonical(target); await trustedFile(path.join(target, '.runtime.json'));
    const manifest = JSON.parse(await io.readFile(path.join(target, '.runtime.json'), 'utf8'));
    const saved = pinOf(manifest.pin);
    if (saved.kind !== pin.kind || saved.version !== pin.version || saved.sha256 !== pin.sha256 || manifest.schema !== 1 || manifest.validated !== true) throw applicationIssue('APPLICATION_RUNTIME_PIN');
    const selected = descriptor(pin, path.join(target, 'prefix'));
    await canonical(selected.prefix); await trustedFile(selected.hostExecutable, true);
    if (pin.kind === 'nodejs') await trustedFile(path.join(selected.prefix, 'lib/node_modules/npm/bin/npm-cli.js'));
    // The private cache was verified as a whole on promotion. Revalidate every
    // start too: app processes cannot replace writable libraries under a pin.
    await verifyTree(selected.prefix); return selected;
  }
  async function prerequisites() {
    const missing = [];
    for (const filename of [...PYTHON_BUILD_TOOLS, ...PYTHON_BUILD_HEADERS]) { try { await trustedFile(filename, PYTHON_BUILD_TOOLS.includes(filename)); } catch { missing.push(filename); } }
    // libffi uses a multiarch header path on Ubuntu; pkg-config is the trusted
    // authority for that development package rather than a guessed architecture.
    if (!missing.includes('/usr/bin/pkg-config')) try { await command('/usr/bin/pkg-config', ['--exists', 'libffi'], { timeout: 10000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }); } catch { missing.push('libffi (pkg-config)'); }
    return { ready: missing.length === 0, missing, packages: [...PYTHON_BUILD_PACKAGES], resources: { ...PYTHON_BUILD_RESOURCES } };
  }
  async function download(pin, destination, { signal, onProgress }) {
    const controller = new AbortController(), abort = () => controller.abort(); controllers.add(controller); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    let timer, file, reader; const maximum = 256 * 1024 ** 2, wallTimer = setTimeout(abort, downloadTimeoutMs);
    const deadline = () => { clearTimeout(timer); timer = setTimeout(abort, timeoutMs); };
    try {
      deadline(); const response = await request(pin.url, { redirect: 'error', signal: controller.signal, headers: { 'User-Agent': 'VortexPanel-Runtime/1' } });
      if (!response.ok || response.url && response.url !== pin.url || !response.body) throw applicationIssue('APPLICATION_RUNTIME_DOWNLOAD', 502);
      const length = response.headers.get('content-length'), totalBytes = length && /^\d+$/.test(length) ? Number(length) : null;
      if (totalBytes !== null && (!Number.isSafeInteger(totalBytes) || totalBytes > maximum || totalBytes < 1)) throw applicationIssue('APPLICATION_RUNTIME_DOWNLOAD', 502);
      file = await io.open(destination, 'wx', 0o600); const hash = createHash('sha256'); let loadedBytes = 0; reader = response.body.getReader();
      for (;;) { const part = await reader.read(); if (part.done) break; deadline(); loadedBytes += part.value.byteLength; if (loadedBytes > maximum || signal?.aborted || closed) throw applicationIssue('APPLICATION_RUNTIME_DOWNLOAD', 502); hash.update(part.value); await file.writeFile(part.value); onProgress?.({ phase: 'runtime-download', transfer: { loadedBytes, totalBytes } }); }
      await file.sync(); if (!loadedBytes || totalBytes !== null && loadedBytes !== totalBytes || hash.digest('hex') !== pin.sha256) throw applicationIssue('APPLICATION_RUNTIME_DOWNLOAD', 502);
    } catch (error) { if (error?.code?.startsWith('APPLICATION_')) throw error; throw applicationIssue('APPLICATION_RUNTIME_DOWNLOAD', 502); }
    finally { clearTimeout(timer); clearTimeout(wallTimer); await reader?.cancel().catch(() => {}); await file?.close(); controllers.delete(controller); signal?.removeEventListener('abort', abort); }
  }
  async function artifact(args) { const result = await command(python, ['-I', '-c', APPLICATION_RUNTIME_ARTIFACT, ...args], { timeout: 120000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }); if (JSON.parse(result.stdout)?.ok !== true) throw applicationIssue('APPLICATION_RUNTIME_BUILD'); }
  async function ensure(input, options = {}) {
    ensureOpen(); const pin = pinOf(input); await roots(); const present = await installed(pin); if (present) return present;
    const key = keyOf(pin);
    // A waiter observes the same exact artifact/checksum; no second build can
    // replace a version selected by another simultaneous create request.
    if (locks.has(key)) { const outcome = await locks.get(key); if (outcome.sha256 !== pin.sha256) throw applicationIssue('APPLICATION_RUNTIME_PIN'); return outcome.selected; }
    const operation = (async () => {
      let release = () => {}, workspace, volume, unsafeCleanup = false;
      try {
        if (pin.kind === 'python' && !(await prerequisites()).ready) throw applicationIssue('APPLICATION_RUNTIME_TOOLS');
        if (typeof options.reserve !== 'function') throw applicationIssue('APPLICATION_RUNTIME_BUILD');
        release = await options.reserve(pin.kind === 'python' ? PYTHON_BUILD_RESOURCES : { cpuCores: 0.1, memoryMiB: 256, diskBytes: 2 * 1024 ** 3 });
        ensureOpen(); workspace = await io.mkdtemp(path.join(workRoot, '.install-')); await io.chmod(workspace, 0o700);
        options.onProgress?.({ phase: 'runtime-download' }); const archive = path.join(workspace, 'official.tar.xz');
        await download(pin, archive, options); options.onProgress?.({ phase: 'runtime-verify' });
        const folder = pin.kind === 'nodejs' ? `node-${pin.version}-linux-${pin.arch}` : `Python-${pin.version}`;
        const maximum = pin.kind === 'nodejs' ? 512 * 1024 ** 2 : 2 * 1024 ** 3;
        if (pin.kind === 'python') { if (typeof options.volume !== 'function') throw applicationIssue('APPLICATION_RUNTIME_BUILD'); volume = await options.volume(); if (!volume?.path || typeof volume.close !== 'function') throw applicationIssue('APPLICATION_RUNTIME_BUILD'); }
        const extracted = path.join(volume?.path || workspace, 'extracted'); await artifact(['extract', archive, extracted, folder, String(maximum)]);
        let source = path.join(extracted, folder);
        if (pin.kind === 'python') {
          if (typeof options.build !== 'function') throw applicationIssue('APPLICATION_RUNTIME_BUILD');
          options.onProgress?.({ phase: 'runtime-build' }); source = await options.build({ workspace: source, pin, signal: options.signal, onOutput: options.onOutput, onProgress: options.onProgress });
          if (source !== path.join(extracted, folder, 'output/runtime/python')) throw applicationIssue('APPLICATION_PATH');
        }
        options.onProgress?.({ phase: 'runtime-verify' }); ensureOpen();
        const staging = path.join(root, '.ready-' + randomUUID()); await io.mkdir(staging, { mode: 0o755 });
        try {
          await options.beforePromote?.();
          await artifact(['promote', source, path.join(staging, 'prefix'), volume?.path || workspace, String(maximum)]); await verifyTree(path.join(staging, 'prefix'));
          if (typeof options.validate !== 'function') throw applicationIssue('APPLICATION_RUNTIME_BUILD');
          await options.validate(descriptor(pin, path.join(staging, 'prefix')));
          await io.writeFile(path.join(staging, '.runtime.json'), JSON.stringify({ schema: 1, pin, validated: true, installedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o644 });
          if (await exists(path.join(root, key))) throw applicationIssue('APPLICATION_RUNTIME_PIN');
          await io.rename(staging, path.join(root, key));
        } finally { await io.rm(staging, { recursive: true, force: true }).catch(() => {}); }
        const selected = await installed(pin); if (!selected) throw applicationIssue('APPLICATION_RUNTIME_BUILD');
        return { sha256: pin.sha256, selected };
      } catch (error) { if (error.cleanupPending) unsafeCleanup = true; throw error; }
      finally {
        // Never reclaim admission credits while an owned builder or its hard
        // volume has not been verified as drained/unmounted. The private ledger
        // survives a panel restart and blocks further allocations until review.
        let cleaned = false;
        try { if (unsafeCleanup) { volume?.quarantine?.(); } else { await volume?.close(); if (workspace) await io.rm(workspace, { recursive: true, force: true }); cleaned = true; } }
        finally { if (cleaned) await release(); }
      }
    })();
    locks.set(key, operation); try { return (await operation).selected; } finally { locks.delete(key); }
  }
  return { installed, ensure, prerequisites, async close() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...locks.values()]); } };
}
