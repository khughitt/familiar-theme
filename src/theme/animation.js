import { createHash } from 'node:crypto';
import {
  lstatSync as fsLstatSync,
  readFileSync as fsReadFileSync,
  realpathSync as fsRealpathSync,
} from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { parse } from 'yaml';
import { LIMITS } from '../limits.js';
import { pngSize } from '../png.js';
import { STATES } from '../protocol/state.js';
import { ID_RE, memberAssetDir, memberOrThrow } from './pack.js';
import { proveRegularFile } from './prove.js';

export const CLIP_ROLES = Object.freeze([
  'idle-ambient',
  'working-loop',
  'done-enter',
  'error-enter',
  'idle-special',
]);

export const ROLE_SPEC = Object.freeze({
  'idle-ambient': Object.freeze({ state: 'idle', playback: 'once' }),
  'working-loop': Object.freeze({ state: 'working', playback: 'loop' }),
  'done-enter': Object.freeze({ state: 'done', playback: 'once' }),
  'error-enter': Object.freeze({ state: 'error', playback: 'once' }),
  'idle-special': Object.freeze({ state: 'idle', playback: 'once' }),
});

const FRAME_DURATION_MIN = 40;
const FRAME_DURATION_MAX = 5_000;
const CLIP_DURATION_MAX = 5_000;
const AUTHORED_FRAME_MAX = LIMITS.AUTHORED_FRAME_MAX;
const DECODED_BYTES_MAX = LIMITS.ANIMATION_DECODED_BYTES_MAX;
const SHA256_RE = /^[a-f0-9]{64}$/;

