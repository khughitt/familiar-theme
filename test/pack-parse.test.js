import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPEC_VERSION, SLOT_COUNT } from 'familiar-theme';

test('the barrel exposes the contract constants', () => {
  assert.equal(SPEC_VERSION, 1);
  assert.equal(SLOT_COUNT, 12);
});

// "One public surface" is the spec's central architectural claim (§4), and until
// now nothing said WHAT that surface is -- only that nothing bypasses it. Pinned
// as a complete sorted set, not "includes X", because the failure this guards
// against is SUBTRACTION: Phase 1B moves the PNG codec out of this package and
// adds validateThemePack, and an export dropped in that move would break a
// consumer at import time with no test in this package going red first. A
// deliberate change to the surface edits this list; an accidental one fails here.
const BARREL_EXPORTS = [
  'CLIP_ROLES', 'DEFAULT_ROWS', 'ID_RE', 'LIMITS', 'ROLE_SPEC', 'ROW_MAX', 'ROW_MIN',
  'SLOT_COUNT', 'SPEC_VERSION', 'STATES', 'assertId', 'assertSlot', 'assertState',
  'assetsFor', 'crc32', 'decodeRgba', 'defaultMemberForSlot', 'encodeRgba', 'loadAnimationMember',
  'loadAnimationRefSync', 'loadThemePack', 'loadThemePackSync', 'memberAssetDir',
  'memberOrThrow', 'parseThemePack', 'pngSize', 'validateThemePack',
];

test('the barrel exports exactly this set and nothing else', async () => {
  assert.deepEqual(Object.keys(await import('familiar-theme')).sort(), BARREL_EXPORTS);
});

test('a deep import by package name does not resolve', async () => {
  // Proves package.json's exports map is doing its half of the job — the seam
  // test covers source text, this covers Node's resolver.
  await assert.rejects(
    () => import('familiar-theme/src/theme/pack.js'),
    /ERR_PACKAGE_PATH_NOT_EXPORTED/,
  );
});
