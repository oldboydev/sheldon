import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandExecutor } from '@sheldon/agent-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliDependencies } from '../src/main.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function fakeExecutor(): CommandExecutor {
  return {
    execute: async (command) => {
      const source = command.input.rawSources[0]!;
      const title = command.executable === 'codex' ? 'Codex concept' : 'Claude concept';
      return {
        status: 'proposal',
        agentVersion: 'fixture/1',
        proposal: {
          schemaVersion: 1,
          id: command.input.proposalId,
          sources: [{ rawPath: source, citation: 'fixture source' }],
          files: [
            {
              path: `wiki/${command.input.proposalId}.md`,
              operation: 'create',
              citations: [source],
              content: `---\nid: ${command.input.proposalId}\ntype: note\ntitle: ${title}\ndescription: Fixture concept compiled from local evidence.\naliases: []\ntags:\n  - fixture\ncreated_at: 2026-07-20T00:00:00.000Z\nupdated_at: 2026-07-20T00:00:00.000Z\nstatus: active\nsources:\n  - ${source}\n---\n# ${title}\n\nEvidence: [raw](../${source})\n`,
            },
          ],
        },
      };
    },
  };
}

describe('M2 vertical flow', () => {
  it('ingests a local file, accepts both agent adapters, and promotes only an explicitly approved proposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-m2-'));
    temporaryDirectories.push(root);
    const vault = join(root, 'vault');
    const input = join(root, 'evidence.md');
    await writeFile(input, '# Evidence\nA durable fact.\n');
    const dependencies: CliDependencies = {
      environment: { APPDATA: join(root, 'appdata') },
      homeDirectory: root,
      confirm: async () => true,
      commandAvailable: async () => false,
      agentExecutor: fakeExecutor(),
    };

    await runCli(['init', vault], dependencies);
    await runCli(['topic', 'create', 'Memory', '--vault', vault], dependencies);
    const ingested = await runCli(
      ['ingest', 'file', 'topic', 'memory', input, '--vault', vault],
      dependencies,
    );
    expect(ingested.exitCode).toBe(0);
    const raw = JSON.parse(ingested.stdout) as {
      manifest: { content: { path: string } };
      sourceId: string;
    };
    const source = `raw/${raw.sourceId}/${raw.manifest.content.path}`;

    const codex = await runCli(
      [
        'compile',
        'topic',
        'memory',
        'codex-proposal',
        '--agent',
        'codex',
        '--prompt',
        'compile',
        '--raw',
        source,
        '--vault',
        vault,
      ],
      dependencies,
    );
    const claude = await runCli(
      [
        'compile',
        'topic',
        'memory',
        'claude-proposal',
        '--agent',
        'claude',
        '--prompt',
        'compile',
        '--raw',
        source,
        '--vault',
        vault,
      ],
      dependencies,
    );
    expect(codex.exitCode).toBe(0);
    expect(claude.exitCode).toBe(0);
    expect(JSON.parse(codex.stdout)).toMatchObject({
      metadata: { status: 'pending', agent: 'codex' },
    });
    expect(JSON.parse(claude.stdout)).toMatchObject({
      metadata: { status: 'pending', agent: 'claude' },
    });
    await expect(
      readFile(join(vault, 'topics', 'memory', 'wiki', 'codex-proposal.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const preview = await runCli(
      ['review', 'preview', 'topic', 'memory', 'codex-proposal', '--vault', vault],
      dependencies,
    );
    expect(JSON.parse(preview.stdout)).toMatchObject({
      files: { files: [{ path: 'wiki/codex-proposal.md', changed: true }] },
    });
    const approved = await runCli(
      [
        'review',
        'approve',
        'topic',
        'memory',
        'codex-proposal',
        'wiki/codex-proposal.md',
        '--vault',
        vault,
      ],
      dependencies,
    );
    expect(JSON.parse(approved.stdout)).toMatchObject({ approved: ['wiki/codex-proposal.md'] });
    await expect(
      readFile(join(vault, 'topics', 'memory', 'wiki', 'codex-proposal.md'), 'utf8'),
    ).resolves.toContain('Codex concept');
    await expect(
      readFile(join(vault, 'topics', 'memory', 'wiki', 'claude-proposal.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const rejected = await runCli(
      [
        'review',
        'reject',
        'topic',
        'memory',
        'claude-proposal',
        '--reason',
        'The evidence needs a narrower summary.',
        '--vault',
        vault,
      ],
      dependencies,
    );
    expect(rejected.exitCode).toBe(0);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      proposalId: 'claude-proposal',
      status: 'rejected',
      reason: 'The evidence needs a narrower summary.',
    });
    await expect(
      readFile(
        join(vault, 'topics', 'memory', 'outputs', 'proposals', 'claude-proposal', 'review.json'),
        'utf8',
      ),
    ).resolves.toContain('The evidence needs a narrower summary.');

    const blockedApproval = await runCli(
      [
        'review',
        'approve',
        'topic',
        'memory',
        'claude-proposal',
        'wiki/claude-proposal.md',
        '--vault',
        vault,
      ],
      dependencies,
    );
    expect(blockedApproval.exitCode).toBe(1);
    expect(blockedApproval.stderr).toContain('was rejected');

    const retried = await runCli(
      [
        'compile-retry',
        'topic',
        'memory',
        'claude-proposal-retry',
        '--from',
        'claude-proposal',
        '--agent',
        'claude',
        '--prompt',
        'narrow the summary',
        '--raw',
        source,
        '--vault',
        vault,
      ],
      dependencies,
    );
    expect(retried.exitCode).toBe(0);
    await expect(
      readFile(
        join(
          vault,
          'topics',
          'memory',
          'outputs',
          'proposals',
          'claude-proposal-retry',
          'attempt.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('claude-proposal');
  });
});
