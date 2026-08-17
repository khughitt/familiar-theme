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
  MAX_ENTRY_COUNT: 512,                 // measured 110 non-root entries (files AND dirs); ~4.7x
  MAX_TOTAL_BYTES: 167_772_160,         // 160 MiB; measured 34,100,336 bytes; ~4.9x
  MAX_DESCRIPTOR_BYTES: 131_072,        // 128 KiB, any parsed YAML; measured theme.yaml 25,905; ~5.1x
  MAX_ASSET_BYTES: 8_388_608,           // 8 MiB encoded per PNG; measured 1,862,125 (persian/source.png); ~4.5x
  MAX_ASSET_SIDE: 4096,                 // measured 1536; deliberately under 4x — the pixel cap
                                        // binds first; this exists so an absurd single-dimension
                                        // header fails legibly
  MAX_ASSET_PIXELS: 8_388_608,          // measured 1,572,864; ~5.3x; implies <=32 MiB decoded/asset —
                                        // there is no separate per-asset decoded constant on purpose
  MAX_DECODED_TOTAL: 536_870_912,       // 512 MiB, w*h*4 summed pack-wide; measured 138,874,248; ~3.9x
  AUTHORED_FRAME_MAX: 64,               // preserved from theme/animation.js, its justification with it
  ANIMATION_DECODED_BYTES_MAX: 134_217_728, // 128 MiB per member, preserved from theme/animation.js
});
