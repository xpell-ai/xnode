import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { XNode, XWebServer, Settings, _x } from '../dist/index.js';

async function webFixture(t, settings = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'xnode-bind-'));
  const web = new XWebServer(); web.onSetup(folder);
  Settings.set('xweb', { ...Settings.get('xweb'), domain: 'public.example.invalid',
    'http-port': 0, 'enable-ssl': false, 'enable-wormhole': false, ...settings });
  web.load();
  t.after(async () => {
    await web.stop();
    Settings.close(); await rm(folder, { recursive: true, force: true });
  });
  return web;
}

test('explicit loopback reaches the real HTTP listener with ephemeral port zero', async t => {
  const web = await webFixture(t, { 'listen-host': '127.0.0.1' });
  await web.start();
  if (!web._web_server.listening) await once(web._web_server, 'listening');
  const address = web._web_server.address();
  assert.equal(address.address, '127.0.0.1'); assert.ok(address.port > 0);
  assert.equal(Settings.get('xweb').domain, 'public.example.invalid');
});

test('omitting listen-host preserves the unspecified default without binding a wildcard test socket', async t => {
  const web = await webFixture(t, { 'listen-host': undefined });
  const calls = [];
  t.mock.method(http.Server.prototype, 'listen', function (options) { calls.push(options); this.emit('listening'); return this; });
  await web.start();
  assert.deepEqual(calls, [{ port: 0, host: undefined }]);
});

test('empty or whitespace bind addresses fail before opening any listener', async t => {
  const web = await webFixture(t, { 'listen-host': ' ' });
  await assert.rejects(web.start(), /listen-host/);
  assert.equal(web._web_server, undefined);
});

test('an HTTPS setup failure closes the HTTP listener already opened by this web server', async t => {
  const web = await webFixture(t, { 'listen-host': '127.0.0.1', 'enable-ssl': true,
    'ssl-settings': { 'https-port': 0, 'ssl-pk-file': '', 'ssl-cert-file': '', 'ssl-chain-file': '' } });
  await assert.rejects(web.start(), e => e.code === 'ENOENT');
  assert.equal(web._web_server.listening, false);
  await web.stop(); await web.stop();
});

test('web shutdown never closes an injected HTTP listener it did not create', async t => {
  const unrelated = http.createServer();
  await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  const web = new XWebServer(); web._web_server = unrelated;
  await web.stop(); assert.equal(unrelated.listening, true);
});

test('XNode forwards _host as listener address without rewriting the public domain', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'xnode-bind-mapping-'));
  const node = new XNode();
  // Wiring unit test only: full real bootstrap is covered by the acceptance fixture.
  // Avoid starting the currently ownerless Core loop or loading unrelated services.
  t.mock.method(_x, 'start', () => {});
  t.mock.method(_x, 'loadModuleAsync', async () => {});
  t.after(async () => {
    const server = node._web_server._web_server;
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    Settings.close(); await rm(folder, { recursive: true, force: true });
  });
  await node.start({ _work_folder: folder, _port: 0, _host: '127.0.0.1',
    _web_settings: { domain: 'public.example.invalid', 'enable-wormhole': false, 'enable-ssl': false } });
  const server = node._web_server._web_server;
  if (!server.listening) await once(server, 'listening');
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal(Settings.get('xweb').domain, 'public.example.invalid');
  assert.equal(Settings.get('xweb')['listen-host'], '127.0.0.1');
});
