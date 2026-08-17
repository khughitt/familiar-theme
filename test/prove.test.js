import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIP_ROLES,
  assetsFor,
  loadAnimationMember,
  loadAnimationRefSync,
  loadThemePackSync,
} from 'familiar-theme';
import { writeClipsPack, writePack } from './helpers/fixture.js';

const proven = (t) => {
  const dir = writePack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return loadThemePackSync(dir);
};

test('assetsFor rejects a symlinked state sprite', (t) => {
  const pack = proven(t);
  const memberDir = pack.members.get('solo').assetDir;
  const real = join(memberDir, 'idle.png');
  rmSync(real);
  symlinkSync(join(memberDir, 'working.png'), real);
  assert.throws(() => assetsFor(pack, 'solo', 'dark'), /idle\.png.*symlink|regular/);
});

test('.light.png: ENOENT falls back to the base asset; a symlinked light REJECTS', (t) => {
  const pack = proven(t);
  const memberDir = pack.members.get('solo').assetDir;
  const assets = assetsFor(pack, 'solo', 'light');
  assert.equal(assets.idle.terminal, join(memberDir, 'idle.png'));
  symlinkSync(join(memberDir, 'idle.png'), join(memberDir, 'idle.light.png'));
  assert.throws(() => assetsFor(pack, 'solo', 'light'), /idle\.light\.png.*symlink|regular/);
});

test('an lstat failure that is NOT ENOENT rejects instead of selecting the base', (t) => {
  const pack = proven(t);
  const boom = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  assert.throws(
    () => assetsFor(pack, 'solo', 'light', { lstat: boom, realpath: (p) => p }),
    /EACCES/,
  );
});

test('a sprite hard-swapped for a path outside the member dir rejects on containment', (t) => {
  const pack = proven(t);
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'idle.png'), Buffer.from([1]));
  const escaping = { realpath: () => join(outside, 'idle.png') };
  assert.throws(() => assetsFor(pack, 'solo', 'dark', escaping), /resolves outside|contain/);
});

const clipsProven = (t) => {
  const dir = writeClipsPack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, pack: loadThemePackSync(dir) };
};
const swapForSymlink = (path) => {
  renameSync(path, `${path}.real`);
  symlinkSync(`${path}.real`, path);
};

test('loadAnimationMember rejects a symlinked animation.yaml before reading it', async (t) => {
  const { dir, pack } = clipsProven(t);
  swapForSymlink(join(dir, 'sprites', 'solo', 'animation.yaml'));
  await assert.rejects(() => loadAnimationMember(pack, 'solo'), /animation\.yaml.*(symlink|regular)/);
});

test('loadAnimationMember rejects a symlinked frame before reading it', async (t) => {
  const { dir, pack } = clipsProven(t);
  swapForSymlink(join(dir, 'sprites', 'solo', 'animation', CLIP_ROLES[0], 'f01.png'));
  await assert.rejects(() => loadAnimationMember(pack, 'solo'), /f01\.png.*(symlink|regular)/);
});

test('loadAnimationRefSync rejects a manifest that became a symlink after the ref was built', async (t) => {
  const { dir, pack } = clipsProven(t);
  const { ref } = await loadAnimationMember(pack, 'solo');
  swapForSymlink(join(dir, 'sprites', 'solo', 'animation.yaml'));
  assert.throws(() => loadAnimationRefSync(ref), /(symlink|regular)/);
});
