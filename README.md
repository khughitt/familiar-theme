# familiar-theme

The theme contract package: the shared protocol that `familiar` (engine) and
`familiar-forge` (private) both depend on. Ships no art of its own.

- Run tests: `npm test`
- Pre-split history: https://github.com/khughitt/familiar-archive (private archive)

## Pack content

A pack is its descriptor and what the descriptor names, not the directory
that holds it. `packEntryRole(pack, relPath)` gives every path one role:

- `content`: `theme.yaml`; any path whose first segment starts,
  case-insensitively, with `licen`, `copying` or `notice` (licence files and
  licence directories, with everything beneath them); each member's
  `asset-root` and everything beneath it.
- `ancestor`: a proper prefix of some member's `asset-root` (`sprites`). It
  must be a real directory.
- `outside`: everything else. The gate never examines it, and installers
  never copy it.

The gate reads the descriptor once and validates content only, so a working
checkout with tool workspaces, symlinks or build output beside the pack
validates as it stands. Installers copy exactly the content.
