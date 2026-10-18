import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Renaming the default data directory must not change existing firewall owners.
// Only the installer's private, machine-bound legacy-default migration qualifies.
export function panelFirewallScope(dataDir) {
  const directory = path.resolve(dataDir);
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return directory;
  const filename = path.join(directory, '.vortex-layout.json');
  let info;
  try { info = fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return directory; throw error; }
  const reject = () => { throw new Error('The Vortex layout migration receipt needs administrator review.'); };
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096 || directory !== '/var/lib/vortex-panel' || info.uid !== 0 || info.mode & 0o077 || fs.realpathSync(directory) !== directory) reject();
  const bytes = fs.readFileSync(filename), value = JSON.parse(bytes.toString('utf8'));
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{32}$/i.test(value.migrationId || '') || value.previousDataDir !== '/var/lib/bedrock-panel' || value.dataDir !== directory || value.firewallScope !== '/var/lib/bedrock-panel' || value.machineId !== fs.readFileSync('/etc/machine-id', 'utf8').trim()) reject();
  const parent = '/var/backups/vortex-panel';
  const trusted = (name, directory = false) => { const stat = fs.lstatSync(name); if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o077 || directory && !stat.isDirectory() || !directory && (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 ** 2)) reject(); };
  trusted(parent, true);
  const entries = fs.readdirSync(parent); if (entries.length > 4096) reject();
  let verified = false;
  for (const name of entries.filter(name => /^migration-[A-Za-z0-9_-]{10,100}$/.test(name))) {
    const folder = path.join(parent, name); trusted(folder, true);
    const recordFile = path.join(folder, 'transaction.json'); trusted(recordFile);
    const recordBytes = fs.readFileSync(recordFile), record = JSON.parse(recordBytes.toString('utf8'));
    if (record.id !== value.migrationId) continue;
    if (record.schemaVersion !== 1 || record.machineId !== value.machineId || !['applied', 'committed'].includes(record.state) || !record.moveData || !record.moves?.some(row => row.old === value.previousDataDir && row.new === directory) || !(record.createdFiles?.some(row => row.path === filename && row.sha256 === createHash('sha256').update(bytes).digest('hex')) || record.state === 'committed' && value.transactionPath === recordFile && value.transactionSHA256 === createHash('sha256').update(recordBytes).digest('hex'))) reject();
    verified = true; break;
  }
  if (!verified) reject();
  return value.firewallScope;
}
