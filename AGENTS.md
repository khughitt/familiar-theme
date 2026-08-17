# familiar-theme

- This is the contract package: it defines the theme protocol that the
  engine and forge repos consume as a git dependency. Treat its exported
  surface as the API — nothing outside `src/index.js`'s export is public.
- `npm test` runs the package's own suite (`node --test 'test/**/*.test.js'`).
- Pre-split history and design docs: https://github.com/khughitt/familiar-archive
