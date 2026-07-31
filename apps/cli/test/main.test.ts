import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { runCli, type CliDependencies } from '../src/main.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it('advertises vault and plugin options for URL ingestion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-url-help-'));
  temporaryDirectories.push(root);
  const dependencies: CliDependencies = {
    environment: { APPDATA: join(root, 'appdata') },
    homeDirectory: root,
  };

  const result = await runCli(['ingest', 'url', '--help'], dependencies);

  expect(result).toMatchObject({ exitCode: 0, stderr: '' });
  expect(result.stdout).toContain('sheldon ingest url [options] <kind> <slug> <url>');
  expect(result.stdout).toContain('--vault <path>');
  expect(result.stdout).toContain('--plugin <id>');
  expect(result.stdout).not.toContain('--max-pages');
  expect(result.stdout).not.toContain('--max-depth');
});

it.each(['full', 'video', ''])(
  'rejects an unsupported --media mode at the command boundary: %j',
  async (value) => {
    const dependencies = await cliDependencies('sheldon-media-mode-');

    const result = await runCli(
      ['ingest', 'url', 'topic', 'example', 'https://example.test/article', `--media=${value}`],
      dependencies,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--media must be none or thumbnail.');
    await expectPluginMarkersAbsent(dependencies);
  },
);

it('advertises required bounded crawl options separately from URL ingestion', async () => {
  const dependencies = await cliDependencies('sheldon-crawl-help-');

  const result = await runCli(['ingest', 'crawl', '--help'], dependencies);

  expect(result).toMatchObject({ exitCode: 0, stderr: '' });
  expect(result.stdout).toContain('sheldon ingest crawl [options] <kind> <slug> <seed-url>');
  expect(result.stdout).toContain('--max-pages <count>');
  expect(result.stdout).toContain('--max-depth <depth>');
  expect(result.stdout).toContain('--vault <path>');
  expect(result.stdout).toContain('--plugin <id>');
  expect(result.stdout).not.toContain('--language');
});

it.each([
  {
    name: '--max-pages',
    arguments: ['--max-depth', '1'],
    message: "required option '--max-pages <count>' not specified",
  },
  {
    name: '--max-depth',
    arguments: ['--max-pages', '1'],
    message: "required option '--max-depth <depth>' not specified",
  },
])(
  'requires the crawl option $name before plugin discovery',
  async ({ arguments: optionArguments, message }) => {
    const dependencies = await cliDependencies('sheldon-crawl-required-');

    const result = await runCli(
      ['ingest', 'crawl', 'topic', 'example', 'https://example.test', ...optionArguments],
      dependencies,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
    await expectPluginMarkersAbsent(dependencies);
  },
);

it.each([['-1'], ['+1'], ['1.0'], ['1e0'], [' 1 '], ['NaN'], ['0'], ['11']])(
  'rejects non-strict or out-of-range --max-pages value %j',
  async (value) => {
    const dependencies = await cliDependencies('sheldon-crawl-pages-');

    const result = await runCli(
      [
        'ingest',
        'crawl',
        'topic',
        'example',
        'https://example.test',
        `--max-pages=${value}`,
        '--max-depth',
        '1',
      ],
      dependencies,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--max-pages must be an integer from 1 to 10.');
    await expectPluginMarkersAbsent(dependencies);
  },
);

it.each([['-1'], ['+1'], ['1.0'], ['1e0'], [' 1 '], ['NaN'], ['3']])(
  'rejects non-strict or out-of-range --max-depth value %j',
  async (value) => {
    const dependencies = await cliDependencies('sheldon-crawl-depth-');

    const result = await runCli(
      [
        'ingest',
        'crawl',
        'topic',
        'example',
        'https://example.test',
        '--max-pages',
        '1',
        `--max-depth=${value}`,
      ],
      dependencies,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--max-depth must be an integer from 0 to 2.');
    await expectPluginMarkersAbsent(dependencies);
  },
);

it.each([['999'], ['200001'], ['1.0'], ['NaN']])(
  'rejects an out-of-range --max-context-chars value %j before command execution',
  async (value) => {
    const dependencies = await cliDependencies('sheldon-query-context-budget-');

    const result = await runCli(
      [
        'query',
        'topic',
        'memory',
        'answer-001',
        '--question',
        'retrieval',
        '--agent',
        'codex',
        `--max-context-chars=${value}`,
      ],
      dependencies,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--max-context-chars must be an integer from 1000 to 200000.');
    await expectPluginMarkersAbsent(dependencies);
  },
);

async function cliDependencies(prefix: string): Promise<CliDependencies> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return {
    environment: { APPDATA: join(root, 'appdata') },
    homeDirectory: root,
  };
}

async function expectPluginMarkersAbsent(dependencies: CliDependencies): Promise<void> {
  const appData = dependencies.environment?.APPDATA;
  expect(appData).toBeDefined();
  await expect(readFile(join(appData!, 'plugin-discovery-started'))).rejects.toThrow();
  await expect(readFile(join(appData!, 'plugin-launch-started'))).rejects.toThrow();
}
