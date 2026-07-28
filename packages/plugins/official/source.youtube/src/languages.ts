const safeLanguageTag = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;

export function normalizeYoutubeLanguageTag(value: string): string | undefined {
  if (!safeLanguageTag.test(value) || value.toLowerCase() === 'all') return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    return canonical?.toLowerCase();
  } catch {
    return undefined;
  }
}
