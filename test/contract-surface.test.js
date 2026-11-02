import { test } from 'node:test';
import assert from 'node:assert/strict';

// Intra-package: this is the one place a deep import into src/protocol/slots.js
// is legal, because the test's whole point is to check that FILE's own export
// surface — not the barrel's. Asserting through the barrel would prove nothing
// about whether slots.js itself leaks something the barrel happens not to
// re-export.
test('the contract module exports only the contract', async () => {
  const contract = Object.keys(await import('../src/protocol/slots.js'));
  assert.deepEqual(contract.sort(), ['SLOT_COUNT', 'assertSlot']);
});

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
