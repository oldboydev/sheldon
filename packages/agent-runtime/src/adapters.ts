import type { StructuredProposal } from './proposal.js';
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
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  execute(task: AgentTask, options?: { readonly signal?: AbortSignal }): Promise<CommandExecution>;
}

export function createCodexCommandAdapter(executor: CommandExecutor): AgentAdapter {
  return createCommandAdapter('codex', executor);
}

export function createClaudeCommandAdapter(executor: CommandExecutor): AgentAdapter {
  return createCommandAdapter('claude', executor);
}

function createCommandAdapter(kind: AgentKind, executor: CommandExecutor): AgentAdapter {
  return {
    kind,
    execute: (task, options) =>
      executor.execute(
        {
          executable: kind,
          arguments: commandArguments(kind),
          prompt: renderPrompt(task),
          input: task,
          outputSchema: structuredProposalJsonSchema,
        },
        options,
      ),
  };
}

function commandArguments(kind: AgentKind): readonly string[] {
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
        JSON.stringify(structuredProposalJsonSchema),
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
