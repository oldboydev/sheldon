import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { atomicWriteFile } from '@sheldon/vault';

import { ProposalValidationError } from './errors.js';
import { isProposalId, validateProposal, type StructuredProposal } from './proposal.js';
import { ProposalStore, type StoredProposal } from './proposal-store.js';
import { isAnswerId, validateQueryAnswer, type QueryAnswer } from './query-answer.js';

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

  /**
   * Creates a pending proposal through the existing store.  The answer is
   * evidence only: promotion writes proposal output and never touches wiki.
   */
  public async promote(
    answerId: string,
    proposal: StructuredProposal,
    proposalStore: ProposalStore = new ProposalStore(this.entityDirectory),
  ): Promise<StoredProposal> {
    const answer = await this.load(answerId);
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
        prompt: answer.question,
        promptVersion: 'query-answer/v1',
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
}
