import type { AgentAdapter, AgentTask } from './adapters.js';
import { ProposalValidationError } from './errors.js';
import { validateProposal } from './proposal.js';
import { ProposalStore, type StoredProposal } from './proposal-store.js';

export class AgentRuntime {
  public constructor(private readonly store: ProposalStore) {}

  public async run(
    adapter: AgentAdapter,
    task: AgentTask,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<StoredProposal> {
    const startedAt = new Date().toISOString();
    let execution;
    try {
      execution = await adapter.execute(task, options);
    } catch (error) {
      return this.store.saveTerminal({
        ...metadata(task, adapter.kind, startedAt),
        status: 'error',
        error: safeError(error),
      });
    }

    if (execution.status === 'cancelled') {
      return this.store.saveTerminal({
        ...metadata(task, adapter.kind, startedAt, execution.agentVersion),
        status: 'cancelled',
        ...(execution.message === undefined ? {} : { error: execution.message }),
      });
    }
    if (execution.status === 'error') {
      return this.store.saveTerminal({
        ...metadata(task, adapter.kind, startedAt, execution.agentVersion),
        status: 'error',
        error: execution.message,
      });
    }

    try {
      validateProposal(execution.proposal);
      if (execution.proposal.id !== task.proposalId) {
        throw new ProposalValidationError(['The proposal id does not match the task id.']);
      }
      const permittedSources = new Set(task.rawSources);
      const outOfScopeSource = execution.proposal.sources.find(
        (source) => !permittedSources.has(source.rawPath),
      );
      if (outOfScopeSource !== undefined) {
        throw new ProposalValidationError([
          `The proposal references raw source ${outOfScopeSource.rawPath} outside the task scope.`,
        ]);
      }
      return this.store.savePending(
        metadata(task, adapter.kind, startedAt, execution.agentVersion),
        execution.proposal,
      );
    } catch (error) {
      return this.store.saveTerminal({
        ...metadata(task, adapter.kind, startedAt, execution.agentVersion),
        status: 'error',
        error: safeError(error),
      });
    }
  }
}

function metadata(
  task: AgentTask,
  agent: 'codex' | 'claude',
  createdAt: string,
  agentVersion?: string,
) {
  return {
    id: task.proposalId,
    agent,
    ...(agentVersion === undefined ? {} : { agentVersion }),
    prompt: task.prompt,
    promptVersion: task.promptVersion,
    rawSources: task.rawSources,
    createdAt,
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'The agent execution failed.';
}
