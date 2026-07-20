import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ProposalStore } from '@sheldon/agent-runtime';
import type { EntityKind } from '@sheldon/core';
import { atomicWriteFile, entityDirectory, VaultService } from '@sheldon/vault';

import { resolveVaultPath } from '../config.js';
import type { CommandContext } from '../runtime.js';
import type { VaultOption } from './entities.js';
import { compileMemory, type MemoryCommandDependencies } from './memory.js';

interface RejectionRecord {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly status: 'rejected';
  readonly reason: string;
  readonly rejectedAt: string;
}

interface RetryTrace {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly retryOf: string;
  readonly createdAt: string;
}

export async function rejectProposal(
  kind: EntityKind,
  slug: string,
  proposalId: string,
  reason: string,
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const proposal = await new ProposalStore(entity).load(proposalId);
  new ProposalStore(entity).assertPromotable(proposal);
  const normalizedReason = reason.trim();
  if (normalizedReason === '') throw new Error('A non-empty rejection reason is required.');

  const record: RejectionRecord = {
    schemaVersion: 1,
    proposalId,
    status: 'rejected',
    reason: normalizedReason,
    rejectedAt: new Date().toISOString(),
  };
  await writeRecord(entity, proposalId, 'review.json', record);
  context.write(JSON.stringify(record, null, 2));
}

export async function assertProposalNotRejected(entity: string, proposalId: string): Promise<void> {
  const record = await readRecord<RejectionRecord>(entity, proposalId, 'review.json');
  if (record?.status === 'rejected') {
    throw new Error(`Proposal ${proposalId} was rejected: ${record.reason}`);
  }
}

export async function retryCompile(
  kind: EntityKind,
  slug: string,
  proposalId: string,
  retryOf: string,
  options: VaultOption & {
    readonly agent: 'codex' | 'claude';
    readonly prompt: string;
    readonly raw: readonly string[];
  },
  context: CommandContext,
  dependencies: MemoryCommandDependencies = {},
): Promise<void> {
  if (proposalId === retryOf)
    throw new Error('A retry proposal id must differ from the prior proposal id.');
  const entity = await resolveEntity(kind, slug, options.vault, context);
  await new ProposalStore(entity).load(retryOf);
  await compileMemory(kind, slug, proposalId, options, context, dependencies);
  const trace: RetryTrace = {
    schemaVersion: 1,
    proposalId,
    retryOf,
    createdAt: new Date().toISOString(),
  };
  await writeRecord(entity, proposalId, 'attempt.json', trace);
  context.write(JSON.stringify({ retry: trace }, null, 2));
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

async function writeRecord(
  entity: string,
  proposalId: string,
  file: string,
  record: RejectionRecord | RetryTrace,
): Promise<void> {
  const directory = join(entity, 'outputs', 'proposals', proposalId);
  await mkdir(directory, { recursive: true });
  await atomicWriteFile(join(directory, file), `${JSON.stringify(record, null, 2)}\n`);
}

async function readRecord<T>(
  entity: string,
  proposalId: string,
  file: string,
): Promise<T | undefined> {
  try {
    return JSON.parse(
      await readFile(join(entity, 'outputs', 'proposals', proposalId, file), 'utf8'),
    ) as T;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
