import { realpath, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import {
  AgentRuntime,
  AGENT_PROMPT_VERSION,
  createClaudeCommandAdapter,
  createCodexCommandAdapter,
  JsonCommandExecutor,
  ProposalStore,
  type AgentKind,
  type CommandExecutor,
} from '@sheldon/agent-runtime';
import type { EntityKind } from '@sheldon/core';
import { ingestLocalFile } from '@sheldon/ingestion';
import { ReviewService } from '@sheldon/review';
import { entityDirectory, VaultService } from '@sheldon/vault';

import { resolveVaultPath } from '../config.js';
import type { CommandContext } from '../runtime.js';
import type { VaultOption } from './entities.js';

export interface MemoryCommandDependencies {
  readonly agentExecutor?: CommandExecutor;
}

export async function ingestFile(
  kind: EntityKind,
  slug: string,
  file: string,
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const result = await ingestLocalFile({ filePath: file, rawDirectory: join(entity, 'raw') });
  context.write(JSON.stringify(result, null, 2));
}

export async function compileMemory(
  kind: EntityKind,
  slug: string,
  proposalId: string,
  options: VaultOption & {
    readonly agent: AgentKind;
    readonly prompt: string;
    readonly raw: readonly string[];
  },
  context: CommandContext,
  dependencies: MemoryCommandDependencies = {},
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  await Promise.all(options.raw.map((source) => assertRawSource(entity, source)));
  const executor =
    dependencies.agentExecutor ?? new JsonCommandExecutor({ environment: context.environment });
  const adapter =
    options.agent === 'codex'
      ? createCodexCommandAdapter(executor)
      : createClaudeCommandAdapter(executor);
  const result = await new AgentRuntime(new ProposalStore(entity)).run(adapter, {
    proposalId,
    prompt: options.prompt,
    promptVersion: AGENT_PROMPT_VERSION,
    rawSources: options.raw,
    workingDirectory: entity,
  });
  context.write(JSON.stringify(result, null, 2));
}

export async function previewProposal(
  kind: EntityKind,
  slug: string,
  proposalId: string,
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const proposal = new ProposalStore(entity).assertPromotable(
    await new ProposalStore(entity).load(proposalId),
  );
  const preview = await new ReviewService(entity).preview(toReviewProposal(proposal));
  context.write(JSON.stringify({ proposalId, files: preview }, null, 2));
}

export async function approveProposal(
  kind: EntityKind,
  slug: string,
  proposalId: string,
  paths: readonly string[],
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const store = new ProposalStore(entity);
  const proposal = store.assertPromotable(await store.load(proposalId));
  const result = await new ReviewService(entity).approve(toReviewProposal(proposal), paths);
  context.write(JSON.stringify(result, null, 2));
}

export async function lintWiki(
  kind: EntityKind,
  slug: string,
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  context.write(JSON.stringify(await new ReviewService(entity).lint(), null, 2));
}

async function resolveEntity(
  kind: EntityKind,
  slug: string,
  explicitVault: string | undefined,
  context: CommandContext,
): Promise<string> {
  const root = await resolveVaultPath(context, explicitVault);
  const vault = await VaultService.discover(root);
  await vault.inspectEntity(kind, slug);
  return entityDirectory(root, kind, slug);
}

async function assertRawSource(entity: string, source: string): Promise<void> {
  const target = await realpath(resolve(entity, source));
  const root = `${await realpath(resolve(entity, 'raw'))}${sep}`;
  if (!target.startsWith(root)) throw new Error('Raw source must be a regular file below raw/.');
  if (!(await stat(target)).isFile())
    throw new Error('Raw source must be a regular file below raw/.');
}

function toReviewProposal(proposal: {
  readonly id: string;
  readonly sources: readonly { readonly rawPath: string; readonly citation: string }[];
  readonly claims?: readonly string[];
  readonly contradictions?: readonly string[];
  readonly confidence?: 'low' | 'medium' | 'high';
  readonly files: readonly {
    readonly path: string;
    readonly operation: 'create' | 'modify' | 'delete';
    readonly content?: string;
    readonly citations: readonly string[];
  }[];
}) {
  return {
    id: proposal.id,
    sources: proposal.sources,
    ...(proposal.claims === undefined ? {} : { claims: proposal.claims }),
    ...(proposal.contradictions === undefined ? {} : { contradictions: proposal.contradictions }),
    ...(proposal.confidence === undefined ? {} : { confidence: proposal.confidence }),
    files: proposal.files.map((file) => ({
      path: file.path,
      operation: file.operation,
      content: file.content,
      sources: file.citations,
    })),
  };
}
