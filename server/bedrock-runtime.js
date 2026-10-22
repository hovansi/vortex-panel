import fs from 'node:fs/promises';
import { bedrockPortWaitErrorPayload } from './bedrock-port-wait.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bedrockRuntimeSupport, BEDROCK_PLATFORM_MESSAGE } from '../public/runtime-platform.js';

const POLICY = Object.freeze({
  version: '0.4.4',
  commit: '2f130fab1d6e1a4ee8a71dc60cfdfcc839ad192a',
  sourceSha256: 'ce844041092de3f44316bd1c033a3cc10024e5f798c1a8e8a58f046c6d967981',
  profile: 'generic-arm64-v1',
  executable: 'bin/box64',
  libraries: ['lib/x86_64/libstdc++.so.6', 'lib/x86_64/libgcc_s.so.1'],
});
const HASH = /^[a-f0-9]{64}$/;
const ROOTS = Object.freeze({ panel: '/opt/vortex-panel/runtime/box64-v0.4.4-arm64', worker: '/opt/vortex-node/runtime/box64-v0.4.4-arm64' });
const MESSAGES = Object.freeze({
  BEDROCK_RUNTIME_MISSING: { id: 'panel.runtime.bedrock-install', en: 'Run the full Vortex installer on this ARM64 node to prepare the Bedrock runtime. A source-only update does not install it.', vi: 'Chạy bộ cài đầy đủ Vortex trên VPS ARM64 này để cài môi trường Bedrock. Chỉ cập nhật mã nguồn sẽ không cài môi trường này.' },
  BEDROCK_RUNTIME_INVALID: { id: 'panel.runtime.bedrock-integrity', en: 'The existing managed Bedrock runtime could not be verified. An administrator must review it and prepare a verified replacement.', vi: 'Không xác minh được môi trường Bedrock hiện có. Quản trị viên cần kiểm tra và chuẩn bị bản thay thế đã được xác minh.' },
  BEDROCK_RUNTIME_PAGE_SIZE: { id: 'panel.runtime.bedrock-page-size', en: 'Bedrock on ARM64 currently requires a Linux kernel with 4 KiB pages.', vi: 'Bedrock trên ARM64 hiện cần nhân Linux dùng trang bộ nhớ 4 KiB.' },
});
export const BEDROCK_RUNTIME_MESSAGES = Object.freeze(Object.values(MESSAGES));
export function bedrockRuntimeErrorPayload(error, language = 'en') {
  const message = Object.hasOwn(MESSAGES, error?.code) ? MESSAGES[error.code] : error?.code === 'BEDROCK_RUNTIME_UNSUPPORTED' ? BEDROCK_PLATFORM_MESSAGE : null;
  return message ? { error: language === 'vi' ? message.vi : message.en, code: error.code, errorI18n: { ...message, params: [] } } : bedrockPortWaitErrorPayload(error, language);
}
const invalid = () => Object.assign(new Error('Managed Bedrock runtime verification failed.'), { code: 'BEDROCK_RUNTIME_INVALID', status: 409 });
const fingerprint = stat => ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');

async function kernelPageSize(io) {
  const handle = await io.open('/proc/self/auxv', 'r');
  try {
    const buffer = Buffer.alloc(4096), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (let offset = 0; offset + 16 <= bytesRead; offset += 16) {
      const type = buffer.readBigUInt64LE(offset), value = buffer.readBigUInt64LE(offset + 8);
      if (type === 0n) break;
      if (type === 6n && value > 0n && value <= 65536n) return Number(value);
    }
    throw invalid();
  } finally { await handle.close(); }
}

async function trustedStat(io, target, { directory = false, maxBytes = 128 * 1024 ** 2, executable = false } = {}) {
  const components = target.split('/').filter(Boolean);
  let current = '/';
  for (let index = -1; index < components.length; index++) {
    if (index >= 0) current = path.posix.join(current, components[index]);
    const stat = await io.lstat(current, { bigint: true });
    const last = index === components.length - 1;
    if (stat.isSymbolicLink() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n || (!(last && !directory) && !stat.isDirectory())) throw invalid();
    if (last) {
      if (!directory && (!stat.isFile() || stat.nlink !== 1n || stat.size <= 0n || stat.size > BigInt(maxBytes) || (executable && (stat.mode & 0o111n) === 0n))) throw invalid();
      return stat;
    }
  }
  throw invalid();
}

async function verifiedFile(io, target, expected, stat, machine) {
  const handle = await io.open(target, 'r');
  try {
    if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(stat)) throw invalid();
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let offset = 0, header;
    while (offset < Number(stat.size)) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(stat.size) - offset), offset);
      if (!bytesRead) throw invalid();
      if (!header) header = Buffer.from(buffer.subarray(0, Math.min(bytesRead, 20)));
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(stat) || hash.digest('hex') !== expected || !header || header.length < 20 || header.toString('hex', 0, 4) !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== machine) throw invalid();
  } finally { await handle.close(); }
}

