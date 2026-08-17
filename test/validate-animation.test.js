import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIP_ROLES, loadAnimationMember, validateThemePack } from 'familiar-theme';
import { validateThemePackWithLoader } from '../src/validate.js';
import {
  clipsManifest, DESCRIPTOR, TINY_PNG, writeClipsPack, writePack,
} from './helpers/fixture.js';

const pack = (t, opts) => {
  const dir = writePack(opts);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('an animation.yaml on a kind: static member rejects', async (t) => {
  const dir = pack(t);
  writeFileSync(join(dir, 'sprites', 'solo', 'animation.yaml'), 'version: 1\n');
  await assert.rejects(() => validateThemePack(dir),
    /static member "solo" forbids an animation manifest/);
});

test('a clips member without animation.yaml rejects', async (t) => {
  const dir = pack(t, { descriptor: DESCRIPTOR.replace('kind: static', 'kind: clips') });
  await assert.rejects(() => validateThemePack(dir),
    /clips member "solo" requires animation\.yaml/);
});

test('a .light.png terminal master on a clips member rejects with the PROHIBITION, not a decode error', async (t) => {
  const dir = writeClipsPack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'sprites', 'solo', 'idle.light.png'), TINY_PNG());
  await assert.rejects(() => validateThemePack(dir),
    /clips member "solo".*cannot define a terminal \.light\.png master/);
});

test('a clips member with an invalid manifest rejects through the gate', async (t) => {
  const dir = pack(t, { descriptor: DESCRIPTOR.replace('kind: static', 'kind: clips') });
  writeFileSync(join(dir, 'sprites', 'solo', 'animation.yaml'), 'nonsense: true\n');
  await assert.rejects(() => validateThemePack(dir), /animation/);
});

test('a VALID clips pack passes the whole gate', async (t) => {
  const dir = writeClipsPack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = await validateThemePack(dir);
  assert.equal(p.members.get('solo').animation.kind, 'clips');
});

test('a root digest mismatch fails — proof the animation stage actually read the bytes', async (t) => {
  const wrong = clipsManifest(Buffer.from('not the root bytes'));
  const dir = writeClipsPack({ manifest: wrong });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = realpathSync(dir);
  await assert.rejects(() => validateThemePack(dir), (e) => {
    assert.match(e.message, /sha256|digest/i);
    assert.ok(!e.message.includes(real), 'animation error leaked the absolute pack root');
    return true;
  });
});

test('a missing referenced frame rejects, pack-relative', async (t) => {
  const dir = writeClipsPack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(join(dir, 'sprites', 'solo', 'animation', CLIP_ROLES[0], 'f01.png'));
  const real = realpathSync(dir);
  await assert.rejects(() => validateThemePack(dir), (e) => {
    assert.match(e.message, /f01|frame|missing/);
    assert.ok(!e.message.includes(real));
    return true;
  });
});

test('the animation stage reads RETAINED bytes: a post-pass-2 disk mutation is invisible', async (t) => {
  const dir = writeClipsPack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const framePath = join(realpathSync(dir), 'sprites', 'solo', 'animation', CLIP_ROLES[0], 'f01.png');
  const original = readFileSync(framePath);
  const seen = [];
  await validateThemePackWithLoader(dir, {
    loadAnimation: async (packValue, memberId, opts) => {
      writeFileSync(framePath, Buffer.from('mutated on disk'));
      seen.push(Buffer.from(await opts.readFile(framePath)));
      return loadAnimationMember(packValue, memberId, opts);
    },
  });
  assert.ok(seen[0].equals(original), 'the loader was handed fresh disk bytes, not the retained buffer');
  assert.ok(!readFileSync(framePath).equals(original), 'the mutation did not land — the test proved nothing');
});

test('the barrel validateThemePack cannot be handed a loader — animation always validates', async (t) => {
  const dir = pack(t, { descriptor: DESCRIPTOR.replace('kind: static', 'kind: clips') });
  await assert.rejects(
    () => validateThemePack(dir, { loadAnimation: async () => ({}) }),
    /clips member "solo" requires animation\.yaml/,
  );
});
