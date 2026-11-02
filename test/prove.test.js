import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIP_ROLES,
  assetsFor,
  loadAnimationMember,
  loadAnimationRefSync,
  loadThemePack,
  loadThemePackSync,
  localeAssetFor,
  parseThemePack,
} from 'familiar-theme';
import {
  DESCRIPTOR, WORLD_BLOCK, writeClipsPack, writePack, writeWorldPack,
} from './helpers/fixture.js';

const proven = (t) => {
  const dir = writePack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return loadThemePackSync(dir);
};

test('assetsFor rejects a symlinked state sprite', (t) => {
  const pack = proven(t);
  const memberDir = pack.members.get('pip').assetDir;
  const real = join(memberDir, 'idle.png');
  rmSync(real);
  symlinkSync(join(memberDir, 'working.png'), real);
  assert.throws(() => assetsFor(pack, 'pip', 'dark'), /idle\.png.*symlink|regular/);
});

test('.light.png: ENOENT falls back to the base asset; a symlinked light REJECTS', (t) => {
  const pack = proven(t);
  const memberDir = pack.members.get('pip').assetDir;
  const assets = assetsFor(pack, 'pip', 'light');
  assert.equal(assets.idle.terminal, join(memberDir, 'idle.png'));
  symlinkSync(join(memberDir, 'idle.png'), join(memberDir, 'idle.light.png'));
  assert.throws(() => assetsFor(pack, 'pip', 'light'), /idle\.light\.png.*symlink|regular/);
});

test('an lstat failure that is NOT ENOENT rejects instead of selecting the base', (t) => {
  const pack = proven(t);
  const boom = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  assert.throws(
    () => assetsFor(pack, 'pip', 'light', { lstat: boom, realpath: (p) => p }),
    /EACCES/,
  );
});

test('a sprite hard-swapped for a path outside the member dir rejects on containment', (t) => {
  const pack = proven(t);
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'idle.png'), Buffer.from([1]));
  const escaping = { realpath: () => join(outside, 'idle.png') };
  assert.throws(() => assetsFor(pack, 'pip', 'dark', escaping), /resolves outside|contain/);
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
  swapForSymlink(join(dir, 'sprites', 'pip', 'animation.yaml'));
  await assert.rejects(() => loadAnimationMember(pack, 'pip'), /animation\.yaml.*(symlink|regular)/);
});

test('loadAnimationMember rejects a symlinked frame before reading it', async (t) => {
  const { dir, pack } = clipsProven(t);
  swapForSymlink(join(dir, 'sprites', 'pip', 'animation', CLIP_ROLES[0], 'f01.png'));
  await assert.rejects(() => loadAnimationMember(pack, 'pip'), /f01\.png.*(symlink|regular)/);
});

test('loadAnimationRefSync rejects a manifest that became a symlink after the ref was built', async (t) => {
  const { dir, pack } = clipsProven(t);
  const { ref } = await loadAnimationMember(pack, 'pip');
  swapForSymlink(join(dir, 'sprites', 'pip', 'animation.yaml'));
  assert.throws(() => loadAnimationRefSync(ref), /(symlink|regular)/);
});

