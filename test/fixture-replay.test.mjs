import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('npm installs the selected fixture and rolls it back without undoing the workspace bump', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'claude-ship-fixture-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const path of ['package.json', 'package-lock.json', 'packages', 'fixtures/npm']) {
    cpSync(new URL(`../${path}`, import.meta.url), join(cwd, path), { recursive: true });
  }
  const workspace = ['--workspace', '@exhibit/format-label'];
  const offline = ['--offline', '--ignore-scripts', '--no-audit', '--no-fund'];
  const npm = (...args) => execFileSync('npm', args, { cwd, encoding: 'utf8', timeout: 15_000 });

  npm('pkg', 'set', 'version=1.0.1', ...workspace);
  for (const version of ['1.0.1', '1.0.2', '1.0.1']) {
    const tarball = `file:../../fixtures/npm/exhibit-normalize-label-${version}.tgz`;
    npm('pkg', 'set', `dependencies.@exhibit/normalize-label=${tarball}`, ...workspace);
    npm('install', '--package-lock-only', ...offline);
    npm('ci', ...offline);
    npm('ls', `@exhibit/normalize-label@${version}`, ...workspace);
    const manifest = JSON.parse(readFileSync(join(cwd, 'packages/format-label/package.json'), 'utf8'));
    assert.equal(manifest.version, '1.0.1');
  }
});
