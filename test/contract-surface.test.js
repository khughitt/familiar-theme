import { test } from 'node:test';
import assert from 'node:assert/strict';

test('slots left the contract: the package has no SLOT_COUNT or assertSlot', async () => {
  const pkg = await import('familiar-theme');
  assert.equal('SLOT_COUNT' in pkg, false);
  assert.equal('assertSlot' in pkg, false);
});

// Intra-package: this is the one place a deep import into src/protocol/ is legal,
// because each test's whole point is to check that FILE's own export surface -- not
// the barrel's. Asserting through the barrel would prove nothing about whether a
// protocol module leaks something the barrel happens not to re-export.
test('the locale module exports only the contract', async () => {
  assert.deepEqual(Object.keys(await import('../src/protocol/locale.js')).sort(), ['LOCALES', 'assertLocale']);
});

test('the role module exports only the contract', async () => {
  assert.deepEqual(Object.keys(await import('../src/protocol/role.js')), ['DEFAULT_ROLE']);
});

test('LOCALES is home plus the seven flow states in order', async () => {
  const { LOCALES, assertLocale } = await import('../src/protocol/locale.js');
  assert.deepEqual([...LOCALES], ['home', 'captured', 'scoped', 'designed', 'planned', 'implementing', 'verified', 'closed']);
  assert.ok(Object.isFrozen(LOCALES));
  assert.equal(assertLocale('home'), 'home');
  assert.throws(() => assertLocale('tavern'), /unknown locale: tavern/);
});
