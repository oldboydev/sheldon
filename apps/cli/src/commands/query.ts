import {
  JsonCommandExecutor,
  QueryAnswerStore,
  createClaudeCommandAdapter,
  createClaudeQueryAdapter,
  createCodexCommandAdapter,
  createCodexQueryAdapter,
  validateQueryAnswer,
  type AgentKind,
  type CommandExecutor,
  type QueryAnswer,
} from '@sheldon/agent-runtime';
import type { EntityKind } from '@sheldon/core';
import { QueryService, SearchIndex } from '@sheldon/search';

import { resolveVaultPath } from '../config.js';
import type { CommandContext } from '../runtime.js';
import type { VaultOption } from './entities.js';
import { resolveEntity } from './memory.js';

export interface QueryCommandOptions extends VaultOption {
  readonly agent: AgentKind;
  readonly question: string;
  readonly linkDepth?: number;
  readonly maxContextChars?: number;
  readonly rebuild?: boolean;
}

export interface PromoteAnswerOptions extends VaultOption {
  readonly prompt: string;
}

export interface QueryCommandDependencies {
  readonly agentExecutor?: CommandExecutor;
}

/** Runs an index-first cited query, then persists its agent answer without modifying wiki files. */
export async function queryVault(
  kind: EntityKind,
  slug: string,
  answerId: string,
  options: QueryCommandOptions,
  context: CommandContext,
  dependencies: QueryCommandDependencies = {},
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const root = await resolveVaultPath(context, options.vault);
  const index = options.rebuild
    ? await SearchIndex.rebuild(root)
    : await SearchIndex.openOrRebuild(root);
  const service = new QueryService(root, index);
  try {
    const contextResult = await service.query({
      question: options.question,
      filters: kind === 'topic' ? { topic: slug } : { project: slug },
      ...(options.linkDepth === undefined ? {} : { linkDepth: options.linkDepth }),
      ...(options.maxContextChars === undefined
        ? {}
        : { maxContextChars: options.maxContextChars }),
    });
    const answers = new QueryAnswerStore(entity);
    const answer =
      contextResult.concepts.length === 0
        ? uncoveredAnswer(answerId, options, contextResult.gaps, contextResult.truncated)
        : await answerFromAgent(answerId, options, contextResult, entity, context, dependencies);
    const validated = validateQueryAnswer(answer).answer;
    assertAnswerEvidence(validated, contextResult.citations);
    context.write(JSON.stringify(await answers.save(validated), null, 2));
  } finally {
    service.close();
  }
}

/** Creates a reviewable proposal from a saved answer; it writes proposal output only. */
export async function promoteAnswer(
  kind: EntityKind,
  slug: string,
  answerId: string,
  proposalId: string,
  options: PromoteAnswerOptions,
  context: CommandContext,
  dependencies: QueryCommandDependencies = {},
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const answers = new QueryAnswerStore(entity);
  const answer = await answers.loadPromotable(answerId);
  const executor =
    dependencies.agentExecutor ?? new JsonCommandExecutor({ environment: context.environment });
  const adapter =
    answer.agent === 'codex'
      ? createCodexCommandAdapter(executor)
      : createClaudeCommandAdapter(executor);
  const execution = await adapter.execute({
    proposalId,
    prompt: options.prompt,
    promptVersion: 'query-answer-promotion/v1',
    rawSources: answer.raws.map((raw) => raw.path),
    workingDirectory: entity,
  });
  if (execution.status !== 'proposal') {
    throw new Error(
      execution.status === 'error'
        ? execution.message
        : 'The answer promotion was cancelled before a proposal was produced.',
    );
  }
  if (execution.proposal.id !== proposalId) {
    throw new Error('The promoted proposal id does not match the requested proposal id.');
  }
  context.write(
    JSON.stringify(
      await answers.promote(answerId, execution.proposal, {
        prompt: options.prompt,
        promptVersion: 'query-answer-promotion/v1',
        agentVersion: execution.agentVersion,
      }),
      null,
      2,
    ),
  );
}

async function answerFromAgent(
  answerId: string,
  options: QueryCommandOptions,
  result: Awaited<ReturnType<QueryService['query']>>,
  entity: string,
  context: CommandContext,
  dependencies: QueryCommandDependencies,
): Promise<QueryAnswer> {
  const executor =
    dependencies.agentExecutor ?? new JsonCommandExecutor({ environment: context.environment });
  const adapter =
    options.agent === 'codex'
      ? createCodexQueryAdapter(executor)
      : createClaudeQueryAdapter(executor);
  const execution = await adapter.execute({
    answerId,
    question: options.question,
    concepts: result.concepts.map((concept) => ({
      path: concept.result.path,
      title: concept.result.title,
      body: concept.body,
    })),
    rawSources: result.citations
      .filter((citation) => citation.kind === 'raw')
      .map((citation) => citation.path),
    gaps: [
      ...result.gaps.map((gap) => gap.message),
      ...(result.truncated
        ? [
            'The local context excludes matching index results or related concepts due to its configured limits.',
          ]
        : []),
    ],
    truncated: result.truncated,
    workingDirectory: entity,
  });
  if (execution.status !== 'answer') {
    throw new Error(
      execution.status === 'error'
        ? execution.message
        : 'The cited query was cancelled before an answer was produced.',
    );
  }
  if (execution.answer.id !== answerId) {
    throw new Error('The query answer id does not match the requested answer id.');
  }
  if (execution.answer.question !== options.question || execution.answer.agent !== options.agent) {
    throw new Error('The query answer does not match the requested question and agent.');
  }
  if (execution.answer.truncated !== result.truncated) {
    throw new Error('The query answer does not match the selected-context truncation state.');
  }
  return execution.answer;
}

function uncoveredAnswer(
  answerId: string,
  options: QueryCommandOptions,
  gaps: readonly { readonly message: string; readonly suggestedSources: readonly string[] }[],
  truncated: boolean,
): QueryAnswer {
  return {
    schemaVersion: 1,
    id: answerId,
    question: options.question,
    agent: options.agent,
    truncated,
    concepts: [],
    raws: [],
    createdAt: new Date().toISOString(),
    text: [
      '## Wiki facts',
      '- No indexed wiki fact covers this question.',
      '',
      '## Inferences',
      '- None; Sheldon does not infer a wiki answer without coverage.',
      '',
      '## Gaps',
      ...gaps.flatMap((gap) => [
        `- ${gap.message}`,
        ...gap.suggestedSources.map((suggestion) => `  - Suggested source: ${suggestion}`),
      ]),
    ].join('\n'),
  };
}

function assertAnswerEvidence(
  answer: QueryAnswer,
  evidence: readonly { readonly kind: 'concept' | 'raw'; readonly path: string }[],
): void {
  const permittedConcepts = new Set(
    evidence.filter((citation) => citation.kind === 'concept').map((citation) => citation.path),
  );
  const permittedRaws = new Set(
    evidence.filter((citation) => citation.kind === 'raw').map((citation) => citation.path),
  );
  const concept = answer.concepts.find((citation) => !permittedConcepts.has(citation.path));
  if (concept !== undefined) {
    throw new Error(
      `The query answer cites concept evidence outside its context: ${concept.path}.`,
    );
  }
  const raw = answer.raws.find((citation) => !permittedRaws.has(citation.path));
  if (raw !== undefined) {
    throw new Error(`The query answer cites raw evidence outside its context: ${raw.path}.`);
  }
  if (permittedConcepts.size > 0 && answer.concepts.length === 0) {
    throw new Error('The query answer omits citations for the selected wiki context.');
  }
}
