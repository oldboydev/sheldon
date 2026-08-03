import { createWindow } from '@mixmark-io/domino';
import TurndownService from 'turndown';

import type { LinkedInContentKind } from './linkedin-url.js';

export interface ExtractedLinkedInContent {
  readonly kind: LinkedInContentKind;
  readonly title: string;
  readonly text: string;
  readonly author?: string;
  readonly publishedAt?: string;
  readonly imageUrls: readonly string[];
  readonly sanitizedHtml: string;
}

const turndown = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
  strongDelimiter: '**',
});

export function extractLinkedInContent(
  html: string,
  kind: LinkedInContentKind,
  canonicalUri: string,
): ExtractedLinkedInContent {
  const window = createWindow(html, canonicalUri);
  const document = window.document;
  removeUnsafeElements(document);
  const title =
    meta(document, 'property', 'og:title') ??
    text(document.querySelector('h1')) ??
    'LinkedIn content';
  const author = meta(document, 'name', 'author');
  const publishedAt = meta(document, 'property', 'article:published_time');
  const body = kind === 'post' ? postBody(document) : articleBody(document);
  if (body === undefined) throw platformChanged();
  const imageUrls = publicImageUrls(body, canonicalUri);
  sanitizeUrls(document, canonicalUri);

  const normalizedText =
    kind === 'post'
      ? normalizeText(text(body))
      : normalizeMarkdown(turndown.turndown(body.innerHTML));
  if (!normalizedText) throw platformChanged();
  return {
    kind,
    title: normalizeText(title) || 'LinkedIn content',
    text: normalizedText,
    ...(author === undefined ? {} : { author: normalizeText(author) }),
    ...(publishedAt === undefined ? {} : { publishedAt: normalizeText(publishedAt) }),
    imageUrls,
    sanitizedHtml: `<!doctype html>\n${document.documentElement.outerHTML}\n`,
  };
}

function publicImageUrls(body: Element, canonicalUri: string): readonly string[] {
  const root = body.closest('article') ?? body.parentElement ?? body;
  const unique = new Set<string>();
  for (const image of Array.from(root.querySelectorAll('img[src]'))) {
    const value = image.getAttribute('src');
    if (value === null) continue;
    try {
      const url = new URL(value, canonicalUri);
      if (
        url.protocol === 'https:' &&
        (url.hostname.endsWith('.linkedin.com') || url.hostname.endsWith('.licdn.com')) &&
        url.search === ''
      ) {
        unique.add(url.href);
      }
    } catch {
      // An invalid image URL is not knowledge and is never persisted.
    }
  }
  return [...unique].slice(0, 5);
}

function postBody(document: Document): Element | undefined {
  return (
    document.querySelector('[data-test-id="main-feed-activity-card__commentary"]') ??
    document.querySelector('.feed-shared-update-v2__description') ??
    undefined
  );
}

function articleBody(document: Document): Element | undefined {
  const article = document.querySelector('article');
  if (article === null) return undefined;
  for (const unwanted of Array.from(
    article.querySelectorAll('aside, nav, footer, .comments, [data-test-id*="comment"]'),
  )) {
    unwanted.remove();
  }
  return article;
}

function removeUnsafeElements(document: Document): void {
  for (const element of Array.from(
    document.querySelectorAll('script, style, template, noscript, iframe'),
  )) {
    element.remove();
  }
}

function sanitizeUrls(document: Document, canonicalUri: string): void {
  for (const element of Array.from(document.querySelectorAll('[href], [src], meta[content]'))) {
    const attribute = element.hasAttribute('href')
      ? 'href'
      : element.hasAttribute('src')
        ? 'src'
        : 'content';
    const value = element.getAttribute(attribute);
    if (value === null || !looksLikeUrl(value)) continue;
    try {
      const url = new URL(value, canonicalUri);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        element.removeAttribute(attribute);
        continue;
      }
      url.search = '';
      url.hash = '';
      element.setAttribute(attribute, url.href);
    } catch {
      element.removeAttribute(attribute);
    }
  }
}

function looksLikeUrl(value: string): boolean {
  return /^(?:https?:)?\/\//iu.test(value) || value.startsWith('/');
}

function meta(document: Document, name: 'name' | 'property', value: string): string | undefined {
  const content = document.querySelector(`meta[${name}="${value}"]`)?.getAttribute('content');
  return content === null || content === undefined || normalizeText(content) === ''
    ? undefined
    : content;
}

function text(element: Element | null): string {
  return element?.textContent ?? '';
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/u, '')
    .replace(/\s+$/u, '');
}

function platformChanged(): Error & { readonly code: 'LINKEDIN_PLATFORM_CHANGED' } {
  return Object.assign(
    new Error(
      'LINKEDIN_PLATFORM_CHANGED: The public page no longer has a safely identifiable content region.',
    ),
    { code: 'LINKEDIN_PLATFORM_CHANGED' as const },
  );
}
