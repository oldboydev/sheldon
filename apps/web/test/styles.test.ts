import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const stylesPath = join(webRoot, 'src', 'styles.css');

describe('web design tokens', () => {
  it('defines product tokens and hosts Nunito Sans from cli help fonts', async () => {
    const css = await readFile(stylesPath, 'utf8');
    expect(css).toMatch(/--brand-navy:\s*#001663/);
    expect(css).toMatch(/--brand-magenta:\s*#e74092/);
    expect(css).toMatch(/font-family:\s*['"]Nunito Sans['"]/);
    expect(css).toContain('cli/help/fonts/NunitoSans-VariableFont_YTLC_opsz_wdth_wght.ttf');
    expect(css).not.toMatch(/Bahnschrift/i);
    expect(css).not.toContain('#e8e4da');
  });

  it('web chrome has no stix identity', async () => {
    const css = await readFile(stylesPath, 'utf8');
    expect(css.toLowerCase()).not.toContain('stix');
    expect(css).not.toContain('--gradient-brand');
    expect(css).not.toMatch(/\.eq\b/);
    const sources = ['src/App.tsx', 'src/KnowledgeView.tsx', 'src/ReviewView.tsx', 'src/main.tsx'];
    for (const relative of sources) {
      const text = await readFile(join(webRoot, relative), 'utf8');
      expect(text.toLowerCase(), relative).not.toContain('stix');
    }
  });

  it('mobile breakpoint keeps titlebar and scrolls nav horizontally', async () => {
    const css = await readFile(stylesPath, 'utf8');
    expect(css).toMatch(/@media \(max-width:\s*760px\)/);
    const mobile = css.split(/@media \(max-width:\s*760px\)/)[1] ?? '';
    expect(mobile).toMatch(/nav[\s\S]{0,400}overflow:\s*auto/);
    expect(mobile).not.toMatch(/\.titlebar\s*\{\s*display:\s*none/);
  });

  it('conhecimento tree column is 260px in a three-card layout', async () => {
    const css = await readFile(stylesPath, 'utf8');
    expect(css).toMatch(/\.wiki-layout\s*\{[^}]*grid-template-columns:\s*260px/s);
  });

  it('conhecimento article layout wraps paths and styles wiki lists', async () => {
    const css = await readFile(stylesPath, 'utf8');
    const pageMax = /max-width:\s*(\d+)px/u.exec(
      css.match(/\.page\.wiki-page\s*\{[^}]*\}/s)?.[0] ?? '',
    );
    expect(Number(pageMax?.[1])).toBeGreaterThan(1100);
    expect(css).toMatch(/\.wiki-body ul\b/);
    expect(css).toMatch(/\.wiki-paths[\s\S]*\.is-active/);
    expect(css).toMatch(/\.wiki-aside[\s\S]*overflow-wrap/);
    const asideProvenance = css.match(/\.wiki-aside[\s\S]*?\.provenance\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(asideProvenance).toMatch(/flex-wrap:\s*wrap|white-space:\s*normal/);
  });

  it('honors prefers-reduced-motion', async () => {
    const css = await readFile(stylesPath, 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/\[data-theme=['"]dark['"]\]/);
  });
});
