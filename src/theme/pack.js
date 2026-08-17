import {
  lstatSync as fsLstatSync,
  readFileSync as fsReadFileSync,
  realpathSync as fsRealpathSync,
} from 'node:fs';
import {
  lstat as fsLstat,
  readFile as fsReadFile,
  realpath as fsRealpath,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { assertSlot, SLOT_COUNT } from '../protocol/slots.js';
import { STATES } from '../protocol/state.js';

// EVERY id in a theme pack that enters a live path join is validated by this one
// regex — the theme's own id AND its members'.
//
// THE TWO PATH AUTHORITIES:
//
//   - a MEMBER id must be the final segment of its descriptor-owned asset-root.
//     parseAssetRoot() validates both together; consumers receive the proven
//     member directory and never reconstruct `sprites/<member>`.
//   - the THEME id -> src/config.js:33, themeDirFor(): join(paths.userThemesDir, id)
//     or join(paths.themesDir, id). That id comes from config.yaml and so never
//     passes through parseThemePack at all — which is why themeDirFor calls
//     assertId ITSELF rather than trusting an upstream check.
//
// (An earlier version of this comment named spritePath, baker.js/cachePathFor and
// `familiar bake`. All three are DELETED. That mattered: this is the only
// documentation of a live security invariant, and a reader who greps those names,
// finds nothing and concludes the regex is vestigial would loosen it — and
// loosening it to admit "../" opens real path traversal in both joiners above.)
//
// Restricting the charset — never merely stripping ".." — is what keeps a theme
// pack from naming a path outside the directory it belongs in. The theme id
// matters MORE than the member ids, not less: theme.yaml is a shareable,
// downloadable artifact, and a member id is only ever reachable through a pack
// whose own id already had to pass this same check.
//
// Exported so the other joiners validate against this exact regex rather than a
// copy of it that can drift.
export const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function assertId(id, what, example) {
  if (typeof id !== 'string' || id === '') throw new Error(`${what} is missing`);
  if (!ID_RE.test(id)) {
    throw new Error(
      `${what} "${id}" is invalid — ids may only contain lowercase letters, digits, ` +
      `and hyphens (e.g. "${example}")`
    );
  }
}

// The height a state stands at when the theme does not say. It is the ONLY home for
// this number: parseThemePack fills every unlisted state with it, so no consumer
// downstream ever writes `?? DEFAULT_ROWS` — a second home for the same decision, and
// the one place a missing state could become an `undefined` that kitty renders as a
// full-height cat.
export const DEFAULT_ROWS = 12;

// The theme format's own version, and the ONLY authority for it: the parser
// checks against this and tools/art/theme/scaffold.js emits it, so a bump is a
// one-line change rather than a hunt for literals.
//
// UNRELATED to this package's npm version and to animation.yaml's version.
// None of the three versions the others.
export const SPEC_VERSION = 1;

// 0 rows is an invisible cat; 40 is a screenful. Both are mistakes, and neither is one the
// renderer can detect — it just draws what it is told.
//
// EXPORTED: box.js (Task 2) validates the rows it is handed against the SAME range this file
// validates the theme against. A second copy of "1..40" in the renderer is a bound free to
// drift from the one the parser enforces — the mirror-with-nothing-enforcing-it defect this
// codebase keeps deleting (ID_RE, GRAPHICS_MARKERS, FLOOR).
export const ROW_MIN = 1;
export const ROW_MAX = 40;

const shown = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value));

// CLOSED, at every level. An ignored key is a silent mistake: a misspelled
// `presona:` used to surface as "missing persona", which points the author at
// the wrong line entirely, and a key from a future spec-version passed unread.
const THEME_KEYS = new Set(['spec-version', 'id', 'label', 'description', 'rows', 'members']);
const MEMBER_KEYS = new Set(['id', 'asset-root', 'label', 'slots', 'persona', 'animation', 'poses']);

