// THE package's entire public surface. There are no subpaths: package.json's
// exports map makes familiar-theme/src/** unresolvable, so this file is the only
// way in, and the seam test proves nothing bypasses it.
//
export {
  parseThemePack, loadThemePack, loadThemePackSync,
  defaultMemberForSlot, memberOrThrow, memberAssetDir,
  assertId, ID_RE, ROW_MIN, ROW_MAX, DEFAULT_ROWS, SPEC_VERSION,
} from './theme/pack.js';
export { CLIP_ROLES, ROLE_SPEC, loadAnimationMember, loadAnimationRefSync } from './theme/animation.js';
export { assetsFor } from './theme/assets.js';
export { STATES, assertState } from './protocol/state.js';
export { SLOT_COUNT, assertSlot } from './protocol/slots.js';
export { crc32, pngSize, decodeRgba, encodeRgba } from './png.js';
export { LIMITS } from './limits.js';
export { validateThemePack } from './validate.js';
