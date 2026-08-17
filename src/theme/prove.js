import { isAbsolute, relative, sep } from 'node:path';

// The byte-free runtime proof (spec §4): a selected file must exist, be a
// regular non-symlink file, and realpath-resolve inside its proven directory.
// Metadata syscalls only — this runs on the per-prompt statusline path.
// Returns the lstat result on success so callers can reuse it; throws with
// `code` preserved so callers can distinguish ENOENT.
export function proveRegularFile(path, containDir, { lstat, realpath }, context) {
  const stat = lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${context}: ${path} is not a regular non-symlink file`);
  }
  const real = realpath(path);
  const from = relative(containDir, real);
  if (from === '' || from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from)) {
    throw new Error(`${context}: ${path} resolves outside ${containDir}`);
  }
  return stat;
}
