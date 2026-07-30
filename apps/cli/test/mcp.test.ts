import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SearchIndex } from '@sheldon/search';
import { VaultService } from '@sheldon/vault';
import {
  LocalFeedbackWriter,
  LocalRawAudit,
  LocalRawExcerptReader,
  LocalWikiConceptReader,
  preferredScopes,
} from '../src/commands/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/main.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('mcp consumer setup', () => {
  it('previews configuration before applying local Codex and Claude discovery files', async () => {
    const { vault, consumer } = await fixture();
    const args = [
      'mcp',
      'configure',
      consumer,
      '--vault',
      vault,
      '--consumer-id',
      'consumer-a',
      '--scope',
      'project:alpha',
      '--scope',
      'topic:shared',
    ];

    const preview = await runCli(args);
    expect(preview).toMatchObject({ exitCode: 0, stderr: '' });
    expect(preview.stdout).toContain('Preview only');
    await expect(access(join(consumer, '.sheldon', 'mcp.yaml'))).rejects.toThrow();

    const applied = await runCli([...args, '--apply']);
    expect(applied).toMatchObject({ exitCode: 0, stderr: '' });
    const config = await readFile(join(consumer, '.sheldon', 'mcp.yaml'), 'utf8');
    expect(config).toContain('transport: stdio');
    expect(config).toContain('slug: alpha');
    expect(config).toContain('slug: shared');
    expect(await readFile(join(consumer, '.codex', 'config.toml'), 'utf8')).toContain(
      'mcp_servers.sheldon',
    );
    expect(await readFile(join(consumer, '.mcp.json'), 'utf8')).toContain('"sheldon"');
  });

  it('installs byte-equivalent generated skill copies and doctors local scope/index state', async () => {
    const { vault, consumer } = await fixture();
    const configure = await runCli([
      'mcp',
      'configure',
      consumer,
      '--vault',
      vault,
      '--consumer-id',
      'consumer-a',
      '--scope',
      'project:alpha',
      '--apply',
    ]);
    expect(configure.exitCode).toBe(0);
    const skill = await runCli(['mcp', 'install-skill', consumer, '--apply']);
    expect(skill).toMatchObject({ exitCode: 0, stderr: '' });
    const codex = await readFile(join(consumer, '.codex', 'skills', 'sheldon', 'SKILL.md'), 'utf8');
    const claude = await readFile(
      join(consumer, '.claude', 'skills', 'sheldon', 'SKILL.md'),
      'utf8',
    );
    expect(codex).toBe(claude);
    expect(codex).not.toMatch(/\bkb\b/u);

    const index = await SearchIndex.rebuild(vault);
    index.close();
    const doctor = await runCli(['mcp', 'doctor', '--consumer', consumer]);
    expect(doctor).toMatchObject({ exitCode: 0, stderr: '' });
    expect(doctor.stdout).toContain('MCP transport: stdio (local only)');
    expect(doctor.stdout).toContain('MCP tools: list_scopes, search_knowledge, read_concept');
  });

  it('rejects an empty or malformed scope before writing configuration', async () => {
    const { vault, consumer } = await fixture();
    const result = await runCli([
      'mcp',
      'configure',
      consumer,
      '--vault',
      vault,
      '--consumer-id',
      'consumer-a',
      '--scope',
      'project:../other',
      '--apply',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('topic:<slug> or project:<slug>');
    await expect(access(join(consumer, '.sheldon', 'mcp.yaml'))).rejects.toThrow();
  });

  it('does not leave an MCP scope file behind when a client configuration would be overwritten', async () => {
    const { vault, consumer } = await fixture();
    await mkdir(join(consumer, '.codex'), { recursive: true });
    await writeFile(
      join(consumer, '.codex', 'config.toml'),
      '# existing user configuration\n',
      'utf8',
    );
    const result = await runCli([
      'mcp',
      'configure',
      consumer,
      '--vault',
      vault,
      '--consumer-id',
      'consumer-a',
      '--scope',
      'project:alpha',
      '--apply',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Refusing to overwrite existing client configuration');
    await expect(access(join(consumer, '.sheldon', 'mcp.yaml'))).rejects.toThrow();
  });

  it('restores an existing Claude configuration when a later setup write fails', async () => {
    const { vault, consumer } = await fixture();
    await mkdir(consumer, { recursive: true });
    const originalClaude = '{\n  "mcpServers": { "other": { "command": "other" } }\n}\n';
    await writeFile(join(consumer, '.mcp.json'), originalClaude, 'utf8');
    // A file where the Codex directory must be created bypasses the path pre-check
    // but makes the later atomic write fail.
    await writeFile(join(consumer, '.codex'), 'not a directory', 'utf8');

    const result = await runCli([
      'mcp',
      'configure',
      consumer,
      '--vault',
      vault,
      '--consumer-id',
      'consumer-a',
      '--scope',
      'project:alpha',
      '--apply',
    ]);

    expect(result.exitCode).toBe(1);
    expect(await readFile(join(consumer, '.mcp.json'), 'utf8')).toBe(originalClaude);
    await expect(access(join(consumer, '.sheldon', 'mcp.yaml'))).rejects.toThrow();
  });

  it('enforces bundle containment and narrowing, including a valid frozen selection', async () => {
    const { vault } = await fixture();
    const base = {
      version: 1 as const,
      consumer_project: { id: 'consumer-a' },
      vault,
      scopes: [
        { kind: 'project' as const, slug: 'alpha' },
        { kind: 'topic' as const, slug: 'shared' },
      ],
      transport: 'stdio' as const,
    };
    await mkdir(join(vault, 'bundles'), { recursive: true });
    await writeFile(
      join(vault, 'bundles', 'narrow.yaml'),
      'scopes:\n  - kind: project\n    slug: alpha\n',
    );
    await expect(preferredScopes({ ...base, bundle: 'narrow.yaml' })).resolves.toEqual([
      { kind: 'project', slug: 'alpha' },
    ]);
    await expect(preferredScopes({ ...base, bundle: '../escape.yaml' })).rejects.toThrow(
      'under vault/bundles',
    );
    await expect(preferredScopes({ ...base, bundle: 'missing.yaml' })).rejects.toThrow(
      'could not be read',
    );
    await writeFile(join(vault, 'bundles', 'invalid.yaml'), 'scopes: []\n');
    await expect(preferredScopes({ ...base, bundle: 'invalid.yaml' })).rejects.toThrow(
      'one or more scopes',
    );
    await writeFile(
      join(vault, 'bundles', 'widen.yaml'),
      'scopes:\n  - kind: project\n    slug: bravo\n',
    );
    await expect(preferredScopes({ ...base, bundle: 'widen.yaml' })).rejects.toThrow('widens');
  });

  it('uses local adapters without exposing wiki or raw mutations', async () => {
    const { vault } = await fixture();
    const entity = join(vault, 'projects', 'alpha');
    const wiki = join(entity, 'wiki', 'note.md');
    const raw = join(entity, 'raw', 'source', 'content.md');
    await mkdir(join(entity, 'wiki'), { recursive: true });
    await mkdir(join(entity, 'raw', 'source'), { recursive: true });
    await writeFile(wiki, '---\nid: note\n---\n# Note\n\nabcdefghijklmno', 'utf8');
    await writeFile(
      raw,
      Array.from({ length: 501 }, (_, index) => `line ${index + 1}`).join('\n'),
      'utf8',
    );
    const wikiBefore = await readFile(wiki, 'utf8');
    const rawBefore = await readFile(raw, 'utf8');
    const scope = { kind: 'project' as const, slug: 'alpha' };

    await expect(
      new LocalWikiConceptReader(vault).readConcept({ scope, path: 'wiki/note.md' }, 12),
    ).resolves.toEqual({
      body: expect.stringContaining('… [truncated]'),
      truncated: true,
    });
    await expect(
      new LocalRawExcerptReader(vault).readExcerpt({
        scope,
        conceptId: 'note',
        sourcePath: 'raw/source/content.md',
        startLine: 1,
        endLine: 500,
      }),
    ).resolves.toMatchObject({ startLine: 1, endLine: 500 });
    await expect(
      new LocalRawExcerptReader(vault).readExcerpt({
        scope,
        conceptId: 'note',
        sourcePath: 'raw/source/content.md',
        startLine: 1,
        endLine: 501,
      }),
    ).rejects.toThrow('exceeds 500');
    await expect(
      new LocalRawExcerptReader(vault).readExcerpt({
        scope,
        conceptId: 'note',
        sourcePath: 'raw/../wiki/note.md',
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toThrow('outside');

    await new LocalRawAudit(vault).append({
      scope,
      conceptId: 'note',
      sourcePath: 'raw/source/content.md',
      startLine: 1,
      endLine: 1,
      consumerProjectId: 'consumer-a',
      sessionId: 'session-a',
      requestedAt: '2026-07-29T00:00:00.000Z',
    });
    const audit = await readFile(join(vault, 'system', 'mcp-raw-audit.jsonl'), 'utf8');
    expect(audit).toContain('sourcePath');
    expect(audit).not.toContain('line 1');
    const feedback = await new LocalFeedbackWriter(vault).file({
      consumerProjectId: 'consumer-a',
      sessionId: 'session-a',
      scope,
      kind: 'gap',
      message: 'Needs review.',
      createdAt: '2026-07-29T00:00:00.000Z',
    });
    await expect(
      access(join(entity, 'outputs', 'feedback', `${feedback.id}.json`)),
    ).resolves.toBeUndefined();
    expect(await readFile(wiki, 'utf8')).toBe(wikiBefore);
    expect(await readFile(raw, 'utf8')).toBe(rawBefore);
  });
});

async function fixture(): Promise<{ readonly vault: string; readonly consumer: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-mcp-cli-'));
  temporaryDirectories.push(root);
  const vault = join(root, 'vault');
  const consumer = join(root, 'consumer');
  const service = await VaultService.init(vault);
  await service.createEntity({ kind: 'project', title: 'Alpha' });
  return { vault, consumer };
}
