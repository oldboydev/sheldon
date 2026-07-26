import { createRequire } from 'node:module';

interface DominoModule {
  createDocument(html?: string, force?: boolean): Document;
}

const domino = loadDomino();

export interface DiscoveredLink {
  readonly uri: string;
  readonly hasQuery: boolean;
}

export interface LinkDiscovery {
  readonly links: readonly DiscoveredLink[];
  readonly malformedHrefCount: number;
  readonly truncated: boolean;
  readonly warning?: 'URL_CONTENT_UTF8_INVALID';
}

export interface LinkDiscoveryInput {
  readonly bytes: Uint8Array;
  readonly effectiveUri: string;
  readonly knownUris: ReadonlySet<string>;
  readonly maximumNewCandidates: number;
}

export function discoverHtmlLinks(input: LinkDiscoveryInput): LinkDiscovery {
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    return {
      links: [],
      malformedHrefCount: 0,
      truncated: false,
      warning: 'URL_CONTENT_UTF8_INVALID',
    };
  }

  const effectiveUrl = new URL(input.effectiveUri);
  const document = domino.createDocument(html);
  const discovered = new Map<string, DiscoveredLink>();
  let newCandidateCount = 0;
  let malformedHrefCount = 0;
  let truncated = false;

  for (const anchor of document.querySelectorAll('a[href]')) {
    const rawHref = anchor.getAttribute('href');
    if (rawHref === null) continue;

    let target: URL;
    try {
      target = new URL(rawHref, effectiveUrl);
    } catch {
      malformedHrefCount += 1;
      continue;
    }

    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;
    if (target.username !== '' || target.password !== '') {
      malformedHrefCount += 1;
      continue;
    }

    const fragmentIndex = target.href.indexOf('#');
    const hrefWithoutFragment =
      fragmentIndex === -1 ? target.href : target.href.slice(0, fragmentIndex);
    const hasQuery = hrefWithoutFragment.includes('?');
    target.hash = '';
    const uri = target.href;
    if (discovered.has(uri)) continue;
    const isKnown = input.knownUris.has(uri);
    if (!isKnown && newCandidateCount === input.maximumNewCandidates) {
      truncated = true;
      break;
    }
    discovered.set(uri, { uri, hasQuery });
    if (!isKnown) newCandidateCount += 1;
  }

  return {
    links: [...discovered.values()].sort((left, right) =>
      left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0,
    ),
    malformedHrefCount,
    truncated,
  };
}

function isDominoModule(value: unknown): value is DominoModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'createDocument' in value &&
    typeof value.createDocument === 'function'
  );
}

function loadDomino(): DominoModule {
  const value: unknown = createRequire(import.meta.url)('@mixmark-io/domino');
  if (!isDominoModule(value)) throw new Error('URL_HTML_PARSER_UNAVAILABLE');
  return value;
}
