import { canAccessServer } from './access.js';

const receives = new WeakMap();

// Call only after authentication/origin/CSRF checks. Only actual upload routes
// and their existing management permissions can renew beyond the RPC limit.
export function authorizeMultipartReceive(req) {
  const state = receives.get(req), user = req.session?.user;
  if (!state || req.method !== 'POST' || !/^multipart\/form-data(?:\s*;|$)/i.test(req.headers['content-type'] || '') || !user || user.disabled) return;
  const pathname = (req.originalUrl || req.url || '').split('?')[0];
  if (user.role === 'admin' && /^\/api\/(?:versions\/import|nodes\/[^/]+\/versions\/import)\/?$/.test(pathname)) { state.streaming = true; return; }
  const match = pathname.match(/^\/api\/servers\/([^/]+)\/(?:files\/upload|worlds\/import|packs\/import|appearance\/media\/(?:icon|cover))\/?$/);
  if (!match) return;
  let serverId; try { serverId = decodeURIComponent(match[1]); } catch { return; }
  if (canAccessServer(user, serverId, true)) state.streaming = true;
}

export function installHttpReceivePolicy(server, { headersTimeoutMs = 30000, idleTimeoutMs = 120000, requestTimeoutMs = 300000 } = {}) {
  for (const value of [headersTimeoutMs, idleTimeoutMs, requestTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new RangeError('Invalid HTTP receive timeout.');
  // Node's requestTimeout is a total receive deadline, including a progressing
  // multipart body. Header parsing retains its own native timeout; body limits
  // below are request-local and end before processing or response streaming.
  server.requestTimeout = 0;
  server.headersTimeout = headersTimeoutMs;
  server.prependListener('request', (req, res) => {
    const socket = req.socket, started = Date.now(), state = { streaming: false };
    receives.set(req, state);
    let bytes = socket.bytesRead, activityAt = started, timer, done = false;
    const cleanup = () => {
      if (done) return; done = true; clearTimeout(timer); receives.delete(req);
      req.off('end', cleanup); req.off('aborted', cleanup); socket.off('close', cleanup);
      res.off('finish', responseFinished);
    };
    // An admitted upload may still be rejected before the body is drained.
    // Its response cannot grant an unbounded progressing keepalive drain.
    const responseFinished = () => { if (!req.complete) state.streaming = false; };
    const expire = () => {
      cleanup();
      if (socket.destroyed) return;
      if (!res.headersSent) {
        res.once('finish', () => socket.destroy());
        res.writeHead(408, { Connection: 'close' }); res.end();
      } else socket.destroy();
    };
    const inspect = () => {
      if (done) return;
      if (req.complete || req.aborted || socket.destroyed) { cleanup(); return; }
      const time = Date.now();
      if (socket.bytesRead !== bytes) { bytes = socket.bytesRead; activityAt = time; }
      const deadline = Math.min(activityAt + idleTimeoutMs, state.streaming ? Infinity : started + requestTimeoutMs);
      if (time >= deadline) { expire(); return; }
      timer = setTimeout(inspect, Math.max(1, Math.min(1000, idleTimeoutMs / 4, requestTimeoutMs / 4, deadline - time))); timer.unref();
    };
    // Observing raw byte counters leaves the incoming stream paused until its
    // own parser/proxy consumes it, retaining backpressure and every body byte.
    req.once('end', cleanup); req.once('aborted', cleanup); socket.once('close', cleanup);
    res.once('finish', responseFinished);
    inspect();
  });
  return server;
}
