import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { atomicWriteFile } from '@sheldon/vault';

import { ProposalPromotionError, type ProposalStatus } from './errors.js';
import {
  isProposalId,
  summarizeProposal,
  validateProposal,
  type FileDiffSummary,
  type StructuredProposal,
} from './proposal.js';

export interface ProposalMetadata {
  readonly id: string;
  readonly status: ProposalStatus;
  readonly agent: 'codex' | 'claude';
  readonly agentVersion?: string;
  readonly prompt: string;
  readonly promptVersion: string;
  readonly rawSources: readonly string[];
  readonly createdAt: string;
  readonly completedAt: string;
  readonly error?: string;
}

export interface StoredProposal {
  readonly metadata: ProposalMetadata;
  readonly proposal?: StructuredProposal;
  readonly diffs: readonly FileDiffSummary[];
}

export class ProposalStore {
  public constructor(
    private readonly entityDirectory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async savePending(
    metadata: Omit<ProposalMetadata, 'status' | 'createdAt' | 'completedAt'>,
    proposal: StructuredProposal,
  ): Promise<StoredProposal> {
    validateProposal(proposal);
    const timestamps = this.timestamps();
    const persisted: ProposalMetadata = { ...metadata, status: 'pending', ...timestamps };
    const diffs = await this.diffs(proposal);
    await this.write(persisted, proposal, diffs);
    return { metadata: persisted, proposal, diffs };
  }

  public async saveTerminal(
    metadata: Omit<ProposalMetadata, 'createdAt' | 'completedAt'>,
  ): Promise<StoredProposal> {
    if (metadata.status === 'pending') {
      throw new Error('Terminal proposal metadata must be cancelled or error.');
    }
    const persisted: ProposalMetadata = { ...metadata, ...this.timestamps() };
    await this.write(persisted, undefined, []);
    return { metadata: persisted, diffs: [] };
  }

  public async load(id: string): Promise<StoredProposal> {
    this.assertId(id);
    const directory = this.directory(id);
    const metadata = JSON.parse(
      await readFile(join(directory, 'metadata.json'), 'utf8'),
    ) as ProposalMetadata;
    const proposal = await readJsonIfPresent<StructuredProposal>(join(directory, 'proposal.json'));
    const diffs = await readJsonIfPresent<readonly FileDiffSummary[]>(
      join(directory, 'diffs.json'),
    );
    return { metadata, ...(proposal === undefined ? {} : { proposal }), diffs: diffs ?? [] };
  }

  public assertPromotable(proposal: StoredProposal): StructuredProposal {
    if (proposal.metadata.status !== 'pending' || proposal.proposal === undefined) {
      throw new ProposalPromotionError(proposal.metadata.status);
    }
    return validateProposal(proposal.proposal).proposal;
  }

  private async diffs(proposal: StructuredProposal): Promise<readonly FileDiffSummary[]> {
    const current: Record<string, string | undefined> = {};
    for (const file of proposal.files) {
      current[file.path] = await readTextIfPresent(join(this.entityDirectory, file.path));
    }
    return summarizeProposal(proposal, current);
  }

  private async write(
    metadata: ProposalMetadata,
    proposal: StructuredProposal | undefined,
    diffs: readonly FileDiffSummary[],
  ): Promise<void> {
    this.assertId(metadata.id);
    const directory = this.directory(metadata.id);
    await mkdir(join(directory, 'artifacts'), { recursive: true });
    await atomicWriteFile(
      join(directory, 'metadata.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await atomicWriteFile(join(directory, 'diffs.json'), `${JSON.stringify(diffs, null, 2)}\n`);
    if (proposal !== undefined) {
      await atomicWriteFile(
        join(directory, 'proposal.json'),
        `${JSON.stringify(proposal, null, 2)}\n`,
      );
      await Promise.all(
        proposal.files
          .filter((file) => file.operation !== 'delete')
          .map((file, index) =>
            atomicWriteFile(
              join(directory, 'artifacts', `${String(index + 1).padStart(3, '0')}.md`),
              file.content ?? '',
            ),
          ),
      );
    }
  }

  private directory(id: string): string {
    return join(resolve(this.entityDirectory), 'outputs', 'proposals', id);
  }

  private assertId(id: string): void {
    if (!isProposalId(id)) throw new Error('Proposal id is invalid.');
  }

  private timestamps(): Pick<ProposalMetadata, 'createdAt' | 'completedAt'> {
    const timestamp = this.now().toISOString();
    return { createdAt: timestamp, completedAt: timestamp };
  }
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  const content = await readTextIfPresent(path);
  return content === undefined ? undefined : (JSON.parse(content) as T);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
