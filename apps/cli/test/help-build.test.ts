import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCliHelp } from '../../../scripts/build-cli-help.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('buildCliHelp', () => {
  it('renders markdown pages listed in the manifest to html', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-help-'));
    roots.push(root);
    const sourceDir = join(root, 'help');
    const outputDir = join(root, 'out');
    await mkdir(join(sourceDir, 'pages'), { recursive: true });
    await writeFile(
      join(sourceDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        pages: [{ id: 'index', title: 'Sheldon help', file: 'pages/index.md', commands: [] }],
      }),
      'utf8',
    );
    await writeFile(
      join(sourceDir, 'pages', 'index.md'),
      '# Sheldon help\n\nHello `init`.\n\n1. First\n2. Second\n',
      'utf8',
    );
    await writeFile(join(sourceDir, 'styles.css'), 'body{font-family:sans-serif}', 'utf8');

    await buildCliHelp({ sourceDir, outputDir });

    const html = await readFile(join(outputDir, 'index.html'), 'utf8');
    expect(html).toContain('<h1>Sheldon help</h1>');
    expect(html).toContain('<code>init</code>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>First</li>');
    expect(html).toContain('<li>Second</li>');
    expect(html).toContain('styles.css');
    await expect(readFile(join(outputDir, 'styles.css'), 'utf8')).resolves.toContain('sans-serif');
  });

  it('wraps pages in titlebar and sidebar nav and copies the local font', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-help-'));
    roots.push(root);
    const sourceDir = join(root, 'help');
    const outputDir = join(root, 'out');
    await mkdir(join(sourceDir, 'pages'), { recursive: true });
    await mkdir(join(sourceDir, 'fonts'), { recursive: true });
    await writeFile(
      join(sourceDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        pages: [
          { id: 'index', title: 'Sheldon help', file: 'pages/index.md', commands: [] },
          { id: 'init', title: 'init', file: 'pages/init.md', commands: ['init'] },
          {
            id: 'flow-first-vault',
            title: 'First vault',
            file: 'pages/flow-first-vault.md',
            commands: ['init'],
          },
        ],
      }),
      'utf8',
    );
    await writeFile(join(sourceDir, 'pages', 'index.md'), '# Sheldon help\n', 'utf8');
    await writeFile(join(sourceDir, 'pages', 'init.md'), '# init\n', 'utf8');
    await writeFile(join(sourceDir, 'pages', 'flow-first-vault.md'), '# First vault\n', 'utf8');
    await writeFile(
      join(sourceDir, 'styles.css'),
      ':root{--brand-navy:#001663;--brand-magenta:#e74092}body{font-family:"Nunito Sans",sans-serif}',
      'utf8',
    );
    await writeFile(
      join(sourceDir, 'fonts', 'NunitoSans-VariableFont_YTLC_opsz_wdth_wght.ttf'),
      'font',
      'utf8',
    );

    await buildCliHelp({ sourceDir, outputDir });

    const index = await readFile(join(outputDir, 'index.html'), 'utf8');
    expect(index).toContain('class="titlebar"');
    expect(index).toContain('class="sidebar"');
    expect(index).toContain('href="pages/init.html"');
    expect(index).toContain('href="pages/flow-first-vault.html"');
    expect(index).toContain('aria-current="page"');

    const init = await readFile(join(outputDir, 'pages', 'init.html'), 'utf8');
    expect(init).toContain('href="../index.html"');
    expect(init).toContain('href="init.html"');
    expect(init).toMatch(/navitem is-active[\s\S]*init/);

    const css = await readFile(join(outputDir, 'styles.css'), 'utf8');
    expect(css).toContain('--brand-navy');
    expect(css).toContain('--brand-magenta');
    await expect(
      readFile(join(outputDir, 'fonts', 'NunitoSans-VariableFont_YTLC_opsz_wdth_wght.ttf'), 'utf8'),
    ).resolves.toBe('font');
  });
});
