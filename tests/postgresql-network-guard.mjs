// Test preload only: no external AI/payment endpoints or protected local application ports.
import net from 'node:net';
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : typeof first === 'string' ? { path: first } : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (options.path) {
    if (!String(options.path).endsWith('/.s.PGSQL.' + process.env.XPELL_PG_TEST_PORT)) throw new Error('E_TEST_NETWORK_ISOLATION');
  } else {
    const host = options.host ?? 'localhost', port = Number(options.port);
    if (!['127.0.0.1', '::1', 'localhost'].includes(host) || [3001, 3100].includes(port) || !Number.isInteger(port) || port <= 1024) throw new Error('E_TEST_NETWORK_ISOLATION');
  }
  return original.apply(this, args);
};