// These constructor dependencies belong to the service, never to API input.
export function createBedrockRuntime({ role = 'panel', platform = process.platform, arch = process.arch, io = fs, pageSizeReader = () => kernelPageSize(io) } = {}) {
  if (!Object.hasOwn(ROOTS, role)) throw new Error('Invalid Bedrock runtime service role.');
  const base = bedrockRuntimeSupport({ platform, arch }), root = ROOTS[role];
  let verified = null, flight = null;
  const unsupported = code => ({ ...base, supported: false, code, reason: MESSAGES[code].vi, reasonI18n: MESSAGES[code] });
  async function inspect() {
    if (base.supported || platform !== 'linux' || base.arch !== 'arm64') return base;
    try {
      if (await pageSizeReader() !== 4096) return unsupported('BEDROCK_RUNTIME_PAGE_SIZE');
      try {
        await trustedStat(io, root, { directory: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        verified = null;
        return unsupported('BEDROCK_RUNTIME_MISSING');
      }
      const receiptPath = root + '/.vortex-bedrock-runtime.json';
      const receiptStat = await trustedStat(io, receiptPath, { maxBytes: 16384 });
      const receiptHandle = await io.open(receiptPath, 'r');
      let receipt;
      try {
        if (fingerprint(await receiptHandle.stat({ bigint: true })) !== fingerprint(receiptStat)) throw invalid();
        const buffer = Buffer.alloc(Number(receiptStat.size)), { bytesRead } = await receiptHandle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== buffer.length || fingerprint(await receiptHandle.stat({ bigint: true })) !== fingerprint(receiptStat)) throw invalid();
        receipt = JSON.parse(buffer.toString('utf8'));
      } finally { await receiptHandle.close(); }
      if (!receipt || receipt.schema !== 1 || receipt.engine !== 'box64' || receipt.version !== POLICY.version || receipt.hostArch !== 'arm64' || receipt.guestArch !== 'x64' || receipt.pageSize !== 4096 || receipt.profile !== POLICY.profile || receipt.source?.commit !== POLICY.commit || receipt.source?.sha256 !== POLICY.sourceSha256 || receipt.executable?.path !== POLICY.executable || !HASH.test(receipt.executable?.sha256 || '') || !Array.isArray(receipt.libraries) || receipt.libraries.length !== POLICY.libraries.length) throw invalid();
      const files = [{ ...receipt.executable, machine: 183 }, ...POLICY.libraries.map(name => {
        const matches = receipt.libraries.filter(value => value?.path === name);
        if (matches.length !== 1 || !HASH.test(matches[0].sha256 || '')) throw invalid();
        return { ...matches[0], machine: 62 };
      })];
      const stats = await Promise.all(files.map(file => trustedStat(io, root + '/' + file.path, { executable: file.path === POLICY.executable })));
      const signature = [fingerprint(receiptStat), ...stats.map(fingerprint)].join('|');
      if (verified !== signature) {
        await Promise.all(files.map((file, index) => verifiedFile(io, root + '/' + file.path, file.sha256, stats[index], file.machine)));
        verified = signature;
      }
      return { ...base, supported: true, mode: 'box64', engine: 'box64', engineVersion: POLICY.version, profile: POLICY.profile, reason: null, reasonI18n: null };
    } catch {
      verified = null;
      return unsupported('BEDROCK_RUNTIME_INVALID');
    }
  }
  function capabilities() {
    flight ||= inspect().finally(() => { flight = null; });
    return flight;
  }
  async function assertReady() {
    const capability = await capabilities();
    if (!capability.supported) throw Object.assign(new Error(capability.reason), { status: 409, code: capability.code || 'BEDROCK_RUNTIME_UNSUPPORTED', errorI18n: capability.reasonI18n });
    return capability;
  }
  return {
    capabilities, assertReady,
    async launchPlan(executable, workingDirectory) {
      const capability = await assertReady();
      if (capability.mode === 'native') return null;
      if (!path.isAbsolute(executable) || !path.isAbsolute(workingDirectory) || executable.includes('\0') || workingDirectory.includes('\0')) throw invalid();
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:BOX64_|LD_)/.test(name) && !['BASH_ENV', 'ENV', 'GLIBC_TUNABLES'].includes(name)));
      Object.assign(env, { BOX64_NORCFILES: '1', BOX64_DYNACACHE: '0', BOX64_DYNAREC: '1', BOX64_DYNAREC_SAFEFLAGS: '2', BOX64_DYNAREC_STRONGMEM: '1', BOX64_AVX: '2', BOX64_LD_LIBRARY_PATH: root + '/lib/x86_64:' + workingDirectory });
      return { executable: root + '/' + POLICY.executable, args: [executable], options: { cwd: workingDirectory, env, stdio: ['pipe', 'pipe', 'pipe'], detached: false }, execution: { cleanEnvironment: true }, runtime: capability };
    },
  };
}
