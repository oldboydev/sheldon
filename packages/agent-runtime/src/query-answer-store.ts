import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { atomicWriteFile } from '@sheldon/vault';

import { ProposalValidationError } from './errors.js';
import { isProposalId, validateProposal, type StructuredProposal } from './proposal.js';
import { ProposalStore, type StoredProposal } from './proposal-store.js';
import { isAnswerId, validateQueryAnswer, type QueryAnswer } from './query-answer.js';

/** Provenance for the proposal-generation step that follows a saved answer. */
export interface QueryAnswerPromotionProvenance {
  /** The exact prompt supplied to the proposal-generating agent. */
  readonly prompt: string;
  /** The version of the prompt template used for that execution. */
  readonly promptVersion: string;
  readonly agentVersion?: string;
}

/** Persists query answers without changing wiki content. */
export class QueryAnswerStore {
  public constructor(private readonly entityDirectory: string) {}

  public async save(answer: QueryAnswer): Promise<QueryAnswer> {
    validateQueryAnswer(answer);
    const directory = this.directory(answer.id);
    await mkdir(directory, { recursive: true });
    await atomicWriteFile(join(directory, 'answer.json'), `${JSON.stringify(answer, null, 2)}\n`);
    return answer;
  }

  public async load(id: string): Promise<QueryAnswer> {
    this.assertAnswerId(id);
    const answer = JSON.parse(
      await readFile(join(this.directory(id), 'answer.json'), 'utf8'),
    ) as QueryAnswer;
    return validateQueryAnswer(answer).answer;
  }

  /** Loads answer evidence that is eligible to seed a proposal-generating agent. */
  public async loadPromotable(id: string): Promise<QueryAnswer> {
    const answer = await this.load(id);
    this.assertRawEvidence(answer);
    return answer;
  }

  /**
   * Creates a pending proposal through the existing store.  The answer is
   * evidence only: promotion writes proposal output and never touches wiki.
   */
  public async promote(
    answerId: string,
    proposal: StructuredProposal,
    provenance: QueryAnswerPromotionProvenance,
    proposalStore: ProposalStore = new ProposalStore(this.entityDirectory),
  ): Promise<StoredProposal> {
    const answer = await this.loadPromotable(answerId);
    this.validatePromotionProvenance(provenance);
    validateProposal(proposal);
    const permittedRaws = new Set(answer.raws.map((raw) => raw.path));
    const outOfScope = proposal.sources.find((source) => !permittedRaws.has(source.rawPath));
    if (outOfScope !== undefined) {
      throw new ProposalValidationError([
        `The proposal references raw source ${outOfScope.rawPath} outside the answer evidence.`,
      ]);
    }
    if (!isProposalId(proposal.id)) throw new Error('Proposal id is invalid.');

    return proposalStore.savePending(
      {
        id: proposal.id,
        agent: answer.agent,
        prompt: provenance.prompt,
        promptVersion: provenance.promptVersion,
        ...(provenance.agentVersion === undefined ? {} : { agentVersion: provenance.agentVersion }),
        rawSources: answer.raws.map((raw) => raw.path),
      },
      proposal,
    );
  }

  private directory(id: string): string {
    return join(resolve(this.entityDirectory), 'outputs', 'answers', id);
  }

  private assertAnswerId(id: string): void {
    if (!isAnswerId(id)) throw new Error('Query answer id is invalid.');
  }

  private validatePromotionProvenance(provenance: QueryAnswerPromotionProvenance): void {
    if (typeof provenance.prompt !== 'string' || provenance.prompt.trim().length === 0) {
      throw new ProposalValidationError(['Proposal promotion must record the executed prompt.']);
    }
    if (
      typeof provenance.promptVersion !== 'string' ||
      provenance.promptVersion.trim().length === 0
    ) {
      throw new ProposalValidationError(['Proposal promotion must record a prompt version.']);
    }
    if (
      provenance.agentVersion !== undefined &&
      (typeof provenance.agentVersion !== 'string' || provenance.agentVersion.trim().length === 0)
    ) {
      throw new ProposalValidationError([
        'Proposal promotion agent version must be a non-empty string.',
      ]);
    }
  }

  private assertRawEvidence(answer: QueryAnswer): void {
    if (answer.raws.length === 0) {
      throw new ProposalValidationError([
        'A query answer without raw evidence cannot be promoted to a proposal.',
      ]);
    }
  }
}
