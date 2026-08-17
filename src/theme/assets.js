import { lstatSync as fsLstatSync, realpathSync as fsRealpathSync } from 'node:fs';
import { join } from 'node:path';
import { STATES } from '../protocol/state.js';
import { memberAssetDir } from './pack.js';
import { proveRegularFile } from './prove.js';

// What the baker used to be, minus the baking. It still validates
// every source, it isolated failure BY MEMBER, and it built the paths that enter
// the bus. bin/familiar leans on all three -- a member with a missing sprite must
// fault only the sessions resolving to THAT member, and be evicted with a reason.
// Without this, a dangling path reaches the bus and fails silently on a surface
// with no error channel.
//
// It also absorbs spritePath()'s light-variant rule, which is the only conditional
// the theme format supports (a vampire-cat recoiling from a light theme, without
// any renderer learning what a vampire is).
//
// Selection proves regular-file-and-containment without reading image bytes. A member
// costs 12 metadata calls in the dark or with all light variants present, and 18 when
// every light variant is absent.

// Select AND prove in one pass — each selected asset is proven exactly once,
// keeping the per-member bound at 12–18 metadata calls (6 states x [proof] or
// [light-ENOENT + base proof]). Proving in selection and again in the caller
// would be 24.
function provenTerminal(memberDir, memberId, state, mode, fs) {
  const base = join(memberDir, `${state}.png`);
  if (mode === 'light') {
    const light = join(memberDir, `${state}.light.png`);
    try {
      proveRegularFile(light, memberDir, fs, `assets: member "${memberId}" state "${state}"`);
      return light;
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
    }
  }
  try {
    proveRegularFile(base, memberDir, fs, `assets: member "${memberId}" state "${state}"`);
    return base;
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw new Error(
        `assets: terminal sprite missing for member "${memberId}" state "${state}" (expected ${base})`,
      );
    }
    throw cause;
  }
}

export function assetsFor(pack, memberId, mode, {
  lstat = fsLstatSync, realpath = fsRealpathSync,
} = {}) {
  const memberDir = memberAssetDir(pack, memberId); // lookup/proof before asset I/O
  const fs = { lstat, realpath };

  const assets = {};
  for (const state of STATES) {
    const terminal = provenTerminal(memberDir, memberId, state, mode, fs);
    // `rows` rides ALONG WITH the paths, on the same object, because it is the same fact:
    // how tall this member is drawn. One number per theme (parseThemePack validated it), so
    // there is no `?? 12` here and there must never be one — a second home for the default is
    // a default that drifts.
    assets[state] = { terminal, rows: pack.rows };
  }
  return assets;
}