const STATIC_REF = Object.freeze({ kind: 'static' });
const STATIC_SET = Object.freeze({ kind: 'static' });

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesOf(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function exactObject(value, keys, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object with exactly keys: ${keys.join(', ')}`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw new Error(`${context} must be an object with exactly keys: ${keys.join(', ')}`);
  }
}

// The manifest's own key set is exact; its role set is not. A member may animate
// one state and leave the rest to its static sprite, so the rule here is
// membership plus non-emptiness rather than equality.
function subsetObject(value, keys, context) {
  const invalid = () => new Error(
    `${context} must be an object naming at least one of: ${keys.join(', ')}`,
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const actual = Object.keys(value);
  if (actual.length === 0 || actual.some((key) => !keys.includes(key))) throw invalid();
}

function parseManifest(manifestBytes, memberId) {
  let manifest;
  try {
    manifest = parse(bytesOf(manifestBytes).toString('utf8'));
  } catch (error) {
    throw new Error(`animation: member "${memberId}" manifest is invalid YAML: ${error.message}`);
  }

  const memberContext = `animation: member "${memberId}"`;
  exactObject(manifest, ['version', 'clips'], `${memberContext} manifest`);
  if (manifest.version !== 1) {
    throw new Error(`${memberContext} manifest version must be exactly 1 (found ${String(manifest.version)})`);
  }
  subsetObject(manifest.clips, CLIP_ROLES, `${memberContext} clips`);
  // One rule at both layers: the pack manifest already refuses this, and a
  // runtime manifest that declares only idle-special loads a clip that can
  // never play -- planAnimation returns static for idle without idle-ambient.
  if (Object.hasOwn(manifest.clips, 'idle-special')
      && !Object.hasOwn(manifest.clips, 'idle-ambient')) {
    throw new Error(`${memberContext} clips: idle-special requires idle-ambient`);
  }
  return manifest;
}

// This is the only manifest-to-runtime builder. It is pure: callers supply all
// bytes, and every path is derived here from the already-safe member/role/frame
// ids. The async and sync loaders differ only in how they collect those bytes.
function buildAnimationSet({ manifestBytes, memberId, memberDir, rootBytes, frameBytes }) {
  const manifest = parseManifest(manifestBytes, memberId);
  const described = [];
  const authoredPaths = new Map();

  // parseManifest has already proved every key is a known role and that there is
  // at least one, so filtering CLIP_ROLES yields a non-empty list in contract
  // order — the manifest's own key order never reaches the runtime.
  const declaredRoles = CLIP_ROLES.filter((role) => Object.hasOwn(manifest.clips, role));
  for (const role of declaredRoles) {
    const spec = ROLE_SPEC[role];
    const context = `animation: member "${memberId}" role "${role}"`;
    const raw = manifest.clips[role];
    exactObject(raw, ['playback', 'root-sha256', 'frames'], context);

    if (raw.playback !== spec.playback) {
      throw new Error(
        `${context} playback must be "${spec.playback}" (found ${JSON.stringify(raw.playback)})`,
      );
    }
    if (typeof raw['root-sha256'] !== 'string' || !SHA256_RE.test(raw['root-sha256'])) {
      throw new Error(`${context} root-sha256 must be exactly 64 lowercase hexadecimal characters`);
    }
    if (!Array.isArray(raw.frames) || raw.frames.length < 2) {
      throw new Error(`${context} frames must be an array containing at least a leading and trailing root`);
    }

    const rootPath = join(memberDir, `${spec.state}.png`);
    const frames = raw.frames.map((frame, index) => {
      const frameContext = `${context} frame ${index}`;
      exactObject(frame, ['ref', 'duration-ms'], frameContext);
      if (typeof frame.ref !== 'string' || frame.ref === '') {
        throw new Error(`${frameContext} ref is missing`);
      }
      if (frame.ref !== 'root' && !ID_RE.test(frame.ref)) {
        throw new Error(
          `${frameContext} ref "${frame.ref}" is invalid — frame ids may only contain lowercase `
          + 'letters, digits, and hyphens',
        );
      }
      if (!Number.isInteger(frame['duration-ms'])
        || frame['duration-ms'] < FRAME_DURATION_MIN
        || frame['duration-ms'] > FRAME_DURATION_MAX) {
        throw new Error(
          `${frameContext} duration ${String(frame['duration-ms'])}ms violates the inclusive `
          + `${FRAME_DURATION_MIN}..${FRAME_DURATION_MAX}ms authored-frame bound`,
        );
      }

      const path = frame.ref === 'root'
        ? rootPath
        : join(memberDir, 'animation', role, `${frame.ref}.png`);
      if (frame.ref !== 'root') {
        authoredPaths.set(path, {
          path,
          context: `${context} frame "${frame.ref}"`,
        });
      }
      return { ref: frame.ref, durationMs: frame['duration-ms'], path };
    });

    if (frames[0].ref !== 'root') {
      throw new Error(`${context} first frame must be the reserved symbolic ref "root"`);
    }
    if (frames.at(-1).ref !== 'root') {
      throw new Error(`${context} last frame must be the reserved symbolic ref "root"`);
    }
    if (spec.playback === 'loop' && frames[0].durationMs !== frames.at(-1).durationMs) {
      throw new Error(`${context} leading and trailing root durations must be equal`);
    }

    const normalized = spec.playback === 'loop' ? frames.slice(0, -1) : frames;
    const totalDurationMs = normalized.reduce((sum, frame) => sum + frame.durationMs, 0);
    if (totalDurationMs > CLIP_DURATION_MAX) {
      throw new Error(
        `${context} seam-normalized duration is ${totalDurationMs}ms, over the `
        + `${CLIP_DURATION_MAX}ms authored-clip bound`,
      );
    }

    described.push({
      role,
      state: spec.state,
      playback: spec.playback,
      rootSha256: raw['root-sha256'],
      rootPath,
      frames,
    });
  }

  if (authoredPaths.size > AUTHORED_FRAME_MAX) {
    throw new Error(
      `animation: member "${memberId}" declares ${authoredPaths.size} authored frames; `
      + `the bound is ${AUTHORED_FRAME_MAX} frame PNGs`,
    );
  }

  const rootPaths = new Map();
  for (const clip of described) {
    rootPaths.set(clip.rootPath, {
      path: clip.rootPath,
      context: `animation: member "${memberId}" role "${clip.role}" root`,
    });
  }
  if (rootBytes === undefined && frameBytes === undefined) {
    return { rootPaths, framePaths: authoredPaths };
  }
  if (!(rootBytes instanceof Map) || !(frameBytes instanceof Map)) {
    throw new Error('animation: internal byte maps must be supplied together');
  }

  const pngs = new Map();
  function validatedPng(path, bytes, context) {
    if (pngs.has(path)) return pngs.get(path);
    if (bytes === undefined || bytes === null) throw new Error(`${context} is missing at ${path}`);
    const data = bytesOf(bytes);
    if (data.length === 0) throw new Error(`${context} is empty at ${path}`);
    let size;
    try {
      size = pngSize(data);
    } catch (error) {
      throw new Error(`${context} is an invalid PNG: ${error.message}`);
    }
    const decoded = BigInt(size.w) * BigInt(size.h) * 4n;
    const result = Object.freeze({
      width: size.w,
      height: size.h,
      decodedBytes: decoded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(decoded) : decoded,
      sha256: sha256(data),
    });
    pngs.set(path, result);
    return result;
  }

  const clips = new Map();
  for (const clip of described) {
    const context = `animation: member "${memberId}" role "${clip.role}"`;
    const root = validatedPng(
      clip.rootPath,
      rootBytes.get(clip.rootPath),
      `${context} root`,
    );
    if (root.sha256 !== clip.rootSha256) {
      throw new Error(`${context} root-sha256 does not match the current root bytes at ${clip.rootPath}`);
    }

    const frames = clip.frames.map((frame) => {
      const meta = frame.ref === 'root'
        ? root
        : validatedPng(
          frame.path,
          frameBytes.get(frame.path),
          `${context} frame "${frame.ref}"`,
        );
      if (meta.width !== root.width || meta.height !== root.height) {
        throw new Error(
          `${context} frame "${frame.ref}" is ${meta.width}x${meta.height}; `
          + `its root is ${root.width}x${root.height}`,
        );
      }
      return Object.freeze({
        ref: frame.ref,
        path: frame.path,
        durationMs: frame.durationMs,
        width: meta.width,
        height: meta.height,
        decodedBytes: meta.decodedBytes,
      });
    });

    clips.set(clip.role, Object.freeze({
      state: clip.state,
      playback: clip.playback,
      rootSha256: clip.rootSha256,
      frames: Object.freeze(frames),
    }));
  }

  let decodedBytes = 0n;
  for (const { path } of authoredPaths.values()) {
    const decoded = pngs.get(path).decodedBytes;
    decodedBytes += typeof decoded === 'bigint' ? decoded : BigInt(decoded);
  }
  if (decodedBytes > BigInt(DECODED_BYTES_MAX)) {
    throw new Error(
      `animation: member "${memberId}" decoded animation pixels require ${decodedBytes} bytes; `
      + 'the bound is 128 MiB',
    );
  }

  return Object.freeze({ kind: 'clips', clips });
}

function assertPresent(fs, containDir, path, context) {
  try {
    return proveRegularFile(path, containDir, fs, context);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${context} is missing at ${path}`);
    throw error;
  }
}

