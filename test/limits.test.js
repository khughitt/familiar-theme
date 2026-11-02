import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from 'familiar-theme';

// The pin IS the point: "bounded" is not a contract, these numbers are.
// A deliberate recalibration edits this test in the same commit as the constant.
test('LIMITS carries exactly the spec table, frozen', () => {
  assert.deepEqual({ ...LIMITS }, {
    MAX_MEMBERS: 64,
    MAX_ENTRY_COUNT: 1024,
    MAX_TOTAL_BYTES: 268_435_456,
    MAX_DESCRIPTOR_BYTES: 131_072,
    MAX_ASSET_BYTES: 8_388_608,
    MAX_ASSET_SIDE: 4096,
    MAX_ASSET_PIXELS: 8_388_608,
    MAX_DECODED_TOTAL: 1_073_741_824,
    AUTHORED_FRAME_MAX: 64,
    ANIMATION_DECODED_BYTES_MAX: 134_217_728,
  });
  assert.ok(Object.isFrozen(LIMITS));
});