function assertClosed(object, allowed, what) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${what}: unknown key "${key}" — allowed: ${[...allowed].sort().join(', ')}`
      );
    }
  }
}

// THEME-LEVEL, one number. The compiler (compile.mjs canonicalise) composites all six of a
// member's poses onto ONE shared canvas, so they render at the same size; a per-state height
// could only scale that one canvas differently per mood, which is the resize jitter
// canonicalise was written to remove. An earlier schema made rows a per-state map, defended
// by an "aspect ratios span 4x so width varies" argument the shared canvas made false.
//
// A leftover per-state MAP is the migration case and gets a message that NAMES the change. A
// bad SCALAR (float, string, null, bool) is an ordinary type error and gets the plain
// message — telling someone who wrote `rows: 10.5` that "maps are unsupported" misnames their
// mistake.
function parseRows(raw, themeId) {
  if (raw === undefined) return DEFAULT_ROWS;

  if (typeof raw === 'object' && raw !== null) {
    throw new Error(
      `theme "${themeId}": rows must be a single whole number for the theme, not a per-state map — ` +
      `per-state rows: is no longer supported; the shared canvas makes one height per theme the honest shape`
    );
  }
  if (!Number.isInteger(raw)) {
    throw new Error(`theme "${themeId}": rows must be a whole number (found ${shown(raw)})`);
  }
  if (raw < ROW_MIN || raw > ROW_MAX) {
    throw new Error(
      `theme "${themeId}": rows is ${raw} — rows must be between ${ROW_MIN} and ${ROW_MAX} inclusive`
    );
  }
  return raw;
}

// A member holds one or more slots. Coverage is checked at the pack level, not
// here: one member covering all twelve is legal, and so is twelve members
// holding one each. What is never legal is a slot no member holds -- that is a
// project that resolves to nothing, and it used to surface at RESOLUTION time
// from defaultMemberForSlot rather than at parse time.
function parseSlots(raw, themeId, memberId) {
  if (!Array.isArray(raw)) {
    throw new Error(
      `theme "${themeId}": member "${memberId}": slots must be an array (found ${shown(raw)})`
    );
  }
  if (raw.length === 0) {
    throw new Error(
      `theme "${themeId}": member "${memberId}": slots is empty — a member holds at least one slot`
    );
  }
  const seen = new Set();
  for (const slot of raw) {
    try {
      assertSlot(slot);
    } catch (err) {
      throw new Error(`theme "${themeId}": member "${memberId}": ${err.message}`);
    }
    if (seen.has(slot)) {
      throw new Error(`theme "${themeId}": member "${memberId}": slots repeats ${slot}`);
    }
    seen.add(slot);
  }
  return [...raw];
}

function parseAnimation(raw, themeId, memberId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`theme "${themeId}": member "${memberId}" is missing animation declaration`);
  }
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'kind' || !['static', 'clips'].includes(raw.kind)) {
    throw new Error(
      `theme "${themeId}": member "${memberId}": animation must be exactly { kind: static|clips }`,
    );
  }
  return Object.freeze({ kind: raw.kind });
}

function parseAssetRoot(raw, themeId, memberId, themeDir) {
  const context = `theme "${themeId}": member "${memberId}": asset-root`;
  if (raw === undefined) throw new Error(`${context} is missing`);
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(`${context} must be a nonempty relative serialized / path`);
  }
  if (isAbsolute(raw) || /^[A-Za-z]:\//.test(raw) || raw.includes('\\') || raw.includes('//')) {
    throw new Error(`${context} "${raw}" must be a relative serialized / path with single separators`);
  }
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${context} "${raw}" cannot contain empty, "." or ".." segments`);
  }
  if (segments.length < 2
      || segments.at(-2) !== 'sprites'
      || segments.at(-1) !== memberId) {
    throw new Error(`${context} "${raw}" must end in sprites/${memberId}`);
  }
  const assetRoot = segments.join('/');
  return {
    assetRoot,
    assetDir: resolve(themeDir, ...segments),
    assetDirProof: 'lexical',
  };
}

