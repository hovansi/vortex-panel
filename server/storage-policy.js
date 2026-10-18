export const GIB = 1024 ** 3;
export const DEFAULT_DISK_GIB = 5;
export const MAX_DISK_GIB = 65536;

const problem = message => Object.assign(new Error(message), { status: 400, code: 'STORAGE_POLICY' });

// Legacy unlimited directories remain readable; new native servers require a
// fixed volume. A GiB is binary and includes the filesystem's own metadata.
export function normalizeStoragePolicy(input, { legacy = false } = {}) {
  if (input === undefined || input === null) return legacy ? { mode: 'unlimited', diskGiB: null } : { mode: 'fixed', diskGiB: DEFAULT_DISK_GIB };
  if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['mode', 'diskGiB'].includes(key))) throw problem('Storage policy contains unsupported fields.');
  if (input.mode === 'unlimited' && legacy && input.diskGiB == null) return { mode: 'unlimited', diskGiB: null };
  if (input.mode !== 'fixed') throw problem('New servers require a fixed storage policy.');
  if (typeof input.diskGiB !== 'number' || !Number.isSafeInteger(input.diskGiB) || input.diskGiB < 1 || input.diskGiB > MAX_DISK_GIB) throw problem(`Disk capacity must be an integer from 1 to ${MAX_DISK_GIB} GiB.`);
  return { mode: 'fixed', diskGiB: input.diskGiB };
}

export function storageLimitBytes(policy, options) {
  const normalized = normalizeStoragePolicy(policy, options);
  return normalized.mode === 'fixed' ? normalized.diskGiB * GIB : null;
}
