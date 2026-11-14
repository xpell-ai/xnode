import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-only build preparation. Never read work stores, credentials, node_modules
// or compiled workspace artifacts. Installation/building happens explicitly later.
assert.equal(process.versions.node, '22.23.1', 'Use the verified Node 22.23.1 build runtime');
const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const packages = [
  'packages/xpell-core', 'packages/xnode-core', 'packages/file-service',
  'packages/xmcp', 'packages/xvibe', 'packages/xnode', 'packages/xagent',
  'packages/xagent-channels', 'packages/xnet',
];
const output = mkdtempSync(path.join(tmpdir(), 'xnode-expanded-build-'));
const hashes = {};
const omitted = [];
const copy = (relative, target = relative) => {
  const source = path.join(workspace, relative), destination = path.join(output, target);
  if (!existsSync(source)) return;
  const visit = (dir, prefix, dest) => {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'dist', 'dist-tests', '.git', 'work'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name), key = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink() && relative.endsWith('/docs')) { omitted.push(key); continue; }
      assert.ok(!entry.isSymbolicLink(), `Source inputs cannot escape through symlinks: ${key}`);
      if (entry.isDirectory()) visit(file, key, path.join(dest, entry.name));
      else { hashes[key] = createHash('sha256').update(readFileSync(file)).digest('hex'); copyFileSync(file, path.join(dest, entry.name)); }
    }
  };
  assert.ok(!lstatSync(source).isSymbolicLink(), `Unexpected linked input: ${relative}`);
  if (lstatSync(source).isDirectory()) visit(source, relative, destination);
  else { hashes[relative] = createHash('sha256').update(readFileSync(source)).digest('hex');
    mkdirSync(path.dirname(destination), { recursive: true }); copyFileSync(source, destination); }
};
for (const relative of packages) {
  for (const folder of ['src', 'types', 'public', 'system-xapps', 'tests', 'test', 'docs']) copy(`${relative}/${folder}`);
  for (const name of readdirSync(path.join(workspace, relative))) {
    if (name === 'package.json' || /^tsconfig.*\.json$/u.test(name) || /^vite\.config\.[cm]?[jt]s$/u.test(name) || /^(README|LICENSE|CHANGELOG)(\..*)?$/u.test(name)) copy(`${relative}/${name}`);
  }
  assert.ok(!existsSync(path.join(output, relative, 'dist')));
}
copy('pnpm-lock.yaml');
writeFileSync(path.join(output, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@10.25.0' }, null, 2) + '\n');
writeFileSync(path.join(output, 'pnpm-workspace.yaml'), 'packages:\n' + packages.map(p => `  - ${p}\n`).join('') + 'onlyBuiltDependencies: []\n');
const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(path.join(output, 'source-inputs.json'), JSON.stringify({ _format: 1, _node: process.versions.node,
  _build_order: packages, _omitted_doc_symlinks: omitted, _files: sorted, _sha256: createHash('sha256').update(JSON.stringify(sorted)).digest('hex') }, null, 2) + '\n');
console.log(output);
