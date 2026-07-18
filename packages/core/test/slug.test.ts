import { describe, expect, it } from 'vitest';

import { slugify } from '../src/slug.js';

describe('slugify', () => {
  it('normalizes spaces and accents', () => {
    expect(slugify('Arquitetura de Agentes: São Paulo')).toBe('arquitetura-de-agentes-sao-paulo');
  });

  it('rejects a title with no slug-safe characters', () => {
    expect(() => slugify('  !!!  ')).toThrow('cannot produce a slug');
  });
});
