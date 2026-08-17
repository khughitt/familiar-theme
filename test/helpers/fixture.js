import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { CLIP_ROLES, encodeRgba, ROLE_SPEC, STATES } from 'familiar-theme';

export const TINY_PNG = () => encodeRgba({ w: 1, h: 1, buf: new Uint8Array([0, 0, 0, 255]) });

// The smallest legal v1 pack: one member holding all twelve slots, six 1x1 states.
export const DESCRIPTOR = `spec-version: 1
id: gate-fixture
label: Gate Fixture
members:
  - id: solo
    label: Solo
    slots: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    persona: test fixture
    asset-root: sprites/solo
    animation:
      kind: static
    poses:
      idle: i
      working: w
      needs-input: n
      needs-approval: a
      error: e
      done: d
`;

export function writePack({ descriptor = DESCRIPTOR } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'theme-gate-'));
  const memberDir = join(dir, 'sprites', 'solo');
  mkdirSync(memberDir, { recursive: true });
  for (const state of STATES) writeFileSync(join(memberDir, `${state}.png`), TINY_PNG());
  writeFileSync(join(dir, 'theme.yaml'), descriptor);
  return dir;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function clipsManifest(rootBytes) {
  return {
    version: 1,
    clips: Object.fromEntries(CLIP_ROLES.map((role) => [role, {
      playback: ROLE_SPEC[role].playback,
      'root-sha256': sha256(rootBytes),
      frames: [
        { ref: 'root', 'duration-ms': 100 },
        { ref: 'f01', 'duration-ms': 100 },
        { ref: 'root', 'duration-ms': 100 },
      ],
    }])),
  };
}

export function writeClipsPack({ manifest, frameBytes } = {}) {
  const rootBytes = TINY_PNG();
  const dir = writePack({ descriptor: DESCRIPTOR.replace('kind: static', 'kind: clips') });
  const memberDir = join(dir, 'sprites', 'solo');
  writeFileSync(join(memberDir, 'animation.yaml'), stringify(manifest ?? clipsManifest(rootBytes)));
  for (const role of CLIP_ROLES) {
    mkdirSync(join(memberDir, 'animation', role), { recursive: true });
    writeFileSync(join(memberDir, 'animation', role, 'f01.png'), frameBytes ?? rootBytes);
  }
  return dir;
}
