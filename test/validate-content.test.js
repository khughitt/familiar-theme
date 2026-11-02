import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync, ftruncateSync, mkdirSync, openSync, renameSync, rmSync, symlinkSync, truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { LIMITS, encodeRgba, validateThemePack } from 'familiar-theme';
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
  symlinkSync('/etc/passwd', join(dir, 'sprites', 'pip', 'evil.txt'));
  await assert.rejects(() => validateThemePack(dir), /sprites\/pip\/evil\.txt: is a symlink/);
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
        DESCRIPTOR.replace('asset-root: sprites/pip', 'asset-root: alias/sprites/pip'));
    },
  });
  assert.equal(reads, 1);
  assert.equal(p.members.get('pip').assetRoot, 'sprites/pip');
});

// A two-locale world (4x3) so the gate has an image to miss and an image to mis-size.
const WORLD_2 = `world:
  asset-root: world
  size: [4, 3]
  locales:
    home: { image: home.png, places: [[0, 0]] }
    scoped: { image: scoped.png, places: [[1, 1]] }
`;
const solid = (w, h) => encodeRgba({ w, h, buf: new Uint8Array(w * h * 4).fill(255) });
const worldPack = (t, { scoped = solid(4, 3), home = solid(4, 3) } = {}) => {
  const dir = writePack({ descriptor: DESCRIPTOR + WORLD_2 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'world'));
  writeFileSync(join(dir, 'world', 'home.png'), home);
  if (scoped) writeFileSync(join(dir, 'world', 'scoped.png'), scoped);
  return dir;
};

test('a world pack with every locale image validates and keeps its locales', async (t) => {
  const p = await validateThemePack(worldPack(t));
  assert.equal(p.world.locales.size, 2);
});

test('a world pack validates through a symlinked path to the theme directory', async (t) => {
  const dir = worldPack(t);
  const link = `${dir}-link`;
  symlinkSync(dir, link);
  t.after(() => rmSync(link, { force: true }));
  const p = await validateThemePack(link);
  assert.equal(p.world.locales.size, 2);
});

test('a locale image the pack does not hold is refused as missing', async (t) => {
  await assert.rejects(
    () => validateThemePack(worldPack(t, { scoped: null })),
    /world: locale "scoped" is missing its image world\/scoped\.png/,
  );
});

test('a locale image whose size differs from the world size is refused', async (t) => {
  await assert.rejects(
    () => validateThemePack(worldPack(t, { home: solid(10, 10) })),
    /world: locale "home" is 10x10 — the world size is 4x3/,
  );
});

test('a world directory that fails its proof throws the loader fault', async (t) => {
  const dir = worldPack(t);
  rmSync(join(dir, 'world'), { recursive: true });
  await assert.rejects(
    () => validateThemePack(dir),
    (e) => e.message === 'theme "gate-fixture": world: asset-root "world" does not exist (world)',
  );
});

test('a world pack counts its files in the entry bound', async (t) => {
  const dir = worldPack(t);
  for (let i = 0; i < LIMITS.MAX_ENTRY_COUNT; i++) writeFileSync(join(dir, 'world', `x${i}.txt`), '');
  await assert.rejects(() => validateThemePack(dir), /MAX_ENTRY_COUNT/);
});

test('a pack with 65 members is refused at parse, before any walk', async (t) => {
  const members = Array.from({ length: 65 }, (_, i) => DESCRIPTOR.split('members:\n')[1]
    .replace('id: pip', `id: m${i}`).replace('sprites/pip', `sprites/m${i}`).replace('roles: [default]', 'roles: []'));
  const dir = pack(t);
  writeFileSync(join(dir, 'theme.yaml'), `${DESCRIPTOR.split('members:\n')[0]}members:\n${members.join('')}`);
  await assert.rejects(() => validateThemePack(dir), /65 members — the bound is 64 \(MAX_MEMBERS\)/);
});
