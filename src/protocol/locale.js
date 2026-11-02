export const LOCALES = Object.freeze(['home', 'captured', 'scoped', 'designed', 'planned', 'implementing', 'verified', 'closed']);

export function assertLocale(name) {
  if (!LOCALES.includes(name)) throw new Error(`unknown locale: ${name}`);
  return name;
}
