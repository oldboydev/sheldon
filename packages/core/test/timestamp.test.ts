import { describe, expect, it } from 'vitest';

import { isoTimestampEpoch } from '../src/timestamp.js';

describe('isoTimestampEpoch', () => {
  it('returns the instant for full ISO-8601 timestamps with a timezone', () => {
    expect(isoTimestampEpoch('2026-07-28T10:30:15.120Z')).toBe(
      Date.parse('2026-07-28T10:30:15.120Z'),
    );
    expect(isoTimestampEpoch('2026-07-28T10:30:15-03:00')).toBe(
      Date.parse('2026-07-28T10:30:15-03:00'),
    );
  });

  it.each([
    '2026-07-28T10:30:15',
    '2026-02-31T10:30:15Z',
    '2026-07-28T24:00:00Z',
    '2026-07-28T10:30:15+24:00',
    '2026-07-28T10:30:15+03:60',
    '2026-7-28T10:30:15Z',
  ])('rejects malformed or noncanonical timestamps: %s', (value) => {
    expect(isoTimestampEpoch(value)).toBeUndefined();
  });
});
