import {
  opendir, lstat as fsLstat, open as fsOpen, readFile as fsReadFile, realpath as fsRealpath,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { LIMITS } from './limits.js';
import { STATES } from './protocol/state.js';
import { decodeRgba, pngSize } from './png.js';
import { loadAnimationMember } from './theme/animation.js';
import { packEntryRole } from './theme/content.js';
import { loadThemePack, parseThemePack } from './theme/pack.js';

const LFS_SIG = Buffer.from('version https://git-lfs.github.com/spec/v1');
const fail = (rel, why) => { throw new Error(`${rel}: ${why}`); };

export function assertDecodedTotal(total) {
  if (total > LIMITS.MAX_DECODED_TOTAL) {
    throw new Error(
      `pack promises ${total} decoded bytes — the bound is ${LIMITS.MAX_DECODED_TOTAL} (MAX_DECODED_TOTAL)`,
    );
  }
}

async function assertMaterialized(path, rel) {
  const handle = await fsOpen(path, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(LFS_SIG.length), 0, LFS_SIG.length, 0);
    if (bytesRead === LFS_SIG.length && buffer.equals(LFS_SIG)) {
      throw new Error(`${rel} is a Git LFS pointer; v1 themes must contain materialized files`);
    }
  } finally {
    await handle.close();
  }
}

const kindOf = (stat, entry) => (stat.isSymbolicLink() || entry?.isSymbolicLink() ? 'a symlink'
  : stat.isFIFO() ? 'a FIFO' : stat.isSocket() ? 'a socket'
  : stat.isFile() ? 'a regular file' : 'not a regular file');

