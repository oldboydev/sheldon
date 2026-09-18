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
    await writeFile(join(sourceDir, 'pages', 'index.md'), '# Sheldon help\n\nHello `init`.\n', 'utf8');
    await writeFile(join(sourceDir, 'styles.css'), 'body{font-family:sans-serif}', 'utf8');

    await buildCliHelp({ sourceDir, outputDir });

    const html = await readFile(join(outputDir, 'index.html'), 'utf8');
    expect(html).toContain('<h1>Sheldon help</h1>');
    expect(html).toContain('<code>init</code>');
    expect(html).toContain('styles.css');
    await expect(readFile(join(outputDir, 'styles.css'), 'utf8')).resolves.toContain('sans-serif');
  });
});
