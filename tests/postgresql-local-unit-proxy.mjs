// Test-only PostgreSQL wire proxy: actual server COMMIT, deliberately lost reply.
// No SQL/credential payload is logged or persisted. Loopback synthetic cluster only.
import net from 'node:net';

export async function commitFaultProxy(t, mode) {
  const port = Number(process.env.XPELL_PG_TEST_PORT), sockets = new Set();
  if (!Number.isInteger(port) || port <= 1024 || [3001, 3100].includes(port)) throw new Error('Explicit synthetic PG port required');
  let armed = false, commits = 0, acknowledge;
  const fault = new Promise(resolve => { acknowledge = resolve; });
  const server = net.createServer(downstream => {
    const upstream = net.connect({ host: '127.0.0.1', port });
    sockets.add(downstream); sockets.add(upstream);
    let front = Buffer.alloc(0), back = Buffer.alloc(0), startup = true, drop = false, committed = false;
    const close = () => { downstream.destroy(); upstream.destroy(); };
    for (const socket of [downstream, upstream]) {
      socket.on('error', close); socket.on('close', () => { sockets.delete(socket); close(); });
    }
    downstream.on('data', chunk => {
      front = Buffer.concat([front, chunk]);
      while (front.length >= (startup ? 4 : 5)) {
        const size = startup ? front.readInt32BE(0) : front.readInt32BE(1) + 1;
        if (size < 4 || size > 1048576) { close(); return; }
        if (front.length < size) return;
        const frame = front.subarray(0, size); front = front.subarray(size);
        if (startup) { startup = false; upstream.write(frame); continue; }
        const commit = frame[0] === 81 && /^COMMIT;?\0$/i.test(frame.subarray(5).toString('utf8'));
        if (armed && commit) {
          armed = false; commits++;
          if (mode === 'before-server') { close(); acknowledge({ committed: false }); return; }
          drop = true;
        }
        upstream.write(frame);
      }
    });
    upstream.on('data', chunk => {
      back = Buffer.concat([back, chunk]);
      while (back.length >= 5) {
        const size = back.readInt32BE(1) + 1;
        if (size < 5 || size > 1048576) { close(); return; }
        if (back.length < size) return;
        const frame = back.subarray(0, size); back = back.subarray(size);
        if (!drop) { downstream.write(frame); continue; }
        if (frame[0] === 67 && frame.subarray(5).toString('utf8') === 'COMMIT\0') committed = true;
        if (frame[0] === 69) { downstream.write(frame); drop = false; acknowledge({ serverError: true }); }
        if (frame[0] === 90 && committed) { close(); acknowledge({ committed: true }); return; }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { port: server.address().port, arm: () => { armed = true; }, fault, commits: () => commits };
}
