export type LinkedInContentKind = 'post' | 'article';

export interface CanonicalLinkedInContentUrl {
  readonly kind: LinkedInContentKind;
  readonly canonicalUri: string;
}

const linkedInHosts = new Set(['linkedin.com', 'www.linkedin.com']);

export function canonicalLinkedInContentUrl(value: string): CanonicalLinkedInContentUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw inputError();
  }
  if (
    url.protocol !== 'https:' ||
    !linkedInHosts.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw inputError();
  }

  const pathname = normalizePathname(url.pathname);
  const kind = pathname.match(/^\/posts\/[^/]+\/$/u)
    ? 'post'
    : pathname.match(/^\/feed\/update\/urn:li:activity:\d+\/$/u)
      ? 'post'
      : pathname.match(/^\/pulse\/[^/]+\/$/u)
        ? 'article'
        : undefined;
  if (kind === undefined) throw inputError();
  return { kind, canonicalUri: `https://www.linkedin.com${pathname}` };
}

export function isKnownLinkedInUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && linkedInHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/{2,}/gu, '/');
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function inputError(): Error & { readonly code: 'LINKEDIN_INPUT_INVALID' } {
  return Object.assign(
    new Error('LINKEDIN_INPUT_INVALID: A public LinkedIn post or Article URL is required.'),
    {
      code: 'LINKEDIN_INPUT_INVALID' as const,
    },
  );
}
