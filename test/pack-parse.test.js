import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from 'yaml';
import {
  SPEC_VERSION, defaultMember, loadThemePackSync, localeOrThrow, memberForRole, parseThemePack,
} from 'familiar-theme';
import { writePack, DESCRIPTOR } from './helpers/fixture.js';

test('the barrel exposes the contract constants', () => {
  assert.equal(SPEC_VERSION, 2);
});

// "One public surface" is the spec's central architectural claim (§4), and until
// now nothing said WHAT that surface is -- only that nothing bypasses it. Pinned
// as a complete sorted set, not "includes X", because the failure this guards
// against is SUBTRACTION: Phase 1B moves the PNG codec out of this package and
// adds validateThemePack, and an export dropped in that move would break a
// consumer at import time with no test in this package going red first. A
// deliberate change to the surface edits this list; an accidental one fails here.
const BARREL_EXPORTS = [
  'CLIP_ROLES', 'DEFAULT_ROLE', 'DEFAULT_ROWS', 'ID_RE', 'LIMITS', 'LOCALES', 'ROLE_SPEC', 'ROW_MAX', 'ROW_MIN',
  'SPEC_VERSION', 'STATES', 'assertId', 'assertLocale', 'assertState',
  'assetsFor', 'crc32', 'decodeRgba', 'defaultMember', 'encodeRgba', 'loadAnimationMember',
  'loadAnimationRefSync', 'loadThemePack', 'loadThemePackSync', 'localeAssetFor', 'localeOrThrow',
  'memberAssetDir', 'memberForRole', 'memberOrThrow', 'packEntryRole', 'parseThemePack', 'pngSize',
  'validateThemePack',
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

test('a member without anchor defaults to floor', () => {
  const dir = writePack();
  assert.equal(loadThemePackSync(dir).members.get('pip').anchor, 'floor');
});

test('anchor: center is parsed onto the member record', () => {
  const dir = writePack({
    descriptor: DESCRIPTOR.replace('    animation:', '    anchor: center\n    animation:'),
  });
  assert.equal(loadThemePackSync(dir).members.get('pip').anchor, 'center');
});

test('a junk anchor is refused with both legal values named', () => {
  const dir = writePack({
    descriptor: DESCRIPTOR.replace('    animation:', '    anchor: ceiling\n    animation:'),
  });
  assert.throws(() => loadThemePackSync(dir), /anchor must be "floor" or "center"/);
});

// Descriptors for the role and world cases, built as data so each case states only
// what it changes. Theme id `x` and member roots `sprites/<id>` unless a case says.
const POSES = {
  idle: 'i', working: 'w', 'needs-input': 'n', 'needs-approval': 'a', error: 'e', done: 'd',
};
const member = (id, roles, extra = {}) => ({
  id, label: id, roles, persona: 'fixture', 'asset-root': `sprites/${id}`,
  animation: { kind: 'static' }, poses: POSES, ...extra,
});
const theme = (members, extra = {}) => stringify({
  'spec-version': 2, id: 'x', label: 'X', members, ...extra,
});
const parsed = (members, extra) => parseThemePack(theme(members, extra), '/pack');

// The spec's §5.1 example world, verbatim.
const EXAMPLE_WORLD = parse(`
world:
  asset-root: world
  size: [1536, 1024]
  locales:
    home:
      image: home.png
      places:
        - [420, 880]
        - [760, 900]
        - [1100, 880]
    scoped:     { image: scoped.png,       places: [[500, 900], [1000, 900]] }
    designed:   { image: library.png,      places: [[300, 860], [760, 900], [1200, 860]] }
    planned:    { image: war-room.png,     places: [[760, 900]] }
    implementing: { image: workshop.png,   places: [[400, 900], [800, 900], [1200, 900]] }
    verified:   { image: gate.png,         places: [[760, 900]] }
`).world;
const PIP = [member('pip', ['default'])];
const withWorld = (world, members = PIP) => parsed(members, { world });
const homeOnly = (home) => ({ ...EXAMPLE_WORLD, locales: { home: { ...EXAMPLE_WORLD.locales.home, ...home } } });

test('refuses spec-version 1 naming the change', () => {
  assert.throws(
    () => parseThemePack(DESCRIPTOR.replace('spec-version: 2', 'spec-version: 1'), '/pack'),
    /spec-version 1 is not supported — this build understands spec-version 2/,
  );
  assert.throws(
    () => parseThemePack(DESCRIPTOR.replace('spec-version: 2', 'spec-version: 1'), '/pack'),
    /"slots" with "roles"/,
  );
});

test('refuses slots naming roles', () => {
  assert.throws(
    () => parsed([member('pip', undefined, { slots: [0] })]),
    /"slots" was replaced by "roles" in spec-version 2/,
  );
});

test('roles may be empty, must be ids, no repeats', () => {
  const pack = parsed([member('a', ['default']), member('b', [])]);
  assert.deepEqual(pack.members.get('b').roles, []);
  assert.equal('slots' in pack.members.get('b'), false);
  assert.throws(() => parsed([member('a', ['default', 'Reviewer'])]), /role "Reviewer" is invalid/);
  assert.throws(() => parsed([member('a', ['default', 'a', 'a'])]), /roles repeats a/);
});

test('exactly one member holds default', () => {
  assert.throws(() => parsed([member('a', []), member('b', ['planner'])]), /no member holds the role "default"/);
  assert.throws(
    () => parsed([member('a', ['default']), member('b', ['default'])]),
    /role "default" is held by both "a" and "b"/,
  );
});

test('a role is held by at most one member', () => {
  assert.throws(
    () => parsed([member('a', ['default', 'planner']), member('b', ['planner'])]),
    /role "planner" is held by both "a" and "b"/,
  );
});

test('byRole, memberForRole and defaultMember', () => {
  const pack = parsed([member('a', ['default', 'planner']), member('b', ['reviewer'])]);
  assert.deepEqual([...pack.byRole], [['default', 'a'], ['planner', 'a'], ['reviewer', 'b']]);
  assert.equal(memberForRole(pack, 'reviewer'), 'b');
  assert.equal(memberForRole(pack, 'poet'), null);
  assert.equal(defaultMember(pack), 'a');
  assert.throws(() => memberForRole(pack, 'Poet'), /role "Poet" is invalid/);
  assert.equal('bySlot' in pack, false);
});

test('refuses more than MAX_MEMBERS members', () => {
  const many = Array.from({ length: 65 }, (_, i) => member(`m${i}`, i === 0 ? ['default'] : []));
  assert.throws(() => parsed(many), /65 members — the bound is 64 \(MAX_MEMBERS\)/);
  assert.equal(parsed(many.slice(0, 64)).members.size, 64);
});

test('world is optional and parses', () => {
  const { world } = withWorld(EXAMPLE_WORLD);
  assert.equal(world.assetRoot, 'world');
  assert.equal(world.assetDir, '/pack/world');
  assert.equal(world.assetDirProof, 'lexical');
  assert.deepEqual(world.size, { width: 1536, height: 1024 });
  assert.deepEqual(world.locales.get('home').places[0], { x: 420, y: 880 });
  assert.equal(world.locales.get('home').places.length, 3);
  assert.match(world.locales.get('home').imagePath, /\/world\/home\.png$/);
  assert.equal(world.locales.get('designed').image, 'library.png');
  assert.equal(world.locales.has('closed'), false);
  assert.equal(parsed(PIP).world, null);
});

test('world keys are closed and required', () => {
  assert.throws(() => withWorld({ ...EXAMPLE_WORLD, sky: 'blue' }), /world: unknown key "sky"/);
  const { size: _size, ...noSize } = EXAMPLE_WORLD;
  assert.throws(() => withWorld(noSize), /world: size must be/);
  assert.throws(() => withWorld({ ...EXAMPLE_WORLD, size: [0, 1024] }), /world: size must be/);
  assert.throws(() => withWorld({ ...EXAMPLE_WORLD, size: [1536] }), /world: size must be/);
  assert.throws(() => withWorld([]), /world must be a map/);
  assert.throws(() => withWorld(homeOnly({ tint: 'red' })), /world: locales: home: unknown key "tint"/);
});

test('world requires home and closed locale keys', () => {
  const { home: _home, ...noHome } = EXAMPLE_WORLD.locales;
  assert.throws(() => withWorld({ ...EXAMPLE_WORLD, locales: noHome }), /world: locale "home" is required/);
  assert.throws(
    () => withWorld({ ...EXAMPLE_WORLD, locales: { ...EXAMPLE_WORLD.locales, tavern: EXAMPLE_WORLD.locales.home } }),
    /world: locales: unknown key "tavern"/,
  );
});

test('locale image is constrained', () => {
  assert.throws(() => withWorld(homeOnly({ image: '../x.png' })), /cannot contain/);
  assert.throws(() => withWorld(homeOnly({ image: 'home.jpg' })), /must end in \.png/);
  assert.throws(() => withWorld(homeOnly({ image: '/abs/home.png' })), /relative/);
  const home = withWorld(homeOnly({ image: 'sub/home.png' })).world.locales.get('home');
  assert.equal(home.image, 'sub/home.png');
  assert.equal(home.imagePath, '/pack/world/sub/home.png');
});

test('places are non-empty integer pairs inside size', () => {
  assert.throws(() => withWorld(homeOnly({ places: [] })), /at least one place/);
  assert.throws(() => withWorld(homeOnly({ places: [[1600, 10]] })), /outside size 1536x1024/);
  assert.throws(() => withWorld(homeOnly({ places: [[10, 1024]] })), /outside size 1536x1024/);
  assert.throws(() => withWorld(homeOnly({ places: [[1.5, 2]] })), /whole numbers/);
  assert.throws(() => withWorld(homeOnly({ places: [[1, 2, 3]] })), /whole numbers/);
  assert.deepEqual(withWorld(homeOnly({ places: [[0, 0], [1535, 1023]] })).world.locales.get('home').places,
    [{ x: 0, y: 0 }, { x: 1535, y: 1023 }]);
});

// Review Focus 1: a world installed over a member's art is refused, whichever way
// the two roots overlap.
test('world asset-root may not touch a member root', () => {
  const at = (assetRoot, members) => () => withWorld({ ...EXAMPLE_WORLD, 'asset-root': assetRoot }, members);
  assert.throws(at('sprites'), /lies on member "pip"'s asset-root/);
  assert.throws(at('sprites/pip'), /lies on member "pip"'s asset-root/);
  assert.throws(at('sprites/pip/world'), /inside member "pip"'s asset-root/);
  // A member root must end in sprites/<id>, so the nearest legal form of "world/pip".
  assert.throws(
    at('world', [member('pip', ['default'], { 'asset-root': 'world/sprites/pip' })]),
    /contains member "pip"'s asset-root/,
  );
  assert.throws(at('../world'), /cannot contain/);
  assert.throws(at('World'), /world: asset-root segment "World" is invalid/);
  assert.equal(withWorld({ ...EXAMPLE_WORLD, 'asset-root': 'sprites-world' }).world.assetRoot, 'sprites-world');
});

test('localeOrThrow', () => {
  const pack = withWorld(EXAMPLE_WORLD);
  assert.equal(localeOrThrow(pack, 'home').image, 'home.png');
  assert.throws(() => localeOrThrow(withWorld(homeOnly({})), 'scoped'), /theme "x" has no locale "scoped"/);
  assert.throws(() => localeOrThrow(parsed(PIP), 'home'), /theme "x" has no world/);
  assert.throws(() => localeOrThrow(pack, 'tavern'), /unknown locale: tavern/);
});

test('the loader keeps roles and the world on the pack', () => {
  const dir = writePack();
  const pack = loadThemePackSync(dir);
  assert.equal(defaultMember(pack), 'pip');
  assert.deepEqual(pack.members.get('pip').roles, ['default']);
  assert.equal(pack.world, null);
});