// Validation is strict and fails early. A half-populated theme must never fall
// back to another theme's sprites — that is a bug that looks like a design.
export function parseThemePack(text, dir, { descriptorLabel = `${dir}/theme.yaml` } = {}) {
  const data = parse(text) ?? {};

  const specVersion = data['spec-version'];
  if (specVersion === undefined) {
    throw new Error(
      `${descriptorLabel}: missing spec-version — add "spec-version: ${SPEC_VERSION}" as the first line`
    );
  }
  // Number.isInteger, not typeof: YAML parses `1.0` to the number 1, and the
  // distinction carries no meaning downstream. A quoted "1" is a string and fails.
  if (!Number.isInteger(specVersion)) {
    throw new Error(
      `${descriptorLabel}: spec-version must be an integer (found ${shown(specVersion)})`
    );
  }
  if (specVersion !== SPEC_VERSION) {
    throw new Error(
      `${descriptorLabel}: spec-version ${specVersion} is not supported — ` +
      `this build understands spec-version ${SPEC_VERSION}`
    );
  }
  assertClosed(data, THEME_KEYS, descriptorLabel);

  // The theme's OWN id, validated exactly as strictly as its members' — it is a
  // path segment in two other modules, and it arrives from a file the user may
  // have downloaded.
  assertId(data.id, 'theme.yaml: id', 'cats');
  if (typeof data.label !== 'string' || data.label === '') {
    throw new Error(`theme "${data.id}": missing label`);
  }

  // Optional, because `cats` shipped without one and a theme is still a theme
  // with no blurb. Present-but-blank is refused: that is someone who meant to
  // write one, and a listing rendering an empty cell would hide the mistake.
  const rawDescription = data.description;
  if (rawDescription !== undefined
      && (typeof rawDescription !== 'string' || !rawDescription.trim())) {
    throw new Error(
      `${descriptorLabel}: description must be a non-empty string when present ` +
      `(got ${JSON.stringify(rawDescription)})`
    );
  }
  const description = rawDescription === undefined ? null : rawDescription.trim();

  if (!Array.isArray(data.members) || data.members.length === 0) {
    throw new Error(`theme "${data.id}": has no members`);
  }

  // THEME-LEVEL: one height for the theme. A member whose `working` needs a different
  // height has drifted from the shared archetype — a thing to SEE (redraw the pose),
  // not to paper over with a per-state number.
  const rows = parseRows(data.rows, data.id);

  const members = new Map();
  const bySlot = new Map();

  for (const [index, raw] of data.members.entries()) {
    if (raw === null || typeof raw !== 'object') {
      throw new Error(
        `theme "${data.id}": member at index ${index} is not an object (found ${raw === null ? 'null' : typeof raw})`
      );
    }
    assertId(raw.id, `theme "${data.id}": member id`, 'ginger-tabby');
    if (members.has(raw.id)) throw new Error(`theme "${data.id}": duplicate member id: ${raw.id}`);
    if (typeof raw.label !== 'string' || raw.label === '') {
      throw new Error(`theme "${data.id}": member "${raw.id}" is missing label`);
    }
    if ('slot' in raw) {
      throw new Error(
        `theme "${data.id}": member "${raw.id}": "slot" was replaced by "slots" in ` +
        `spec-version ${SPEC_VERSION} — write: slots: [${shown(raw.slot)}]`
      );
    }
    assertClosed(raw, MEMBER_KEYS, `theme "${data.id}": member "${raw.id}"`);
    const slots = parseSlots(raw.slots, data.id, raw.id);
    if (typeof raw.persona !== 'string' || raw.persona.trim() === '') {
      throw new Error(`theme "${data.id}": member "${raw.id}" is missing persona`);
    }
    const asset = parseAssetRoot(raw['asset-root'], data.id, raw.id, dir);

    const poses = raw.poses ?? {};
    if (typeof poses !== 'object' || poses === null || Array.isArray(poses)) {
      throw new Error(
        `theme "${data.id}": member "${raw.id}": poses must be a map of the six states (found ${shown(raw.poses)})`
      );
    }
    // Before the presence loop, not after. A misspelled `idel:` is BOTH an
    // unknown key and a missing `idle:`, and the presence loop throws first --
    // reporting "missing pose: idle" about a line that is right there, spelled
    // wrong. Naming the key the author actually wrote is the whole point.
    assertClosed(poses, new Set(STATES), `theme "${data.id}": member "${raw.id}": poses`);
    for (const state of STATES) {
      if (typeof poses[state] !== 'string' || poses[state].trim() === '') {
        throw new Error(`theme "${data.id}": member "${raw.id}" is missing pose: ${state}`);
      }
    }

    members.set(raw.id, {
      id: raw.id,
      label: raw.label,
      slots,
      persona: raw.persona.trim(),
      ...asset,
      animation: parseAnimation(raw.animation, data.id, raw.id),
      poses: Object.fromEntries(STATES.map((s) => [s, poses[s].trim()])),
    });

    // Order is significant: the first member declared for a slot is its default.
    for (const slot of slots) {
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push(raw.id);
    }
  }

  // Every slot needs a member. autoSlot hashes a project to ANY of the twelve,
  // so an uncovered slot is a project that resolves to nothing -- and it used to
  // fail at resolution time, far from the theme that caused it.
  const uncovered = [];
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    if (!bySlot.has(slot)) uncovered.push(slot);
  }
  if (uncovered.length > 0) {
    throw new Error(
      `theme "${data.id}": no member holds ` +
      `${uncovered.length === 1 ? `slot ${uncovered[0]}` : `slots ${uncovered.join(', ')}`} — ` +
      `all ${SLOT_COUNT} slots need a member, because any project can hash to any slot`
    );
  }

  return { specVersion, id: data.id, label: data.label, description, dir, rows, members, bySlot };
}

function assertDescriptor(themeRealDir, descriptorPath, descriptorRealPath, descriptorStat) {
  if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink()) {
    throw new Error(
      `theme descriptor must be a regular non-symlink file in the real theme directory: ${descriptorPath}`,
    );
  }
  if (dirname(descriptorRealPath) !== themeRealDir) {
    throw new Error(
      `theme descriptor must be a sibling in the real theme directory ${themeRealDir}: ${descriptorRealPath}`,
    );
  }
}

