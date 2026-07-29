import type { StructuredProposal } from './proposal.js';
import { queryAnswerJsonSchema } from './query-answer-schema.js';
import type { QueryAnswer } from './query-answer.js';
import { structuredProposalJsonSchema } from './proposal-schema.js';

export { AGENT_PROMPT_VERSION } from './proposal-schema.js';

export type AgentKind = 'codex' | 'claude';

export interface AgentTask {
  readonly proposalId: string;
  readonly prompt: string;
  readonly promptVersion: string;
  readonly rawSources: readonly string[];
  /** Entity directory from which the agent can read only the supplied raw sources. */
  readonly workingDirectory?: string;
}

export interface AgentCommand {
  readonly executable: 'codex' | 'claude';
  readonly arguments: readonly string[];
  readonly prompt: string;
  readonly input: AgentTask;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export type CommandExecution =
  | {
      readonly status: 'proposal';
      readonly proposal: StructuredProposal;
      readonly agentVersion: string;
    }
  | { readonly status: 'cancelled'; readonly agentVersion?: string; readonly message?: string }
  | { readonly status: 'error'; readonly agentVersion?: string; readonly message: string };

export interface CommandExecutor {
  execute(
    command: AgentCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CommandExecution>;
  executeQuery?(
    command: QueryAgentCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<QueryCommandExecution>;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  execute(task: AgentTask, options?: { readonly signal?: AbortSignal }): Promise<CommandExecution>;
}

export interface QueryConceptInput {
  readonly path: string;
  readonly title: string;
  readonly body: string;
}

export interface QueryAgentTask {
  readonly answerId: string;
  readonly question: string;
  readonly concepts: readonly QueryConceptInput[];
  readonly rawSources: readonly string[];
  readonly gaps: readonly string[];
  /** True when matching index results were omitted from the selected context. */
  readonly truncated: boolean;
  /** Entity directory used as the agent working directory; cited raw access is a prompt contract. */
  readonly workingDirectory?: string;
}

export interface QueryAgentCommand {
  readonly executable: 'codex' | 'claude';
  readonly arguments: readonly string[];
  readonly prompt: string;
  readonly input: QueryAgentTask;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export type QueryCommandExecution =
  | { readonly status: 'answer'; readonly answer: QueryAnswer; readonly agentVersion: string }
  | { readonly status: 'cancelled'; readonly agentVersion?: string; readonly message?: string }
  | { readonly status: 'error'; readonly agentVersion?: string; readonly message: string };

export interface QueryAgentAdapter {
  readonly kind: AgentKind;
  execute(
    task: QueryAgentTask,
    options?: { readonly signal?: AbortSignal },
  ): Promise<QueryCommandExecution>;
}

export function createCodexCommandAdapter(executor: CommandExecutor): AgentAdapter {
  return createCommandAdapter('codex', executor);
}

export function createClaudeCommandAdapter(executor: CommandExecutor): AgentAdapter {
  return createCommandAdapter('claude', executor);
}

export function createCodexQueryAdapter(executor: CommandExecutor): QueryAgentAdapter {
  return createQueryCommandAdapter('codex', executor);
}

export function createClaudeQueryAdapter(executor: CommandExecutor): QueryAgentAdapter {
  return createQueryCommandAdapter('claude', executor);
}

function createCommandAdapter(kind: AgentKind, executor: CommandExecutor): AgentAdapter {
  return {
    kind,
    execute: (task, options) =>
      executor.execute(
        {
          executable: kind,
          arguments: commandArguments(kind, structuredProposalJsonSchema),
          prompt: renderPrompt(task),
          input: task,
          outputSchema: structuredProposalJsonSchema,
        },
        options,
      ),
  };
}

function createQueryCommandAdapter(kind: AgentKind, executor: CommandExecutor): QueryAgentAdapter {
  return {
    kind,
    execute: (task, options) => {
      if (executor.executeQuery === undefined) {
        return Promise.resolve({
          status: 'error',
          message: 'The configured agent executor does not support cited queries.',
        });
      }
      return executor.executeQuery(
        {
          executable: kind,
          arguments: commandArguments(kind, queryAnswerJsonSchema),
          prompt: renderQueryPrompt(task),
          input: task,
          outputSchema: queryAnswerJsonSchema,
        },
        options,
      );
    },
  };
}

function commandArguments(
  kind: AgentKind,
  outputSchema: Readonly<Record<string, unknown>>,
): readonly string[] {
  return kind === 'codex'
    ? [
        'exec',
        '--json',
        '--sandbox',
        'read-only',
        '--output-schema',
        '{sheldon-output-schema-file}',
        '--output-last-message',
        '{sheldon-last-message-file}',
      ]
    : [
        '--print',
        '--permission-mode',
        'plan',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(outputSchema),
      ];
}

function renderPrompt(task: AgentTask): string {
  return [
    'Produce a Sheldon structured proposal that conforms to the supplied JSON Schema.',
    `Proposal id: ${task.proposalId}`,
    'You may read only these raw source files, and must cite only these paths in the response:',
    ...task.rawSources.map((source) => `- ${source}`),
    'Do not modify files. Propose changes only under wiki/.',
    'Return the structured proposal only; do not wrap it in Markdown or add commentary.',
    'User request:',
    task.prompt,
  ].join('\n');
}

function renderQueryPrompt(task: QueryAgentTask): string {
  return [
    'Answer the question exclusively from the supplied Sheldon wiki context.',
    `Answer id: ${task.answerId}`,
    'Return a JSON query answer that conforms to the supplied JSON Schema, without Markdown fencing.',
    'The text field must have these explicit sections: "Wiki facts", "Inferences", and "Gaps".',
    `Set truncated to ${String(task.truncated)}. It records whether the supplied selected context omitted matching index results; do not infer or change it.`,
    'Every material fact or inference must name one or more supplied wiki paths in its text.',
    'Do not state general knowledge as wiki fact. If coverage is absent or insufficient, say so under Gaps and suggest a source to ingest.',
    'Only cite paths from this supplied context. You may open a cited raw path only to resolve ambiguity.',
    'Selected wiki concepts:',
    ...task.concepts.map((concept) => `- ${concept.path} (${concept.title}):\n${concept.body}`),
    'Cited raw paths:',
    ...(task.rawSources.length === 0 ? ['- none'] : task.rawSources.map((source) => `- ${source}`)),
    'Known coverage gaps:',
    ...(task.gaps.length === 0 ? ['- none'] : task.gaps.map((gap) => `- ${gap}`)),
    'User question:',
    task.question,
  ].join('\n');
}
