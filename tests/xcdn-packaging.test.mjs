import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { XCDNClient } from '../dist/XCDN/XCDNClient.js';

async function fixture(t) {
  const requests = [], directory = mkdtempSync(path.join(tmpdir(), 'xcdn-packaging-'));
  const file = path.join(directory, 'synthetic.txt'); writeFileSync(file, 'synthetic upload bytes');
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url === '/redirect/add/') { res.writeHead(302, { location: '/add/' }); res.end(); return; }
    res.writeHead(req.url === '/error/add/' ? 409 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stored: req.url !== '/error/add/' }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { requests, file, url, client: new XCDNClient(url) };
}
test('declared node-fetch preserves file multipart fields, bytes, MIME and expiry', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.uploadFileOnce(f.file, 'text/plain'), { stored: true });
  assert.deepEqual(await f.client.uploadFileWithExp(f.file, '3h'), { stored: true });
  for (const [i, request] of f.requests.entries()) {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/add/');
    assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/u);
    assert.match(request.body, /name="cdn-file"; filename="synthetic.txt"/u);
    assert.match(request.body, /synthetic upload bytes/u);
    assert.ok(request.body.includes(`name="exp"\r\n\r\n${i ? '3h' : '-1'}`));
  }
  assert.equal(f.requests[0].headers['mime-type'], 'text/plain');
});
test('declared node-fetch preserves base64 upload and PNG filename behavior', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.uploadBase64(Buffer.from('synthetic PNG').toString('base64'), 'image/png', '1d'), { stored: true });
  const r = f.requests[0]; assert.equal(r.headers['mime-type'], 'image/png');
  assert.match(r.body, /filename="[0-9a-f-]+\.png"/iu); assert.match(r.body, /synthetic PNG/u);
  assert.ok(r.body.includes('name="exp"\r\n\r\n1d'));
});
test('expiry rejection and URL helpers retain existing signatures and behavior', async t => {
  const f = await fixture(t);
  for (const expiry of ['0m', '1w', 'bad', '']) await assert.rejects(f.client.uploadFileWithExp(f.file, expiry), /Invalid exp format/u);
  assert.equal(f.requests.length, 0); assert.equal(f.client.getUrl('synthetic'), f.url + '/get/synthetic');
  assert.equal(f.client.getByUName('synthetic'), f.url + '/u/synthetic');
  f.client.CDNUrl = 'example.invalid/'; assert.equal(f.client.CDNUrl, 'http://example.invalid');
});
test('node-fetch redirect and non-2xx JSON response semantics remain unchanged', async t => {
  const f = await fixture(t);
  assert.deepEqual(await new XCDNClient(f.url + '/redirect').uploadFileOnce(f.file), { stored: true });
  assert.deepEqual(await new XCDNClient(f.url + '/error').uploadFileOnce(f.file), { stored: false });
  assert.equal(f.requests.at(-1).url, '/error/add/');
});
