import { describe, expect, it } from 'vitest';

import { evaluateChangePolicy } from './change-policy.mjs';

describe('evaluateChangePolicy', () => {
  it('requires README and changelog for implementation changes', () => {
    expect(evaluateChangePolicy(['apps/cli/src/main.ts'])).toEqual([
      'Implementation changes require README.md in the same change set.',
      'Implementation changes require CHANGELOG.md in the same change set.',
    ]);
  });

  it('accepts implementation changes documented in the same change set', () => {
    expect(
      evaluateChangePolicy(['packages/core/src/entity.ts', 'README.md', 'CHANGELOG.md']),
    ).toEqual([]);
  });

  it('does not require product documentation for planning-only changes', () => {
    expect(evaluateChangePolicy(['docs/roadmap.md'])).toEqual([]);
  });

  it('requires documentation when the toolchain changes', () => {
    expect(evaluateChangePolicy(['vitest.config.ts'])).toEqual([
      'Implementation changes require README.md in the same change set.',
      'Implementation changes require CHANGELOG.md in the same change set.',
    ]);
  });
});
