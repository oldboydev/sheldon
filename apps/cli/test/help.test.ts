import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openHelpPage, resolveHelpPage } from '../src/help.js';
import { runCli, type CliDependencies } from '../src/main.js';

import { testApplicationEnvironment } from './app-state.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTempHelpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-html-help-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'pages'), { recursive: true });
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      pages: [
        { id: 'index', title: 'Sheldon help', file: 'pages/index.md', commands: [] },
        { id: 'init', title: 'init', file: 'pages/init.md', commands: ['init'] },
      ],
    }),
    'utf8',
  );
  await writeFile(join(root, 'index.html'), '<html><body>index</body></html>', 'utf8');
  await writeFile(join(root, 'pages', 'init.html'), '<html><body>init</body></html>', 'utf8');
  return root;
}

function dependencies(helpRoot: string, overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    environment: testApplicationEnvironment(helpRoot),
    homeDirectory: helpRoot,
    confirm: async () => true,
    commandAvailable: async () => true,
    helpRoot,
    ...overrides,
  };
}

describe('html help', () => {
  it('resolves the index and a topic page under the help root', async () => {
    const root = await createTempHelpRoot();
    expect(resolveHelpPage(undefined, root)).toBe(join(root, 'index.html'));
    expect(resolveHelpPage('index', root)).toBe(join(root, 'index.html'));
    expect(resolveHelpPage('init', root)).toBe(join(root, 'pages', 'init.html'));
  });

  it('opens the html page through the injected opener', async () => {
    const root = await createTempHelpRoot();
    const page = join(root, 'index.html');
    const open = vi.fn(async () => undefined);
    await openHelpPage(page, open);
    expect(open).toHaveBeenCalledWith(page);
  });

  it('prints the help root for --path and opens html for --html', async () => {
    const helpRoot = await createTempHelpRoot();
    const open = vi.fn(async () => undefined);

    const pathResult = await runCli(['help', '--path'], dependencies(helpRoot));
    expect(pathResult.exitCode).toBe(0);
    expect(pathResult.stdout).toContain(helpRoot);

    const htmlResult = await runCli(
      ['help', '--html', 'init'],
      dependencies(helpRoot, { openHelp: open }),
    );
    expect(htmlResult.exitCode).toBe(0);
    expect(open).toHaveBeenCalledWith(join(helpRoot, 'pages', 'init.html'));
  });

  it('opens the index page when --html has no topic', async () => {
    const helpRoot = await createTempHelpRoot();
    const open = vi.fn(async () => undefined);

    const result = await runCli(['help', '--html'], dependencies(helpRoot, { openHelp: open }));
    expect(result.exitCode).toBe(0);
    expect(open).toHaveBeenCalledWith(join(helpRoot, 'index.html'));
  });

  it('prints the help root when --path is combined with --html', async () => {
    const helpRoot = await createTempHelpRoot();
    const open = vi.fn(async () => undefined);

    const result = await runCli(
      ['help', '--path', '--html'],
      dependencies(helpRoot, { openHelp: open }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(helpRoot);
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects html topics that are not manifest page ids', async () => {
    const helpRoot = await createTempHelpRoot();
    await writeFile(join(helpRoot, 'secret.html'), '<html><body>secret</body></html>', 'utf8');
    await writeFile(
      join(helpRoot, 'pages', 'extra.html'),
      '<html><body>extra</body></html>',
      'utf8',
    );
    const open = vi.fn(async () => undefined);
    const deps = dependencies(helpRoot, { openHelp: open });

    const missing = await runCli(['help', '--html', 'missing-topic'], deps);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('HELP_PAGE_MISSING');

    const extra = await runCli(['help', '--html', 'extra'], deps);
    expect(extra.exitCode).toBe(1);
    expect(extra.stderr).toContain('HELP_PAGE_MISSING');

    const traversal = await runCli(['help', '--html', '../secret'], deps);
    expect(traversal.exitCode).toBe(1);
    expect(traversal.stderr).toContain('HELP_PAGE_MISSING');
    expect(open).not.toHaveBeenCalled();

    const listed = await runCli(['help', '--html', 'init'], deps);
    expect(listed.exitCode).toBe(0);
    expect(open).toHaveBeenCalledWith(join(helpRoot, 'pages', 'init.html'));
  });

  it('fails with HELP_PAGE_MISSING for an unknown html topic', async () => {
    const helpRoot = await createTempHelpRoot();
    const open = vi.fn(async () => undefined);

    const result = await runCli(
      ['help', '--html', 'missing-topic'],
      dependencies(helpRoot, { openHelp: open }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('HELP_PAGE_MISSING');
    expect(result.stderr).toContain('sheldon help --path');
    expect(open).not.toHaveBeenCalled();
  });

  it('html help remains the packaged cli guide not vault wiki', async () => {
    const helpRoot = await createTempHelpRoot();
    await writeFile(
      join(helpRoot, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        pages: [
          { id: 'index', title: 'Sheldon help', file: 'pages/index.md', commands: [] },
          { id: 'init', title: 'init', file: 'pages/init.md', commands: ['init'] },
          { id: 'web', title: 'web', file: 'pages/web.md', commands: ['web'] },
        ],
      }),
      'utf8',
    );
    await writeFile(
      join(helpRoot, 'pages', 'web.html'),
      '<html><body>sheldon web [--vault]</body></html>',
      'utf8',
    );
    const open = vi.fn(async () => undefined);

    const result = await runCli(
      ['help', '--html', 'web'],
      dependencies(helpRoot, { openHelp: open }),
    );
    expect(result.exitCode).toBe(0);
    expect(open).toHaveBeenCalledWith(join(helpRoot, 'pages', 'web.html'));

    const source = await readFile(join('apps', 'cli', 'help', 'pages', 'web.md'), 'utf8');
    expect(source).toContain('sheldon web [--vault <path>] [--port <port>]');
    expect(source).not.toContain('wiki/recall.md');
  });

  it('web help describes abrir revisao as proposed wiki page plus compact diff', async () => {
    const source = await readFile(join('apps', 'cli', 'help', 'pages', 'web.md'), 'utf8');
    expect(source).toMatch(/Abrir revisão/i);
    expect(source.toLowerCase()).toContain('wiki');
    expect(source.toLowerCase()).toContain('diff');
  });

  it('keeps Commander text help for help and help init', async () => {
    const helpRoot = await createTempHelpRoot();
    const deps = dependencies(helpRoot);

    const rootHelp = await runCli(['help'], deps);
    expect(rootHelp).toMatchObject({ exitCode: 0, stderr: '' });
    expect(rootHelp.stdout).toContain('Build and use a local, reviewable knowledge vault.');
    expect(rootHelp.stdout).toContain('init [options] [path]');

    const initHelp = await runCli(['help', 'init'], deps);
    expect(initHelp).toMatchObject({ exitCode: 0, stderr: '' });
    expect(initHelp.stdout).toContain('Create a Sheldon vault and save it as the local default.');
    expect(initHelp.stdout).toContain('--yes');
  });
});