// The descriptor's one read (spec §2): roles, walk and load all use these bytes.
// A second read could be rewritten to name an outside alias that resolves to an
// already-walked directory, and coverage would pass through it.
//
// The read is bounded, not just pre-checked: the pack directory is the author's,
// so the file can grow after lstat. At most MAX_DESCRIPTOR_BYTES + 1 bytes are
// ever held; the extra byte proves the descriptor is over the bound.
async function readDescriptor(path, rel, afterStat = () => {}) {
  const stat = await fsLstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(rel, `is ${kindOf(stat)} — packs may contain only regular files and directories`);
  }
  if (stat.size > LIMITS.MAX_DESCRIPTOR_BYTES) {
    fail(rel, `is ${stat.size} bytes — descriptors are bounded at ${LIMITS.MAX_DESCRIPTOR_BYTES} (MAX_DESCRIPTOR_BYTES)`);
  }
  afterStat(path);
  const handle = await fsOpen(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const held = await handle.stat();
    if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino) {
      fail(rel, 'changed while the gate read it — validate a stable pack');
    }
    const buffer = Buffer.alloc(LIMITS.MAX_DESCRIPTOR_BYTES + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > LIMITS.MAX_DESCRIPTOR_BYTES) {
      fail(rel, `is more than ${LIMITS.MAX_DESCRIPTOR_BYTES} bytes — descriptors are bounded at ${LIMITS.MAX_DESCRIPTOR_BYTES} (MAX_DESCRIPTOR_BYTES)`);
    }
    const bytes = buffer.subarray(0, filled);
    if (bytes.subarray(0, LFS_SIG.length).equals(LFS_SIG)) {
      throw new Error(`${rel} is a Git LFS pointer; v1 themes must contain materialized files`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function preflight(root, { candidatePath, pack, descriptorBytes }) {
  let entries = 0;
  let totalBytes = 0;
  const pngs = [];
  const count = (n) => {
    entries += n;
    if (entries > LIMITS.MAX_ENTRY_COUNT) {
      throw new Error(`pack has more than ${LIMITS.MAX_ENTRY_COUNT} entries (MAX_ENTRY_COUNT)`);
    }
  };
  const addBytes = (n, rel) => {
    totalBytes += n;
    if (totalBytes > LIMITS.MAX_TOTAL_BYTES) {
      fail(rel, `pushes the pack past ${LIMITS.MAX_TOTAL_BYTES} total bytes (MAX_TOTAL_BYTES)`);
    }
  };
  const checkFile = async (path, rel, stat) => {
    addBytes(stat.size, rel);
    if (rel.endsWith('.png') && stat.size > LIMITS.MAX_ASSET_BYTES) {
      fail(rel, `is ${stat.size} bytes — the bound is ${LIMITS.MAX_ASSET_BYTES} (MAX_ASSET_BYTES)`);
    }
    if (basename(rel) === 'animation.yaml' && stat.size > LIMITS.MAX_DESCRIPTOR_BYTES) {
      fail(rel, `is ${stat.size} bytes — descriptors are bounded at ${LIMITS.MAX_DESCRIPTOR_BYTES} (MAX_DESCRIPTOR_BYTES)`);
    }
    await assertMaterialized(path, rel);
    if (rel.endsWith('.png')) pngs.push(path);
  };
  count(1);
  addBytes(descriptorBytes, 'theme.yaml');
  const walk = async (dir, relDir) => {
    const handle = await opendir(dir);
    for await (const entry of handle) {
      const path = join(dir, entry.name);
      if (relDir === '' && (entry.name === 'theme.yaml' || path === candidatePath)) continue;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const role = packEntryRole(pack, rel);
      if (role === 'outside') continue;
      const stat = await fsLstat(path);
      if (stat.isDirectory() && !entry.isSymbolicLink()) { count(1); await walk(path, rel); continue; }
      if (role === 'ancestor') {
        fail(rel, `is ${kindOf(stat, entry)} — it lies on a member's asset-root and must be a directory`);
      }
      if (!stat.isFile() || entry.isSymbolicLink() || stat.isSymbolicLink()) {
        fail(rel, `is ${kindOf(stat, entry)} — packs may contain only regular files and directories`);
      }
      count(1);
      await checkFile(path, rel, stat);
    }
  };
  await walk(root, '');
  return { pngs };
}

export async function validateThemePack(dir, { descriptorPath } = {}) {
  return validateThemePackWithLoader(dir, { descriptorPath, loadAnimation: loadAnimationMember });
}

export async function validateThemePackWithLoader(dir, {
  descriptorPath, loadAnimation = loadAnimationMember,
  afterDescriptorStat = () => {}, afterDescriptorRead = () => {},
} = {}) {
  const root = await fsRealpath(dir);
  let candidatePath;
  if (descriptorPath === undefined) {
    candidatePath = join(root, 'theme.yaml');
  } else {
    const lexicalRoot = resolve(dir);
    const lexicalCandidate = resolve(descriptorPath);
    const lexicalParent = dirname(lexicalCandidate);
    if (lexicalParent !== lexicalRoot && lexicalParent !== root) {
      throw new Error('candidate descriptor must be a sibling of theme.yaml inside the pack root');
    }
    candidatePath = join(await fsRealpath(lexicalParent), basename(lexicalCandidate));
    if (dirname(candidatePath) !== root) {
      throw new Error('candidate descriptor must be a sibling of theme.yaml inside the pack root');
    }
  }
  try {
    return await validateResolved(root, candidatePath, loadAnimation, { afterDescriptorStat, afterDescriptorRead });
  } catch (cause) {
    if (cause?.message?.includes(root)) {
      const rootPrefix = root.endsWith(sep) ? root : root + sep;
      throw new Error(cause.message.split(rootPrefix).join('').split(root).join('.'), { cause });
    }
    throw cause;
  }
}

async function validateResolved(root, candidatePath, loadAnimation, { afterDescriptorStat, afterDescriptorRead }) {
  const isCandidate = candidatePath !== join(root, 'theme.yaml');
  if (isCandidate && dirname(candidatePath) !== root) {
    throw new Error('candidate descriptor must be a sibling of theme.yaml inside the pack root');
  }
  if (isCandidate) {
    const stat = await fsLstat(candidatePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('candidate descriptor must be a regular non-symlink file');
    }
  }
  const descriptorBytes = await readDescriptor(candidatePath, 'theme.yaml', afterDescriptorStat);
  afterDescriptorRead(candidatePath);
  const descriptorText = descriptorBytes.toString('utf8');
  const parsed = parseThemePack(descriptorText, root, { descriptorLabel: 'theme.yaml' });
  const found = await preflight(root, { candidatePath, pack: parsed, descriptorBytes: descriptorBytes.length });
  const pack = await loadThemePack(root, {
    descriptorPath: candidatePath,
    descriptorLabel: 'theme.yaml',
    readFile: async (path) => {
      if (path !== candidatePath) {
        throw new Error('theme.yaml: the descriptor moved during validation — validate a stable pack');
      }
      return descriptorText;
    },
  });
  for (const member of pack.members.values()) {
    if (member.assetRootFault) throw member.assetRootFault;
  }
  if (pack.world?.assetRootFault) throw pack.world.assetRootFault;

  // PASS 1 — headers, every PNG, accounting before any inflate (spec §2).
  // The buffers read here are RETAINED and pass 2 decodes those exact bytes:
  // no second read, no pass-to-pass drift window.
  const retained = new Map();
  let decodedTotal = 0;
  for (const path of found.pngs) {
    const rel = relative(root, path);
    const bytes = await fsReadFile(path);
    let size;
    try { size = pngSize(bytes); } catch (cause) { fail(rel, cause.message); }
    if (size.w > LIMITS.MAX_ASSET_SIDE || size.h > LIMITS.MAX_ASSET_SIDE) {
      fail(rel, `is ${size.w}x${size.h} — sides are bounded at ${LIMITS.MAX_ASSET_SIDE} (MAX_ASSET_SIDE)`);
    }
    if (size.w * size.h > LIMITS.MAX_ASSET_PIXELS) {
      fail(rel, `is ${size.w * size.h} pixels — the bound is ${LIMITS.MAX_ASSET_PIXELS} (MAX_ASSET_PIXELS)`);
    }
    decodedTotal += size.w * size.h * 4;
    assertDecodedTotal(decodedTotal);
    retained.set(path, bytes);
  }

  // Declared coverage: six states per member; .light.png health is already
  // proven by the every-PNG rule — presence is what optionality is about.
  for (const member of pack.members.values()) {
    for (const state of STATES) {
      const asset = join(member.assetDir, `${state}.png`);
      if (!retained.has(asset)) {
        throw new Error(`member "${member.id}" is missing state "${state}" (${relative(root, asset)})`);
      }
    }
  }

  // Declared locale images: retained (walked) like the state PNGs, and exactly the
  // world's size. `root` is a realpath, so the retained keys and the loader-proven
  // `imagePath` are both real paths.
  if (pack.world) {
    const { width, height } = pack.world.size;
    for (const [name, locale] of pack.world.locales) {
      const bytes = retained.get(locale.imagePath);
      if (!bytes) {
        throw new Error(
          `world: locale "${name}" image ${relative(root, locale.imagePath)} was not walked by the gate`,
        );
      }
      const size = pngSize(bytes);
      if (size.w !== width || size.h !== height) {
        throw new Error(
          `world: locale "${name}" is ${size.w}x${size.h} — the world size is ${width}x${height}`,
        );
      }
    }
  }

  // PASS 2 — full bounded decode of the retained bytes, sequential, each RGBA
  // result dropped immediately so decoded output never accumulates.
  for (const [path, bytes] of retained) {
    try { decodeRgba(bytes); } catch (cause) { fail(relative(root, path), cause.message); }
  }

  const readFromRetained = (path) => {
    const abs = resolve(path);
    if (abs.endsWith('.png')) {
      const bytes = retained.get(abs);
      if (!bytes) {
        fail(relative(root, abs), 'is referenced by animation but was not walked by the gate');
      }
      return Promise.resolve(bytes);
    }
    return fsReadFile(abs);
  };
  for (const member of pack.members.values()) {
    try {
      await loadAnimation(pack, member.id, { readFile: readFromRetained });
    } catch (cause) {
      if (cause.message.startsWith('animation')) throw cause;
      throw new Error(`animation: member "${member.id}": ${cause.message}`, { cause });
    }
  }
  return pack;
}