async function readRequiredAsync(readFile, fs, containDir, path, context) {
  assertPresent(fs, containDir, path, context);
  try {
    return bytesOf(await readFile(path));
  } catch (error) {
    throw new Error(`${context} is unreadable at ${path}: ${error.message}`);
  }
}

function readRequiredSync(readFile, fs, containDir, path, context) {
  assertPresent(fs, containDir, path, context);
  try {
    return bytesOf(readFile(path));
  } catch (error) {
    throw new Error(`${context} is unreadable at ${path}: ${error.message}`);
  }
}

function assertNoLightMasters(memberDir, memberId, lstat) {
  for (const state of STATES) {
    const path = join(memberDir, `${state}.light.png`);
    try {
      lstat(path);
      throw new Error(
        `animation: clips member "${memberId}" state "${state}" cannot define a terminal `
        + `.light.png master (${path})`,
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function manifestLocation(pack, memberId) {
  const memberDir = memberAssetDir(pack, memberId);
  return { memberDir, manifestPath: join(memberDir, 'animation.yaml') };
}

export async function loadAnimationMember(
  pack,
  memberId,
  { readFile = fsReadFile, lstat = fsLstatSync, realpath = fsRealpathSync } = {},
) {
  const member = memberOrThrow(pack, memberId);
  const { memberDir, manifestPath } = manifestLocation(pack, memberId);
  const fs = { lstat, realpath };
  const kind = member.animation?.kind;

  if (kind === 'static') {
    try {
      lstat(manifestPath);
      throw new Error(
        `animation: static member "${memberId}" forbids an animation manifest at ${manifestPath}`,
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return Object.freeze({ ref: STATIC_REF, set: STATIC_SET });
  }
  if (kind !== 'clips') {
    throw new Error(`animation: member "${memberId}" has invalid parsed animation kind ${JSON.stringify(kind)}`);
  }

  assertNoLightMasters(memberDir, memberId, lstat);
  const manifestBytes = await readRequiredAsync(
    readFile,
    fs,
    memberDir,
    manifestPath,
    `animation: clips member "${memberId}" requires animation.yaml`,
  );
  const required = buildAnimationSet({ manifestBytes, memberId, memberDir });
  const rootBytes = new Map();
  const frameBytes = new Map();
  for (const asset of required.rootPaths.values()) {
    rootBytes.set(asset.path, await readRequiredAsync(readFile, fs, memberDir, asset.path, asset.context));
  }
  for (const asset of required.framePaths.values()) {
    frameBytes.set(asset.path, await readRequiredAsync(readFile, fs, memberDir, asset.path, asset.context));
  }

  const set = buildAnimationSet({
    manifestBytes,
    memberId,
    memberDir,
    rootBytes,
    frameBytes,
  });
  const ref = Object.freeze({
    kind: 'clips',
    manifest: manifestPath,
    sha256: sha256(manifestBytes),
  });
  return Object.freeze({ ref, set });
}

function clipsRefLocation(ref) {
  exactObject(ref, ['kind', 'manifest', 'sha256'], 'animation reference');
  if (ref.kind !== 'clips') {
    throw new Error(`animation reference kind must be "clips" (found ${JSON.stringify(ref.kind)})`);
  }
  if (typeof ref.manifest !== 'string' || !isAbsolute(ref.manifest)) {
    throw new Error('animation reference manifest must be an absolute path');
  }
  if (basename(ref.manifest) !== 'animation.yaml') {
    throw new Error('animation reference manifest must end in animation.yaml');
  }
  const memberDir = dirname(ref.manifest);
  const memberId = basename(memberDir);
  if (!ID_RE.test(memberId) || basename(dirname(memberDir)) !== 'sprites') {
    throw new Error('animation reference manifest must identify a safe member under sprites/');
  }
  if (typeof ref.sha256 !== 'string' || !SHA256_RE.test(ref.sha256)) {
    throw new Error('animation reference sha256 must be exactly 64 lowercase hexadecimal characters');
  }
  return { memberDir, memberId };
}

export function loadAnimationRefSync(
  ref,
  { readFile = fsReadFileSync, lstat = fsLstatSync, realpath = fsRealpathSync } = {},
) {
  if (ref?.kind === 'static') {
    exactObject(ref, ['kind'], 'animation reference');
    return STATIC_SET;
  }

  const { memberDir, memberId } = clipsRefLocation(ref);
  const fs = { lstat, realpath };
  const manifestBytes = readRequiredSync(
    readFile,
    fs,
    memberDir,
    ref.manifest,
    `animation reference for member "${memberId}" manifest`,
  );
  const actualSha256 = sha256(manifestBytes);
  if (actualSha256 !== ref.sha256) {
    throw new Error(
      `animation reference sha256 changed for member "${memberId}" `
      + `(accepted ${ref.sha256}, current ${actualSha256})`,
    );
  }

  assertNoLightMasters(memberDir, memberId, lstat);
  const required = buildAnimationSet({ manifestBytes, memberId, memberDir });
  const rootBytes = new Map();
  const frameBytes = new Map();
  for (const asset of required.rootPaths.values()) {
    rootBytes.set(asset.path, readRequiredSync(readFile, fs, memberDir, asset.path, asset.context));
  }
  for (const asset of required.framePaths.values()) {
    frameBytes.set(asset.path, readRequiredSync(readFile, fs, memberDir, asset.path, asset.context));
  }
  return buildAnimationSet({
    manifestBytes,
    memberId,
    memberDir,
    rootBytes,
    frameBytes,
  });
}
