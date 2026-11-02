# familiar-theme

The theme contract package: the shared protocol that `familiar` (engine) and
`familiar-forge` (private) both depend on. Ships no art of its own.

- Run tests: `npm test`
- Pre-split history: https://github.com/khughitt/familiar-archive (private archive)

## Descriptor (spec-version 2)

`theme.yaml` starts with `spec-version: 2`; a pack at any other version is
refused. Package version 0.4.0 is the first to speak it.

- Each member declares `roles:`, a list of role ids (possibly empty). A role is
  held by at most one member. Exactly one member holds the reserved role
  `default` (`DEFAULT_ROLE`), the member for an agent with no role or a role the
  pack does not cover. No other role id has meaning in the contract.
  `memberForRole(pack, role)` returns the holder or `null`;
  `defaultMember(pack)` returns the `default` holder; `pack.byRole` maps role to
  member id.
- Slots are not part of the contract; nothing in a pack mentions one.
- `world:` is optional. When present it names an `asset-root` (which may not be,
  contain or lie inside any member's), one `size`, and `locales`: `home`
  (required) plus any of `captured`, `scoped`, `designed`, `planned`,
  `implementing`, `verified`, `closed` (`LOCALES`), each an `image` (a `.png`
  under the world's asset-root, of exactly `size`) and its `places`, the floor
  positions in image pixels, in fill order.
- A pack holds at most `LIMITS.MAX_MEMBERS` (64) members. The pack-wide limits
  (entry count, total encoded bytes, total decoded bytes) are derived from it.

The public surface is `src/index.js` alone; it exports the parser and loaders,
`memberForRole`, `defaultMember`, `LOCALES`, `DEFAULT_ROLE`, `localeAssetFor`,
`packEntryRole`, `LIMITS` and `validateThemePack`.

## Pack content

A pack is its descriptor and what the descriptor names, not the directory
that holds it. `packEntryRole(pack, relPath)` gives every path one role:

- `content`: `theme.yaml`; any path whose first segment starts,
  case-insensitively, with `licen`, `copying` or `notice` (licence files and
  licence directories, with everything beneath them); each member's
  `asset-root` and everything beneath it; and, when the descriptor declares a
  `world:`, the world's `asset-root` and everything beneath it (the locale
  images).
- `ancestor`: a proper prefix of some member's or the world's `asset-root`
  (`sprites`). It must be a real directory.
- `outside`: everything else. The gate never examines it, and installers
  never copy it.

The gate reads the descriptor once and validates content only, so a working
checkout with tool workspaces, symlinks or build output beside the pack
validates as it stands. Installers copy exactly the content.
