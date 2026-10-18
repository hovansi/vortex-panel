import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function acquireDataLock(dataDir) {
  const filename = path.join(dataDir, 'panel.lock');
  const identity = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(filename, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity, createdAt: new Date().toISOString() })); }
      finally { fs.closeSync(fd); }
      return () => {
        try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).identity === identity) fs.unlinkSync(filename); } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const recoveryFile = `${filename}.recovery`;
      let guard;
      try { guard = fs.openSync(recoveryFile, 'wx', 0o600); }
      catch { throw new Error(`Một tiến trình đang kiểm tra khóa dữ liệu ${filename}. Thử lại sau.`); }
      try {
        let previous;
        try { previous = JSON.parse(fs.readFileSync(filename, 'utf8')); }
        catch (readError) {
          if (readError.code === 'ENOENT') continue;
          throw new Error(`Không thể đọc khóa dữ liệu: ${filename}. Kiểm tra tiến trình panel trước khi xóa khóa.`);
        }
        if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw new Error(`Khóa dữ liệu không hợp lệ: ${filename}`);
        try { process.kill(previous.pid, 0); }
        catch (probeError) {
          if (probeError.code === 'ESRCH') { fs.unlinkSync(filename); continue; }
          throw new Error(`Không xác định được tiến trình đang giữ khóa dữ liệu ${filename}.`);
        }
        throw new Error(`Một panel khác (PID ${previous.pid}) đang dùng ${dataDir}.`);
      } finally { fs.closeSync(guard); fs.unlinkSync(recoveryFile); }
    }
  }
  throw new Error('Không thể khóa thư mục dữ liệu.');
}
