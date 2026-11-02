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
import { LIMITS } from '../limits.js';
import { assertLocale, LOCALES } from '../protocol/locale.js';
import { DEFAULT_ROLE } from '../protocol/role.js';
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
export const SPEC_VERSION = 2;

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
const THEME_KEYS = new Set(['spec-version', 'id', 'label', 'description', 'rows', 'members', 'world']);
const MEMBER_KEYS = new Set(['id', 'asset-root', 'label', 'roles', 'persona', 'animation', 'poses', 'anchor']);
const WORLD_KEYS = new Set(['asset-root', 'size', 'locales']);
const LOCALE_KEYS = new Set(['image', 'places']);

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

// PER-MEMBER, because a roster legitimately mixes grounded members with
// floaters. `floor` is the default and the only behavior that existed before
// spec 0.2.0 packs; `center` floats the pose in its shared canvas.
const ANCHORS = ['floor', 'center'];
function parseAnchor(raw, themeId, memberId) {
  if (raw === undefined) return 'floor';
  if (!ANCHORS.includes(raw)) {
    throw new Error(
      `theme "${themeId}": member "${memberId}": anchor must be "floor" or "center" (found ${shown(raw)})`
    );
  }
  return raw;
}

// A member holds zero or more roles. An empty list is legal: that member is reachable
// only by a pin, which is how a cast migrates without inventing roles. Who holds what
// across the pack -- one holder per role, exactly one `default` -- is checked at the
// pack level, after every member has parsed.
function parseRoles(raw, themeId, memberId) {
  const context = `theme "${themeId}": member "${memberId}"`;
  if (!Array.isArray(raw)) {
    throw new Error(`${context}: roles must be an array of role ids (found ${shown(raw)})`);
  }
  const seen = new Set();
  for (const role of raw) {
    assertId(role, `${context}: role`, 'reviewer');
    if (seen.has(role)) throw new Error(`${context}: roles repeats ${role}`);
    seen.add(role);
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

// The lexical rule for every author-supplied path in a descriptor (a member's
// asset-root, the world's asset-root, a locale image): relative, `/`-separated, no
// empty, "." or ".." segment. Returns the segments.
function parseRelativePath(raw, context) {
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
  return segments;
}

function parseAssetRoot(raw, themeId, memberId, themeDir) {
  const context = `theme "${themeId}": member "${memberId}": asset-root`;
  const segments = parseRelativePath(raw, context);
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

const isMap = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPair = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isInteger);

// A world root that is, contains or lies inside a member's root would install the
// world over that member's art (or the member's art over the world). Compared by
// segment, never by string prefix: `sprites-world` shares a prefix with `sprites/pip`
// and touches nothing.
function assertWorldClearOfMembers(context, root, members) {
  for (const member of members.values()) {
    const memberSegments = member.assetRoot.split('/');
    const shared = Math.min(root.length, memberSegments.length);
    if (!root.slice(0, shared).every((segment, i) => segment === memberSegments[i])) continue;
    const at = `${context} "${root.join('/')}"`;
    const theirs = `member "${member.id}"'s asset-root`;
    if (root.length === memberSegments.length) {
      throw new Error(`${at} lies on ${theirs} — it is that asset-root`);
    }
    if (root.length < memberSegments.length) {
      throw new Error(`${at} lies on ${theirs} "${member.assetRoot}" — it contains ${theirs}`);
    }
    throw new Error(`${at} lies inside ${theirs} "${member.assetRoot}"`);
  }
}

function parsePlaces(raw, context, size) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${context}: places must list at least one place (found ${JSON.stringify(raw)})`);
  }
  return raw.map((place, index) => {
    if (!isPair(place)) {
      throw new Error(
        `${context}: place ${index} must be [x, y], two whole numbers (found ${JSON.stringify(place)})`,
      );
    }
    const [x, y] = place;
    if (x < 0 || x >= size.width || y < 0 || y >= size.height) {
      throw new Error(
        `${context}: place ${index} [${x}, ${y}] is outside size ${size.width}x${size.height}`,
      );
    }
    return { x, y };
  });
}

// OPTIONAL: a pack without `world:` is a cast on a plain backdrop. When present, one
// size for every locale (locales swap in place without the scene jumping), `home`
// required, every other locale optional, and every path lexically confined under the
// world's own asset-root. Filesystem proof is the loader's and the gate's job, as it
// is for members.
function parseWorld(raw, themeId, themeDir, members) {
  if (raw === undefined) return null;
  const context = `theme "${themeId}": world`;
  if (!isMap(raw)) throw new Error(`${context} must be a map (found ${shown(raw)})`);
  assertClosed(raw, WORLD_KEYS, context);

  const segments = parseRelativePath(raw['asset-root'], `${context}: asset-root`);
  for (const segment of segments) assertId(segment, `${context}: asset-root segment`, 'world');
  assertWorldClearOfMembers(`${context}: asset-root`, segments, members);
  const assetRoot = segments.join('/');
  const assetDir = resolve(themeDir, ...segments);

  const rawSize = raw.size;
  if (!isPair(rawSize) || rawSize[0] < 1 || rawSize[1] < 1) {
    throw new Error(
      `${context}: size must be [width, height], two positive whole numbers (found ${JSON.stringify(rawSize)})`,
    );
  }
  const size = { width: rawSize[0], height: rawSize[1] };

  if (!isMap(raw.locales)) {
    throw new Error(`${context}: locales must be a map of locale names (found ${shown(raw.locales)})`);
  }
  assertClosed(raw.locales, new Set(LOCALES), `${context}: locales`);
  if (!('home' in raw.locales)) throw new Error(`${context}: locale "home" is required`);

  const locales = new Map();
  for (const name of LOCALES) {
    if (!(name in raw.locales)) continue;
    const localeContext = `${context}: locales: ${name}`;
    const locale = raw.locales[name];
    if (!isMap(locale)) throw new Error(`${localeContext} must be a map (found ${shown(locale)})`);
    assertClosed(locale, LOCALE_KEYS, localeContext);
    const imageSegments = parseRelativePath(locale.image, `${localeContext}: image`);
    if (!locale.image.endsWith('.png')) {
      throw new Error(`${localeContext}: image "${locale.image}" must end in .png`);
    }
    const image = imageSegments.join('/');
    locales.set(name, {
      image,
      imagePath: resolve(assetDir, ...imageSegments),
      places: parsePlaces(locale.places, localeContext, size),
    });
  }

  return { assetRoot, assetDir, assetDirProof: 'lexical', size, locales };
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
      `this build understands spec-version ${SPEC_VERSION}` +
      (specVersion === 1
        ? ' — it replaced member "slots" with "roles" (exactly one member holds ' +
          `"${DEFAULT_ROLE}") and added an optional world`
        : '')
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
  // By count, before any member parses: the bound is on what an untrusted pack may ask
  // the parser (and later the gate) to walk.
  if (data.members.length > LIMITS.MAX_MEMBERS) {
    throw new Error(
      `theme "${data.id}": ${data.members.length} members — the bound is ${LIMITS.MAX_MEMBERS} (MAX_MEMBERS)`
    );
  }

  // THEME-LEVEL: one height for the theme. A member whose `working` needs a different
  // height has drifted from the shared archetype — a thing to SEE (redraw the pose),
  // not to paper over with a per-state number.
  const rows = parseRows(data.rows, data.id);

  const members = new Map();

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
    if ('slots' in raw) {
      throw new Error(
        `theme "${data.id}": member "${raw.id}": "slots" was replaced by "roles" in ` +
        `spec-version ${SPEC_VERSION} — write roles: [...], a list of role ids (possibly empty); ` +
        `exactly one member holds "${DEFAULT_ROLE}"`
      );
    }
    assertClosed(raw, MEMBER_KEYS, `theme "${data.id}": member "${raw.id}"`);
    const roles = parseRoles(raw.roles, data.id, raw.id);
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
      roles,
      persona: raw.persona.trim(),
      ...asset,
      animation: parseAnimation(raw.animation, data.id, raw.id),
      anchor: parseAnchor(raw.anchor, data.id, raw.id),
      poses: Object.fromEntries(STATES.map((s) => [s, poses[s].trim()])),
    });
  }

  // One holder per role, so the resolver never chooses; `default` is a role like any
  // other here, which makes two `default` holders the same error as two planners.
  const byRole = new Map();
  for (const member of members.values()) {
    for (const role of member.roles) {
      if (byRole.has(role)) {
        throw new Error(
          `theme "${data.id}": role "${role}" is held by both "${byRole.get(role)}" and "${member.id}"`
        );
      }
      byRole.set(role, member.id);
    }
  }
  if (!byRole.has(DEFAULT_ROLE)) {
    throw new Error(
      `theme "${data.id}": no member holds the role "${DEFAULT_ROLE}" — exactly one must, ` +
      'because it is the member for an agent with no role or a role the pack does not cover'
    );
  }

  const world = parseWorld(data.world, data.id, dir, members);

  return { specVersion, id: data.id, label: data.label, description, dir, rows, members, byRole, world };
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

// null, not the default: whether an uncovered role falls back to `default` is the
// caller's decision to make visibly, not this lookup's to make silently.
export function memberForRole(pack, role) {
  assertId(role, 'role', 'reviewer');
  return pack.byRole.get(role) ?? null;
}

export function defaultMember(pack) {
  return pack.byRole.get(DEFAULT_ROLE);
}

export function localeOrThrow(pack, name) {
  assertLocale(name);
  if (pack.world === null) throw new Error(`theme "${pack.id}" has no world`);
  const locale = pack.world.locales.get(name);
  if (!locale) throw new Error(`theme "${pack.id}" has no locale "${name}"`);
  return locale;
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
