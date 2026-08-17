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
