import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.versions.node, '22.23.1');
assert.ok(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'No preloaders or ambient module paths');
const source = path.resolve(process.argv[2] ?? assert.fail('Pass the source-only build directory'));
const inputs = JSON.parse(readFileSync(path.join(source, 'source-inputs.json')));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
for (const [file, expected] of Object.entries(inputs._files)) assert.equal(hash(path.join(source, file)), expected, `Changed build input: ${file}`);
const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
assert.equal(pnpm.status, 0); assert.equal(pnpm.stdout.trim(), '10.25.0');
const runtime = await import(pathToFileURL(path.join(source, 'packages/xnode/dist/index.js')).href);
assert.deepEqual(runtime.ENTITY_LOCAL_UNIT_CAPABILITIES, { _version: 2, _profiles: {
  'standard-v1': { _records: 8, _writes: 4, _entities: 8, _bytes: 65536 },
  'expanded-v1': { _records: 10, _writes: 5, _entities: 8, _bytes: 65536 },
} });
const output = mkdtempSync(path.join(tmpdir(), 'xnode-expanded-candidate-'));
const artifacts = {};
for (const relative of inputs._build_order) {
  const directory = path.join(source, relative), manifest = JSON.parse(readFileSync(path.join(directory, 'package.json')));
  assert.ok(existsSync(path.join(directory, manifest.main)));
  const before = new Set(readdirSync(output));
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', output], { cwd: directory, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr + packed.stdout);
  const added = readdirSync(output).filter(file => !before.has(file)); assert.equal(added.length, 1);
  artifacts[manifest.name] = { _version: manifest.version, _file: added[0], _sha256: hash(path.join(output, added[0])),
    _source_manifest_sha256: hash(path.join(directory, 'package.json')) };
}
// Preserve exact source/lock inputs for rebuilding; never archive dependencies or dist.
const list = path.join(source, 'candidate-source-files.txt');
writeFileSync(list, [...Object.keys(inputs._files), 'package.json', 'pnpm-workspace.yaml', 'source-inputs.json'].join('\n') + '\n');
const archived = spawnSync('tar', ['-czf', path.join(output, 'source-inputs.tgz'), '-T', list], { cwd: source, encoding: 'utf8' });
assert.equal(archived.status, 0, archived.stderr);
writeFileSync(path.join(output, 'source-inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
const manifest = { _format: 1, _node: process.versions.node, _npm: '10.9.8', _pnpm: '10.25.0',
  _source_sha256: inputs._sha256, _lock_sha256: hash(path.join(source, 'pnpm-lock.yaml')),
  _source_archive_sha256: hash(path.join(output, 'source-inputs.tgz')),
  _exports: Object.keys(runtime).sort(), _packages: artifacts };
writeFileSync(path.join(output, 'candidate.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(path.join(output, 'SHA256SUMS'), readdirSync(output).sort().map(file => `${hash(path.join(output, file))}  ${file}\n`).join(''));
for (const file of readdirSync(output)) chmodSync(path.join(output, file), 0o444);
chmodSync(output, 0o555); // New, content-addressed files are not silently replaced.
console.log(output);
