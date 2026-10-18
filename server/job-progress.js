// Overall workflow milestones are distinct from transport-byte percentages.
// A running workflow cannot reach 100 before its actual operation commits.
export function updateJobProgress(record, value, message, details = {}) {
  const before = JSON.stringify([record.progress, record.message, record.phase, record.transfer]);
  if (typeof value === 'number' && Number.isFinite(value)) record.progress = Math.max(Number(record.progress) || 0, Math.min(99, Math.max(0, Math.round(value))));
  if (typeof message === 'string' && message) record.message = message;
  record.phase = typeof details.phase === 'string' && /^[a-z][a-z-]{0,31}$/.test(details.phase) ? details.phase : 'work';
  if (['download', 'runtime-download'].includes(record.phase) && details.transfer && typeof details.transfer === 'object') {
    const bytes = number => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null;
    const loadedBytes = bytes(details.transfer.loadedBytes), totalBytes = bytes(details.transfer.totalBytes);
    record.transfer = { loadedBytes: loadedBytes ?? 0, totalBytes, percent: totalBytes && loadedBytes !== null ? Math.min(100, loadedBytes / totalBytes * 100) : null };
  } else delete record.transfer;
  return before !== JSON.stringify([record.progress, record.message, record.phase, record.transfer]);
}
