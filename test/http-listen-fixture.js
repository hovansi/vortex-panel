// Test-only HTTP listeners must also satisfy Fetch port blocking. This list
// matches WHATWG Fetch's bad ports and the supported Node22 bundled Undici.
// Selection happens before any HTTP request; it never retries an API operation.
const blocked = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

async function bind(server, port) {
  if (server.listening) throw new Error('Fetch fixture server is already listening.');
  await new Promise((resolve, reject) => {
    const failed = error => { server.off('error', failed); reject(error); };
    server.once('error', failed);
    try { server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolve(); }); }
    catch (error) { server.off('error', failed); reject(error); }
  });
}

async function closeBound(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function listenFetchSafeHttp(server, port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Fetch fixture port.');
  for (let attempt = 0; attempt < 8; attempt++) {
    await bind(server, attempt === 0 ? port : 0);
    const address = server.address();
    if (!address || typeof address === 'string' || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) {
      await closeBound(server);
      throw new Error('Fetch fixture did not report its bound HTTP port.');
    }
    if (!blocked.has(address.port)) return address.port;
    // Only this invocation's successful bind is closed, before any HTTP client
    // can receive its URL. Bind/close errors fail immediately without retry.
    await closeBound(server);
  }
  throw new Error('Fetch fixture exhausted eight blocked HTTP port candidates.');
}