function assertRealMemberDir(pack, member, realAssetDir, assetStat) {
  const fromTheme = relative(pack.dir, realAssetDir);
  if (fromTheme === '' || fromTheme === '..' || fromTheme.startsWith(`..${sep}`) || isAbsolute(fromTheme)) {
    throw new Error(
      `theme "${pack.id}": member "${member.id}": asset-root "${member.assetRoot}" `
      + `resolves outside the real theme directory (${realAssetDir})`,
    );
  }
  if (!assetStat.isDirectory()) {
    throw new Error(
      `theme "${pack.id}": member "${member.id}": asset-root "${member.assetRoot}" `
      + `is not a directory (${realAssetDir})`,
    );
  }
}

function withMemberProof(pack, member, prove) {
  try {
    const realAssetDir = prove(member);
    return { ...member, assetDir: realAssetDir, assetDirProof: 'filesystem' };
  } catch (cause) {
    const context = `theme "${pack.id}": member "${member.id}": asset-root "${member.assetRoot}"`;
    const assetRootFault = cause?.message?.startsWith(`theme "${pack.id}": member "${member.id}":`)
      ? cause
      : cause?.code === 'ENOENT'
        ? new Error(`${context} does not exist (${member.assetDir})`, { cause })
        : new Error(`${context} cannot be proven: ${cause?.message ?? String(cause)}`, { cause });
    const { assetDir: _unproven, assetDirProof: _proof, ...rest } = member;
    return { ...rest, assetRootFault };
  }
}

function replaceMembers(pack, members) {
  return { ...pack, members: new Map(members.map((member) => [member.id, member])) };
}

export async function loadThemePack(themeDir, {
  descriptorPath = join(themeDir, 'theme.yaml'),
  descriptorLabel,
  readFile = fsReadFile,
  lstat = fsLstat,
  realpath = fsRealpath,
} = {}) {
  const themeRealDir = await realpath(themeDir);
  const [descriptorStat, descriptorRealPath] = await Promise.all([
    lstat(descriptorPath),
    realpath(descriptorPath),
  ]);
  assertDescriptor(themeRealDir, descriptorPath, descriptorRealPath, descriptorStat);
  const pack = parseThemePack(
    (await readFile(descriptorRealPath, 'utf8')).toString(),
    themeRealDir,
    { descriptorLabel },
  );
  const members = [];
  for (const member of pack.members.values()) {
    try {
      const realAssetDir = await realpath(member.assetDir);
      const assetStat = await lstat(realAssetDir);
      assertRealMemberDir(pack, member, realAssetDir, assetStat);
      members.push({ ...member, assetDir: realAssetDir, assetDirProof: 'filesystem' });
    } catch (cause) {
      members.push(withMemberProof(pack, member, () => { throw cause; }));
    }
  }
  return replaceMembers(pack, members);
}

export function loadThemePackSync(themeDir, {
  descriptorPath = join(themeDir, 'theme.yaml'),
  descriptorLabel,
  readFile = fsReadFileSync,
  lstat = fsLstatSync,
  realpath = fsRealpathSync,
} = {}) {
  const themeRealDir = realpath(themeDir);
  const descriptorStat = lstat(descriptorPath);
  const descriptorRealPath = realpath(descriptorPath);
  assertDescriptor(themeRealDir, descriptorPath, descriptorRealPath, descriptorStat);
  const pack = parseThemePack(
    readFile(descriptorRealPath, 'utf8').toString(),
    themeRealDir,
    { descriptorLabel },
  );
  const members = [...pack.members.values()].map((member) => withMemberProof(pack, member, () => {
    const realAssetDir = realpath(member.assetDir);
    const assetStat = lstat(realAssetDir);
    assertRealMemberDir(pack, member, realAssetDir, assetStat);
    return realAssetDir;
  }));
  return replaceMembers(pack, members);
}

export function defaultMemberForSlot(pack, slot) {
  const ids = pack.bySlot.get(assertSlot(slot));
  if (!ids || ids.length === 0) {
    throw new Error(`theme "${pack.id}" has no member for slot ${slot}`);
  }
  return ids[0];
}

export function memberOrThrow(pack, memberId) {
  const member = pack.members.get(memberId);
  if (!member) throw new Error(`theme "${pack.id}" has no member "${memberId}"`);
  return member;
}

export function memberAssetDir(pack, memberId) {
  const member = memberOrThrow(pack, memberId);
  if (member.assetRootFault) throw member.assetRootFault;
  if (member.assetDirProof !== 'filesystem'
      || typeof member.assetDir !== 'string'
      || !isAbsolute(member.assetDir)) {
    throw new Error(
      `theme "${pack.id}": member "${memberId}": asset-root "${member.assetRoot}" `
      + 'has not been filesystem-proven by a theme loader',
    );
  }
  return member.assetDir;
}
