import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packEntryRole, parseThemePack } from 'familiar-theme';
import { DESCRIPTOR } from './helpers/fixture.js';

// Two members with different ancestors. pip keeps the default role; duo holds none.
const TWO = DESCRIPTOR.replace(
  'members:\n',
  `members:
  - id: duo
    label: Duo
    roles: []
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
    'sprites/pip', 'sprites/pip/idle.png', 'sprites/pip/animation/idle/f01.png',
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
    '.git', 'sprites/README.md', 'sprites/.DS_Store', 'sprites/pip-old',
    'art/README', 'art/sprites/other', 'theme.yaml.bak', 'node_modules',
  ]) assert.equal(packEntryRole(pack, rel), 'outside', rel);
});

test('a malformed relative path is a named error, not a role', () => {
  for (const rel of ['', '/abs', 'a//b', './a', 'a/../b', 'a/.', 7]) {
    assert.throws(() => packEntryRole(pack, rel), /packEntryRole: expected a relative \/ path/);
  }
});

const WORLD_DESCRIPTOR = `${DESCRIPTOR}world:
  asset-root: art/world
  size: [1536, 1024]
  locales:
    home:
      image: home.png
      places:
        - [420, 880]
`;

test('the world asset root is content and its prefixes ancestors', () => {
  const worldPack = parseThemePack(WORLD_DESCRIPTOR, '/pack');
  assert.equal(packEntryRole(worldPack, 'art/world'), 'content');
  assert.equal(packEntryRole(worldPack, 'art/world/home.png'), 'content');
  assert.equal(packEntryRole(worldPack, 'art'), 'ancestor');
  assert.equal(packEntryRole(worldPack, 'art/other'), 'outside');
  assert.equal(packEntryRole(worldPack, 'sprites/pip/idle.png'), 'content');
});
