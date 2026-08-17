import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, symlinkSync, openSync, closeSync, ftruncateSync,
  rmSync, statSync, readdirSync, realpathSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateThemePack, LIMITS } from 'familiar-theme';
import { writePack, DESCRIPTOR } from './helpers/fixture.js';

const CANDIDATE_DESCRIPTOR = DESCRIPTOR.replace('id: gate-fixture', 'id: candidate-fixture');

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const pack = (t, opts) => {
  const dir = writePack(opts);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const rejects = (dir, re, opts) => assert.rejects(() => validateThemePack(dir, opts), re);

test('the happy path returns the proven pack', async (t) => {
  const p = await validateThemePack(pack(t));
  assert.equal(p.id, 'gate-fixture');
  assert.equal(p.members.get('solo').assetDirProof, 'filesystem');
});

test('a symlinked PACK ROOT validates with the default descriptor', async (t) => {
  const dir = pack(t);
  const link = join(dirname(dir), `link-${basename(dir)}`);
  symlinkSync(dir, link);
  t.after(() => rmSync(link, { force: true }));
  const p = await validateThemePack(link);
  assert.equal(p.id, 'gate-fixture');
});

test('a symlinked PACK ROOT accepts a candidate spelled through its real path', async (t) => {
  const dir = pack(t);
  const link = join(dirname(dir), `link-${basename(dir)}`);
  const candidate = join(dir, '.theme.yaml.candidate');
  writeFileSync(candidate, CANDIDATE_DESCRIPTOR);
  symlinkSync(dir, link);
  t.after(() => rmSync(link, { force: true }));
  const p = await validateThemePack(link, { descriptorPath: candidate });
  assert.equal(p.id, 'candidate-fixture');
});

test('gate errors are pack-relative, never absolute', async (t) => {
  const dir = pack(t);
  symlinkSync('/etc/passwd', join(dir, 'sprites', 'solo', 'evil.png'));
  const real = realpathSync(dir);
  await assert.rejects(() => validateThemePack(dir), (e) => {
    assert.match(e.message, /sprites\/solo\/evil\.png/);
    assert.ok(!e.message.includes(real), 'leaked the absolute pack path');
    return true;
  });
});

test('a symlink is rejected by type even when it points INSIDE the pack', async (t) => {
  const dir = pack(t);
  symlinkSync(join(dir, 'theme.yaml'), join(dir, 'inner-link'));
  await rejects(dir, /inner-link.*symlink/);
});

test('a symlinked descriptor rejects', async (t) => {
  const dir = pack(t);
  const real = join(dir, 'real.yaml');
  writeFileSync(real, DESCRIPTOR);
  rmSync(join(dir, 'theme.yaml'));
  symlinkSync(real, join(dir, 'theme.yaml'));
  await rejects(dir, /symlink/);
});

test('a unix socket is rejected by type', async (t) => {
  const dir = pack(t);
  const server = createServer();
  await new Promise((ok) => server.listen(join(dir, 'sock'), ok));
  t.after(() => server.close());
  await rejects(dir, /sock.*(socket|not a regular file)/);
});

test('a FIFO is rejected by type, not opened (child process, hard timeout)', (t) => {
  const dir = pack(t);
  execFileSync('mkfifo', [join(dir, 'sprites', 'trap')]);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { validateThemePack } from 'familiar-theme';
    try { await validateThemePack(${JSON.stringify(dir)}); console.log('ACCEPTED'); }
    catch (e) { console.log('REJECTED: ' + e.message); }
  `], { encoding: 'utf8', timeout: 10_000, cwd: REPO_ROOT });
  assert.equal(r.signal, null, 'validation hung on the FIFO — it opened it');
  assert.match(r.stdout, /REJECTED: .*trap.*(FIFO|not a regular file)/);
});

test('an empty-directory tree breaches MAX_ENTRY_COUNT; at the limit it passes', async (t) => {
  const at = pack(t);
  for (let i = 0; i < LIMITS.MAX_ENTRY_COUNT - 9; i++) mkdirSync(join(at, `d${i}`));
  await validateThemePack(at);

  const over = pack(t);
  for (let i = 0; i < LIMITS.MAX_ENTRY_COUNT - 9 + 1; i++) mkdirSync(join(over, `d${i}`));
  await rejects(over, /MAX_ENTRY_COUNT|entries/);
});

test('MAX_TOTAL_BYTES: sparse filler at the limit passes, one byte over fails', async (t) => {
  const sizeOf = (dir) => {
    let total = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p); else total += statSync(p).size;
      }
    };
    walk(dir);
    return total;
  };
  const fill = (dir, target) => {
    const fd = openSync(join(dir, 'filler.bin'), 'w');
    ftruncateSync(fd, target - sizeOf(dir));
    closeSync(fd);
  };
  const at = pack(t);
  fill(at, LIMITS.MAX_TOTAL_BYTES);
  await validateThemePack(at);

  const over = pack(t);
  fill(over, LIMITS.MAX_TOTAL_BYTES + 1);
  await rejects(over, /MAX_TOTAL_BYTES|total bytes/);
});

test('a Git LFS pointer rejects wherever it sits, with the materialized-files message', async (t) => {
  const POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n';
  const asAsset = pack(t);
  writeFileSync(join(asAsset, 'sprites', 'solo', 'idle.png'), POINTER);
  await rejects(asAsset, /sprites\/solo\/idle\.png is a Git LFS pointer; v1 themes must contain materialized files/);

  const asData = pack(t);
  writeFileSync(join(asData, 'sprites', 'solo', 'provenance.json'), POINTER);
  await rejects(asData, /provenance\.json is a Git LFS pointer/);
});

test('an oversized descriptor rejects before parsing; at the limit it parses', async (t) => {
  const pad = (n) => `${DESCRIPTOR}#${'x'.repeat(n - DESCRIPTOR.length - 2)}\n`;
  const at = pack(t, { descriptor: pad(LIMITS.MAX_DESCRIPTOR_BYTES) });
  await validateThemePack(at);
  const over = pack(t, { descriptor: pad(LIMITS.MAX_DESCRIPTOR_BYTES + 1) });
  await rejects(over, /MAX_DESCRIPTOR_BYTES|theme\.yaml is \d+ bytes/);
});

test('an oversized animation.yaml rejects at preflight', async (t) => {
  const dir = pack(t);
  writeFileSync(join(dir, 'sprites', 'solo', 'animation.yaml'),
    `# ${'x'.repeat(LIMITS.MAX_DESCRIPTOR_BYTES)}\n`);
  await rejects(dir, /animation\.yaml is \d+ bytes|animation\.yaml.*MAX_DESCRIPTOR_BYTES/);
});

test('an oversized PNG rejects at lstat, before any bytes are read', async (t) => {
  const dir = pack(t);
  const fd = openSync(join(dir, 'sprites', 'solo', 'big.png'), 'w');
  ftruncateSync(fd, LIMITS.MAX_ASSET_BYTES + 1);
  closeSync(fd);
  await rejects(dir, /big\.png.*MAX_ASSET_BYTES|big\.png is \d+ bytes/);
});

test('whole-pack strict: a fault loadThemePack tolerates, the gate throws', async (t) => {
  const dir = pack(t);
  rmSync(join(dir, 'sprites', 'solo'), { recursive: true });
  const real = realpathSync(dir);
  await assert.rejects(() => validateThemePack(dir), (e) => {
    assert.match(e.message, /asset-root "sprites\/solo" does not exist/);
    assert.ok(!e.message.includes(real), 'assetRootFault leaked the absolute pack root');
    return true;
  });
});

test('a candidate descriptorPath replaces theme.yaml: parsed, counted once, live one not counted', async (t) => {
  const dir = pack(t);
  writeFileSync(join(dir, '.theme.yaml.candidate'), CANDIDATE_DESCRIPTOR);
  for (let i = 0; i < LIMITS.MAX_ENTRY_COUNT - 9; i++) mkdirSync(join(dir, `d${i}`));
  const p = await validateThemePack(dir, { descriptorPath: join(dir, '.theme.yaml.candidate') });
  assert.equal(p.id, 'candidate-fixture');
});

test('with an INVALID live descriptor and a valid candidate, the candidate wins', async (t) => {
  const dir = pack(t);
  writeFileSync(join(dir, 'theme.yaml'), 'not: [valid, theme, yaml\n');
  writeFileSync(join(dir, '.theme.yaml.candidate'), CANDIDATE_DESCRIPTOR);
  const p = await validateThemePack(dir, { descriptorPath: join(dir, '.theme.yaml.candidate') });
  assert.equal(p.id, 'candidate-fixture');
});

test('an alternate candidate must be a regular non-symlink sibling of the pack root', async (t) => {
  const dir = pack(t);
  const real = join(dir, 'real-candidate.yaml');
  writeFileSync(real, DESCRIPTOR);
  symlinkSync(real, join(dir, '.theme.yaml.candidate'));
  await rejects(dir, /candidate.*symlink|regular/, { descriptorPath: join(dir, '.theme.yaml.candidate') });

  const outside = join(dirname(dir), `outside-${Date.now()}.yaml`);
  writeFileSync(outside, DESCRIPTOR);
  t.after(() => rmSync(outside, { force: true }));
  await rejects(dir, /candidate.*sibling|inside/, { descriptorPath: outside });
});

test('a candidate beneath a nonexistent external parent rejects pack-relatively', async (t) => {
  const dir = pack(t);
  const parent = join(dirname(dir), `missing-${Date.now()}`);
  const candidate = join(parent, 'candidate.yaml');
  await assert.rejects(() => validateThemePack(dir, { descriptorPath: candidate }), (e) => {
    assert.match(e.message, /candidate.*sibling|inside/);
    assert.ok(!e.message.includes(parent), 'leaked the external candidate parent');
    return true;
  });
});

test('a pack at EXACTLY both limits validates through the candidate seam', async (t) => {
  const dir = pack(t);
  writeFileSync(join(dir, '.theme.yaml.candidate'), DESCRIPTOR);
  for (let i = 0; i < LIMITS.MAX_ENTRY_COUNT - 9 - 1; i++) mkdirSync(join(dir, `d${i}`));
  const logicalBytes = () => {
    let total = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (d === dir && (e.name === 'theme.yaml' || e.name === '.theme.yaml.candidate')) continue;
        total += statSync(p).size;
      }
    };
    walk(dir);
    return total + statSync(join(dir, '.theme.yaml.candidate')).size;
  };
  const fd = openSync(join(dir, 'filler.bin'), 'w');
  ftruncateSync(fd, 0);
  closeSync(fd);
  const pad = LIMITS.MAX_TOTAL_BYTES - logicalBytes();
  const fd2 = openSync(join(dir, 'filler.bin'), 'w');
  ftruncateSync(fd2, pad);
  closeSync(fd2);
  const p = await validateThemePack(dir, { descriptorPath: join(dir, '.theme.yaml.candidate') });
  assert.equal(p.id, 'gate-fixture');
});

test('the candidate size cap applies to the candidate, and only one descriptor is checked', async (t) => {
  const dir = pack(t);
  writeFileSync(join(dir, 'theme.yaml'), `${DESCRIPTOR}#${'x'.repeat(LIMITS.MAX_DESCRIPTOR_BYTES)}\n`);
  writeFileSync(join(dir, '.theme.yaml.candidate'), DESCRIPTOR);
  const p = await validateThemePack(dir, { descriptorPath: join(dir, '.theme.yaml.candidate') });
  assert.equal(p.id, 'gate-fixture');
});
