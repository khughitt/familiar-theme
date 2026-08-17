// The number of canonical slots. CONTRACT: a theme's members must cover all of
// them, so the count is part of what a theme file must satisfy. The colours that
// go with them are engine policy and live in ./slot-hues.js.
export const SLOT_COUNT = 12;

export function assertSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new Error(`slot out of range: ${slot}`);
  }
  return slot;
}
