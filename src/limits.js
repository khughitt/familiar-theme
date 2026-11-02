// The gate's exact bounds. "Bounded" is an adjective; these are the contract.
//
// PROVENANCE (spec §1). New pack-wide limits derive from themes/cats measured
// at 2c6f865, times ~4x headroom, rounded up to a legible value. The exact
// measurement stays beside each constant so a later reader can tell whether a
// limit is still calibrated. Two constants are PRESERVED, not derived: cats
// ships zero animation, so no animation bound can be measured from it, and
// re-deriving one would replace a reasoned bound with an artifact of what
// happens to ship today.
//
// Nothing here accepts an override. A limit callers can raise is an adjective
// again.
export const LIMITS = Object.freeze({
  MAX_MEMBERS: 64,                      // members per pack; chosen, and the base the pack-wide limits below derive from
  // The pack-wide limits below are sized for MAX_MEMBERS members at cats's measured per-member
  // cost (13 entries, 2,841,695 encoded bytes, 11,572,854 decoded bytes, from the 12-member
  // measurement) plus one asset per locale (8) at the per-asset ceilings (MAX_ASSET_BYTES
  // encoded, MAX_ASSET_PIXELS * 4 decoded), rounded up to a legible value.
  MAX_ENTRY_COUNT: 1024,                // 64*13 + 8 = 840 entries; rounded up to 1024
  MAX_TOTAL_BYTES: 268_435_456,         // 256 MiB; 64*2,841,695 + 8*8,388,608 = 248,977,344 bytes; rounded up
  MAX_DESCRIPTOR_BYTES: 131_072,        // 128 KiB, any parsed YAML; measured theme.yaml 25,905; ~5.1x
  MAX_ASSET_BYTES: 8_388_608,           // 8 MiB encoded per PNG; measured 1,862,125 (persian/source.png); ~4.5x
  MAX_ASSET_SIDE: 4096,                 // measured 1536; deliberately under 4x — the pixel cap
                                        // binds first; this exists so an absurd single-dimension
                                        // header fails legibly
  MAX_ASSET_PIXELS: 8_388_608,          // measured 1,572,864; ~5.3x; implies <=32 MiB decoded/asset —
                                        // there is no separate per-asset decoded constant on purpose
  MAX_DECODED_TOTAL: 1_073_741_824,     // 1 GiB, w*h*4 summed pack-wide; 64*11,572,854 + 8*33,554,432 = 1,009,098,112; rounded up
  AUTHORED_FRAME_MAX: 64,               // preserved from theme/animation.js, its justification with it
  ANIMATION_DECODED_BYTES_MAX: 134_217_728, // 128 MiB per member, preserved from theme/animation.js
});
