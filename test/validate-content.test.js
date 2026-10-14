import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync, ftruncateSync, mkdirSync, openSync, renameSync, rmSync, symlinkSync, truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { LIMITS, validateThemePack } from 'familiar-theme';
import { validateThemePackWithLoader } from '../src/validate.js';
import { DESCRIPTOR, writePack } from './helpers/fixture.js';

const pack = (t) => {
  const dir = writePack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n';

test('a working checkout validates: clutter outside the pack is never examined', async (t) => {
  const dir = pack(t);
  symlinkSync('../elsewhere/.worktrees', join(dir, '.worktrees'));
  mkdirSync(join(dir, '.superpowers'));
  symlinkSync('/etc/passwd', join(dir, '.superpowers', 'link'));
  writeFileSync(join(dir, 'README.md'), POINTER);
  mkdirSync(join(dir, 'docs'));
  symlinkSync('../theme.yaml', join(dir, 'docs', 'alias.yaml'));
  writeFileSync(join(dir, 'sprites', 'README.md'), POINTER);
  execFileSync('mkfifo', [join(dir, 'pipe')]);
  const server = createServer();
  await new Promise((ok) => server.listen(join(dir, 'sock'), ok));
  t.after(() => server.close());
  const p = await validateThemePack(dir);
  assert.equal(p.id, 'gate-fixture');
});

test('the entry and byte bounds count pack content only', async (t) => {
  const dir = pack(t);
  for (let i = 0; i < LIMITS.MAX_ENTRY_COUNT + 1; i++) mkdirSync(join(dir, 'node_modules', `m${i}`), { recursive: true });
  const fd = openSync(join(dir, 'big.bin'), 'w');
  ftruncateSync(fd, LIMITS.MAX_TOTAL_BYTES + 1);
  closeSync(fd);
  await validateThemePack(dir);
});

test('an ancestor of an asset-root must be a real directory', async (t) => {
  const dir = pack(t);
  renameSync(join(dir, 'sprites'), join(dir, 'real-sprites'));
  symlinkSync('real-sprites', join(dir, 'sprites'));
  await assert.rejects(() => validateThemePack(dir), /^Error: sprites: is a symlink/);
});

test('a symlink inside a member tree still fails by path', async (t) => {
  const dir = pack(t);
  symlinkSync('/etc/passwd', join(dir, 'sprites', 'solo', 'evil.txt'));
  await assert.rejects(() => validateThemePack(dir), /sprites\/solo\/evil\.txt: is a symlink/);
});

test('licence directories are walked at every depth', async (t) => {
  const nested = pack(t);
  mkdirSync(join(nested, 'LICENSES', 'assets'), { recursive: true });
  writeFileSync(join(nested, 'LICENSES', 'MIT.txt'), 'MIT');
  writeFileSync(join(nested, 'LICENSES', 'assets', 'CC-BY-4.0.txt'), POINTER);
  await assert.rejects(() => validateThemePack(nested),
    /LICENSES\/assets\/CC-BY-4\.0\.txt is a Git LFS pointer/);

  const linked = pack(t);
  mkdirSync(join(linked, 'LICENSES'));
  symlinkSync('/etc/passwd', join(linked, 'LICENSES', 'MIT.txt'));
  await assert.rejects(() => validateThemePack(linked), /LICENSES\/MIT\.txt: is a symlink/);

  const piped = pack(t);
  mkdirSync(join(piped, 'LICENSES'));
  execFileSync('mkfifo', [join(piped, 'LICENSES', 'pipe')]);
  await assert.rejects(() => validateThemePack(piped), /LICENSES\/pipe: is a FIFO/);
});

test('a root licence symlink fails by path', async (t) => {
  const dir = pack(t);
  symlinkSync('/etc/passwd', join(dir, 'LICENSE'));
  await assert.rejects(() => validateThemePack(dir), /LICENSE: is a symlink/);
});

test('a descriptor that grows after its lstat is never read past the bound', async (t) => {
  const dir = pack(t);
  // The descriptor passes the lstat check, then grows past 2 GiB (sparse) before
  // it is opened. A whole-file read would load it or fail with Node's
  // ERR_FS_FILE_TOO_LARGE; the bounded read stops one byte past the limit and
  // names the bound.
  await assert.rejects(() => validateThemePackWithLoader(dir, {
    afterDescriptorStat(path) { truncateSync(path, 3 * 1024 ** 3); },
  }), new RegExp(`theme\\.yaml: is more than ${LIMITS.MAX_DESCRIPTOR_BYTES} bytes .*MAX_DESCRIPTOR_BYTES`));
});

test('the descriptor is read once: a rewrite through an outside alias is never seen', async (t) => {
  const dir = pack(t);
  symlinkSync('.', join(dir, 'alias'));
  let reads = 0;
  const p = await validateThemePackWithLoader(dir, {
    afterDescriptorRead() {
      reads += 1;
      writeFileSync(join(dir, 'theme.yaml'),
        DESCRIPTOR.replace('asset-root: sprites/solo', 'asset-root: alias/sprites/solo'));
    },
  });
  assert.equal(reads, 1);
  assert.equal(p.members.get('solo').assetRoot, 'sprites/solo');
});
