// Pack content (familiar docs/specs/2026-10-14-pack-content-design.md §1). A
// pack is its descriptor and what the descriptor names, not the directory that
// holds it. Content is closed under descent: both content subtrees (licence
// directories and member asset trees) are defined by a prefix of the path, so a
// walker that asks at every depth never drops a descendant.
//
// The licence rule is the one convention here: an installed copy keeps the terms
// its assets were granted under, and every repository already names those files
// this way. It is deliberately broad; a false positive installs one more small
// file, which the gate still validates.
const LICENCE_NAME = /^(licen|copying|notice)/i;

export function packEntryRole(pack, relPath) {
  const segments = typeof relPath === 'string' && relPath !== '' && !relPath.startsWith('/')
    ? relPath.split('/') : null;
  if (segments === null || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`packEntryRole: expected a relative / path, got ${JSON.stringify(relPath)}`);
  }
  if (relPath === 'theme.yaml' || LICENCE_NAME.test(segments[0])) return 'content';
  let ancestor = false;
  for (const member of pack.members.values()) {
    const root = member.assetRoot.split('/');
    let shared = 0;
    while (shared < root.length && shared < segments.length
      && root[shared] === segments[shared]) shared += 1;
    if (shared === root.length) return 'content';
    if (shared === segments.length) ancestor = true;
  }
  return ancestor ? 'ancestor' : 'outside';
}
