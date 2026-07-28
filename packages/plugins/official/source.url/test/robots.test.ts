import { describe, expect, it } from 'vitest';

import { parseRobotsPolicy, type RobotsParseResult } from '../src/robots.js';

const encoder = new TextEncoder();

function rulesFor(value: string): Extract<RobotsParseResult, { status: 'rules' }> {
  const policy = parseRobotsPolicy(encoder.encode(value), 'SheldonBot');
  expect(policy.status).toBe('rules');
  if (policy.status !== 'rules') throw new Error(`expected rules, received ${policy.status}`);
  return policy;
}

describe('parseRobotsPolicy', () => {
  it('prefers and merges exact case-insensitive product groups over wildcard groups', () => {
    const policy = rulesFor(`
      User-agent: *
      Disallow: /
      Crawl-delay: 30

      uSeR-aGeNt: sheldonbot
      dIsAlLoW: /private
      Allow: /private/public

      USER-AGENT: SHELDONBOT
      Disallow: /merged
    `);

    expect(policy.allows('/about')).toBe(true);
    expect(policy.allows('/private/file')).toBe(false);
    expect(policy.allows('/private/public/file')).toBe(true);
    expect(policy.allows('/merged')).toBe(false);
  });

  it('uses longest match, Allow ties, wildcards, a terminal anchor, and encoded pathnames', () => {
    const policy = rulesFor(`
      User-agent: SheldonBot
      Disallow: /private/*
      Allow: /private/public$
      Disallow: /same
      Allow: /same
      Disallow: /caf%C3%A9
      Disallow:
    `);

    expect(policy.allows('/private/a')).toBe(false);
    expect(policy.allows('/private/public')).toBe(true);
    expect(policy.allows('/private/public/child')).toBe(false);
    expect(policy.allows('/same')).toBe(true);
    expect(policy.allows('/caf%C3%A9')).toBe(false);
    expect(policy.allows('/café')).toBe(true);
    expect(policy.allows('/about')).toBe(true);
  });

  it('supports comments and blank lines while ignoring sitemap and unknown fields', () => {
    const policy = rulesFor(`
      # leading comment
      User-agent: SheldonBot # selected crawler

      Sitemap: https://example.test/sitemap.xml
      X-Unknown: private
      Disallow: /blocked # trailing comment
    `);

    expect(policy.allows('/blocked')).toBe(false);
    expect(policy.allows('/open')).toBe(true);
  });

  it('falls back to merged wildcard groups when no exact product group exists', () => {
    const policy = rulesFor(`
      User-agent: OtherBot
      Disallow: /

      User-agent: *
      Disallow: /one

      User-agent: *
      Disallow: /two
    `);

    expect(policy.allows('/one')).toBe(false);
    expect(policy.allows('/two')).toBe(false);
    expect(policy.allows('/other')).toBe(true);
  });

  it('returns unreadable for invalid UTF-8', () => {
    expect(parseRobotsPolicy(new Uint8Array([0xc3, 0x28]), 'SheldonBot')).toEqual({
      status: 'unreadable',
      warning: 'ROBOTS_UTF8_INVALID',
    });
  });

  it.each([
    [
      'malformed applicable user-agent',
      `
        User-agent: SheldonBot
        User-agent:
        Disallow: /private
      `,
    ],
    [
      'applicable user-agent without a colon',
      `
        User-agent SheldonBot
        Disallow: /private
      `,
    ],
    [
      'malformed applicable access rule',
      `
        User-agent: SheldonBot
        Disallow
      `,
    ],
    [
      'applicable access rule without a colon',
      `
        User-agent: SheldonBot
        Disallow /private
      `,
    ],
    [
      'empty applicable Allow',
      `
        User-agent: SheldonBot
        Allow:
      `,
    ],
    [
      'applicable crawl delay',
      `
        User-agent: SheldonBot
        Crawl-delay: 1
      `,
    ],
  ])('returns ambiguous for %s', (_description, value) => {
    expect(parseRobotsPolicy(encoder.encode(value), 'SheldonBot')).toEqual({
      status: 'ambiguous',
      warning: 'ROBOTS_POLICY_AMBIGUOUS',
    });
  });

  it('ignores malformed rules and crawl delay in unselected groups', () => {
    const policy = rulesFor(`
      User-agent: *
      Disallow
      Crawl-delay: 30

      User-agent: SheldonBot
      Disallow: /selected
    `);

    expect(policy.allows('/selected')).toBe(false);
    expect(policy.allows('/other')).toBe(true);
  });
});
