import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packEntryRole, parseThemePack } from 'familiar-theme';
import { DESCRIPTOR } from './helpers/fixture.js';

// Two members with different ancestors. Every slot needs a member and no member
// may hold none, so solo gives up slot 11 to duo.
const TWO = DESCRIPTOR.replace(
  'slots: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]',
  'slots: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]',
).replace(
  'members:\n',
  `members:
  - id: duo
    label: Duo
    slots: [11]
    persona: second fixture
    asset-root: art/sprites/duo
    animation:
      kind: static
    poses:
      idle: i
      working: w
      needs-input: n
      needs-approval: a
      error: e
      done: d
`,
);
const pack = parseThemePack(TWO, '/pack');

test('the descriptor and licence entries are content', () => {
  for (const rel of [
    'theme.yaml', 'LICENSE', 'LICENSE-assets', 'License.md', 'LICENCE.txt',
    'copying.txt', 'COPYING', 'NOTICE', 'notice.md', 'LICENSES',
    'LICENSES/MIT.txt', 'LICENSES/assets/CC-BY-4.0.txt', 'licensed-art/a.png',
  ]) assert.equal(packEntryRole(pack, rel), 'content', rel);
});

test('member trees are content at every depth', () => {
  for (const rel of [
    'sprites/solo', 'sprites/solo/idle.png', 'sprites/solo/animation/idle/f01.png',
    'art/sprites/duo', 'art/sprites/duo/provenance.json',
  ]) assert.equal(packEntryRole(pack, rel), 'content', rel);
});

test('proper prefixes of an asset-root are ancestors, shared or not', () => {
  for (const rel of ['sprites', 'art', 'art/sprites']) {
    assert.equal(packEntryRole(pack, rel), 'ancestor', rel);
  }
});

test('everything else is outside, including siblings under an ancestor', () => {
  for (const rel of [
    '.worktrees', '.superpowers', '.superpowers/x', 'README.md', 'docs', 'docs/a.md',
    '.git', 'sprites/README.md', 'sprites/.DS_Store', 'sprites/solo-old',
    'art/README', 'art/sprites/other', 'theme.yaml.bak', 'node_modules',
  ]) assert.equal(packEntryRole(pack, rel), 'outside', rel);
});

test('a malformed relative path is a named error, not a role', () => {
  for (const rel of ['', '/abs', 'a//b', './a', 'a/../b', 'a/.', 7]) {
    assert.throws(() => packEntryRole(pack, rel), /packEntryRole: expected a relative \/ path/);
  }
});