// The world is proven at load as a member is (spec §5.1), by both loaders alike.
const worldPack = (t) => {
  const dir = writeWorldPack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const LOADERS = [
  ['loadThemePack', (dir) => loadThemePack(dir)],
  ['loadThemePackSync', async (dir) => loadThemePackSync(dir)],
];

test('both loaders prove a pack with a world', async (t) => {
  const dir = worldPack(t);
  const realWorld = realpathSync(join(dir, 'world'));
  for (const [name, load] of LOADERS) {
    const { world, members } = await load(dir);
    assert.equal(world.assetDirProof, 'filesystem', name);
    assert.equal(world.assetDir, realWorld, name);
    assert.equal(world.assetRootFault, undefined, name);
    assert.equal(world.locales.get('home').imagePath, join(realWorld, 'home.png'), name);
    assert.deepEqual(world.size, { width: 1, height: 1 }, name);
    assert.equal(members.get('pip').assetDirProof, 'filesystem', name);
  }
});

test('a world directory symlinked inside the theme is proven at its real path', async (t) => {
  const dir = worldPack(t);
  mkdirSync(join(dir, 'art'));
  renameSync(join(dir, 'world'), join(dir, 'art', 'world'));
  symlinkSync(join('art', 'world'), join(dir, 'world'));
  const realWorld = realpathSync(join(dir, 'art', 'world'));
  for (const [name, load] of LOADERS) {
    const { world } = await load(dir);
    assert.equal(world.assetDir, realWorld, name);
    assert.equal(world.locales.get('home').imagePath, join(realWorld, 'home.png'), name);
  }
});

const assertWorldFault = (world, re, name) => {
  assert.match(world.assetRootFault?.message ?? '', re, name);
  assert.equal(world.assetDir, undefined, name);
  assert.equal(world.assetDirProof, undefined, name);
};

test('loadThemePack records a world fault for a missing world directory', async (t) => {
  const dir = worldPack(t);
  rmSync(join(dir, 'world'), { recursive: true });
  for (const [name, load] of LOADERS) {
    const pack = await load(dir);
    assertWorldFault(pack.world, /^theme "gate-fixture": world: asset-root "world" does not exist/, name);
    assert.equal(pack.members.get('pip').assetDirProof, 'filesystem', name);
  }
});

test('loadThemePack records a world fault for a world directory symlinked outside the theme', async (t) => {
  const dir = worldPack(t);
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  renameSync(join(dir, 'world'), join(outside, 'world'));
  symlinkSync(join(outside, 'world'), join(dir, 'world'));
  for (const [name, load] of LOADERS) {
    const pack = await load(dir);
    assertWorldFault(
      pack.world,
      /^theme "gate-fixture": world: asset-root "world" resolves outside the real theme directory/,
      name,
    );
  }
});

test('loadThemePack records a world fault for a world root that is not a directory', async (t) => {
  const dir = worldPack(t);
  rmSync(join(dir, 'world'), { recursive: true });
  writeFileSync(join(dir, 'world'), 'not a directory');
  for (const [name, load] of LOADERS) {
    assertWorldFault((await load(dir)).world, /world: asset-root "world" is not a directory/, name);
  }
});

test('localeAssetFor returns the proven image', (t) => {
  const pack = loadThemePackSync(worldPack(t));
  assert.deepEqual(localeAssetFor(pack, 'home'), {
    image: join(pack.world.assetDir, 'home.png'),
    size: { width: 1, height: 1 },
    places: [{ x: 0, y: 0 }],
  });
});

test('localeAssetFor hands out immutable size and places', (t) => {
  const pack = loadThemePackSync(worldPack(t));
  const { size, places } = localeAssetFor(pack, 'home');
  assert.throws(() => { size.width = 99; }, TypeError);
  assert.throws(() => { places.push({ x: 0, y: 0 }); }, TypeError);
  assert.throws(() => { places[0].x = 5; }, TypeError);
  assert.deepEqual(localeAssetFor(pack, 'home').places, [{ x: 0, y: 0 }]);
  assert.deepEqual(pack.world.size, { width: 1, height: 1 });
});

test('localeAssetFor throws when the locale image is a symlink', (t) => {
  const pack = loadThemePackSync(worldPack(t));
  swapForSymlink(join(pack.world.assetDir, 'home.png'));
  assert.throws(
    () => localeAssetFor(pack, 'home'),
    /theme "[^"]+": world: locale "home": .*home\.png is not a regular non-symlink file/,
  );
});

test('localeAssetFor throws when the locale image was deleted after load', (t) => {
  const pack = loadThemePackSync(worldPack(t));
  rmSync(join(pack.world.assetDir, 'home.png'));
  const expected = join(pack.world.assetDir, 'home.png');
  assert.throws(
    () => localeAssetFor(pack, 'home'),
    (error) => {
      assert.equal(error.message, `theme "${pack.id}": world: locale "home" image missing (expected ${expected})`);
      assert.equal(error.code, 'ENOENT');
      assert.equal(error.cause?.code, 'ENOENT');
      return true;
    },
  );
});

test('localeAssetFor throws when the pack has no world', (t) => {
  assert.throws(() => localeAssetFor(proven(t), 'home'), /has no world/);
});

test('localeAssetFor throws for a locale the world lacks', (t) => {
  const pack = loadThemePackSync(worldPack(t));
  assert.throws(() => localeAssetFor(pack, 'scoped'), /has no locale "scoped"/);
});

test('localeAssetFor throws the world fault, and refuses an unproven world', (t) => {
  const dir = worldPack(t);
  rmSync(join(dir, 'world'), { recursive: true });
  assert.throws(
    () => localeAssetFor(loadThemePackSync(dir), 'home'),
    /world: asset-root "world" does not exist/,
  );
  const parsedOnly = parseThemePack(DESCRIPTOR + WORLD_BLOCK, dir);
  assert.throws(
    () => localeAssetFor(parsedOnly, 'home'),
    /world: asset-root "world" has not been filesystem-proven/,
  );
});
