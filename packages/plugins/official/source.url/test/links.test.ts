import { describe, expect, it } from 'vitest';

import { discoverHtmlLinks } from '../src/links.js';

const encoder = new TextEncoder();

describe('discoverHtmlLinks', () => {
  it('discovers only safe HTTP anchor targets without honoring base elements', () => {
    const result = discoverHtmlLinks({
      bytes: encoder.encode(`
        <base href="https://ignored.test/">
        <a href="/b#fragment">B</a>
        <a href="/a">A</a>
        <a href="/b">B again</a>
        <a href="#section">This page</a>
        <a href="">This page again</a>
        <a href="https://other.test/outside">Outside</a>
        <a href="http://example.test/insecure">Other scheme</a>
        <a href="/query?">Empty query</a>
        <a href="/query-value?token=private#fragment">Query</a>
        <a href="mailto:private@example.test">Mail</a>
        <a href="javascript:alert('private')">Script</a>
        <a href="https://user:secret@example.test/private">Credentials</a>
        <a href="http://[::1">Malformed</a>
        <img src="/image">
        <form action="/form"></form>
        <iframe src="/frame"></iframe>
        <meta http-equiv="refresh" content="0; url=/refresh">
      `),
      effectiveUri: 'https://example.test/root/page',
      knownUris: new Set(),
      maximumNewCandidates: 1_000,
    });

    expect(result).toEqual({
      links: [
        { uri: 'http://example.test/insecure', hasQuery: false },
        { uri: 'https://example.test/a', hasQuery: false },
        { uri: 'https://example.test/b', hasQuery: false },
        { uri: 'https://example.test/query-value?token=private', hasQuery: true },
        { uri: 'https://example.test/query?', hasQuery: true },
        { uri: 'https://example.test/root/page', hasQuery: false },
        { uri: 'https://other.test/outside', hasQuery: false },
      ],
      malformedHrefCount: 2,
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain('user:secret');
    expect(JSON.stringify(result)).not.toContain("alert('private')");
  });

  it('reports invalid UTF-8 without attempting HTML recovery', () => {
    expect(
      discoverHtmlLinks({
        bytes: new Uint8Array([0xc3, 0x28]),
        effectiveUri: 'https://example.test/',
        knownUris: new Set(),
        maximumNewCandidates: 1_000,
      }),
    ).toEqual({
      links: [],
      malformedHrefCount: 0,
      truncated: false,
      warning: 'URL_CONTENT_UTF8_INVALID',
    });
  });

  it('retains the first 1,000 normalized candidates in document order before sorting', () => {
    const retained = Array.from(
      { length: 1_000 },
      (_, index) => `<a href="/z-${String(index).padStart(4, '0')}">Link</a>`,
    );
    const html = `${retained.join('')}<a href="/a-omitted">Omitted</a>`;

    const result = discoverHtmlLinks({
      bytes: encoder.encode(html),
      effectiveUri: 'https://example.test/',
      knownUris: new Set(),
      maximumNewCandidates: 1_000,
    });

    expect(result.links).toHaveLength(1_000);
    expect(result.links[0]).toEqual({
      uri: 'https://example.test/z-0000',
      hasQuery: false,
    });
    expect(result.links.at(-1)).toEqual({
      uri: 'https://example.test/z-0999',
      hasQuery: false,
    });
    expect(result.links).not.toContainEqual({
      uri: 'https://example.test/a-omitted',
      hasQuery: false,
    });
    expect(result.malformedHrefCount).toBe(0);
    expect(result.truncated).toBe(true);
  });

  it('does not charge globally known URIs against the bounded new-candidate capacity', () => {
    const knownUris = new Set(['https://example.test/known-a', 'https://example.test/known-b']);

    const result = discoverHtmlLinks({
      bytes: encoder.encode(`
        <a href="/known-a">Known A</a>
        <a href="/known-b">Known B</a>
        <a href="/new">New</a>
        <a href="/omitted">Omitted</a>
      `),
      effectiveUri: 'https://example.test/',
      maximumNewCandidates: 1,
      knownUris,
    });

    expect(result.links).toEqual([
      { uri: 'https://example.test/known-a', hasQuery: false },
      { uri: 'https://example.test/known-b', hasQuery: false },
      { uri: 'https://example.test/new', hasQuery: false },
    ]);
    expect(result.truncated).toBe(true);
    expect(result.links).toHaveLength(knownUris.size + 1);
  });

  it('sorts candidates by JavaScript code-unit order', () => {
    const result = discoverHtmlLinks({
      bytes: encoder.encode(`
        <a href="/z">z</a>
        <a href="/ä">umlaut</a>
        <a href="/A">upper</a>
        <a href="/a">lower</a>
      `),
      effectiveUri: 'https://example.test/',
      knownUris: new Set(),
      maximumNewCandidates: 1_000,
    });

    expect(result.links.map((link) => link.uri)).toEqual([
      'https://example.test/%C3%A4',
      'https://example.test/A',
      'https://example.test/a',
      'https://example.test/z',
    ]);
  });
});
