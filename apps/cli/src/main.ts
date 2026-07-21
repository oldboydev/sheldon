import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

import type { EntityKind } from '@sheldon/core';
import type { CommandExecutor } from '@sheldon/agent-runtime';
import { PluginHostError } from '@sheldon/plugin-host';
import { entityDirectory, VaultError } from '@sheldon/vault';
import { Command, CommanderError, Option } from 'commander';

import { executeDoctor } from './commands/doctor.js';
import { resolveVaultPath } from './config.js';
import { doctorAgents, type AgentHealthProbe, type AgentName } from './commands/agents.js';
import {
  archiveEntity,
  createEntity,
  listEntities,
  renameEntity,
  showEntity,
  type VaultOption,
} from './commands/entities.js';
import { executeInit } from './commands/init.js';
import {
  approveProposal,
  compileMemory,
  ingestFile,
  lintWiki,
  previewProposal,
  type FileIngestionOptions,
} from './commands/memory.js';
import { assertProposalNotRejected, rejectProposal, retryCompile } from './commands/workflow.js';
import {
  doctorPlugin,
  installPlugin,
  listPlugins,
  removePlugin,
  testPlugin,
} from './commands/plugins.js';
import { bundledOfficialPluginRoot, type CommandContext } from './runtime.js';

export interface CliDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly commandAvailable?: (command: string) => Promise<boolean>;
  readonly officialPluginRoots?: readonly string[];
  readonly agentExecutor?: CommandExecutor;
  readonly agentHealthProbe?: AgentHealthProbe;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CommandContext = {
    environment: dependencies.environment ?? process.env,
    homeDirectory: dependencies.homeDirectory ?? homedir(),
    officialPluginRoots: dependencies.officialPluginRoots ?? [bundledOfficialPluginRoot],
    confirm: dependencies.confirm ?? defaultConfirm,
    commandAvailable: dependencies.commandAvailable ?? defaultCommandAvailable,
    write: (message) => stdout.push(`${message}\n`),
  };
  const program = createProgram(context, dependencies);
  configureCommander(program, stdout, stderr);

  try {
    await program.parseAsync([...args], { from: 'user' });
    return { exitCode: 0, stdout: stdout.join(''), stderr: stderr.join('') };
  } catch (error) {
    if (error instanceof PluginHostError) {
      stderr.push(
        `Error [${error.code}]: ${error.message}\nTarget: ${error.target}\nRecovery: ${error.recovery}\n`,
      );
      return { exitCode: 1, stdout: stdout.join(''), stderr: stderr.join('') };
    }
    if (error instanceof VaultError) {
      stderr.push(
        `Error: ${error.message}\nTarget: ${error.target}\nRecovery: ${error.recovery}\n`,
      );
      return { exitCode: 1, stdout: stdout.join(''), stderr: stderr.join('') };
    }
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) {
        stderr.splice(0);
        const message = error.message.replace(/^error:\s*/i, '');
        stderr.push(
          `Error: ${message}\nTarget: command syntax\nRecovery: run sheldon help <command> and retry.\n`,
        );
      }
      return { exitCode: error.exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
    }
    const message = error instanceof Error ? error.message : String(error);
    stderr.push(
      `Error: ${message}\nTarget: command execution\nRecovery: review the command and retry.\n`,
    );
    return { exitCode: 1, stdout: stdout.join(''), stderr: stderr.join('') };
  }
}

function configureCommander(command: Command, stdout: string[], stderr: string[]): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (message) => stdout.push(message),
    writeErr: (message) => stderr.push(message),
  });
  for (const child of command.commands) configureCommander(child, stdout, stderr);
}

function createProgram(context: CommandContext, dependencies: CliDependencies): Command {
  const program = new Command('sheldon').description('Local-first personal knowledge vault.');

  program
    .command('init [path]')
    .addOption(new Option('--yes', 'accept the proposed default path'))
    .action((path: string | undefined, options: { yes?: boolean }) =>
      executeInit(path, options, context),
    );

  program
    .command('doctor')
    .option('--vault <path>', 'explicit vault path')
    .action((options: VaultOption) => executeDoctor(options, context));

  addEntityCommands(program, 'topic', context);
  addEntityCommands(program, 'project', context);
  addMemoryCommands(program, context, dependencies);
  const agent = program.command('agent');
  agent.command('doctor [agent]').action((name: string | undefined) => {
    if (name !== undefined && name !== 'codex' && name !== 'claude') {
      throw new Error('Agent must be codex or claude.');
    }
    return doctorAgents(name as AgentName | undefined, context, dependencies.agentHealthProbe);
  });
  const plugin = program.command('plugin');
  plugin
    .command('install <directory>')
    .action((directory: string) => installPlugin(directory, context));
  plugin.command('remove <id>').action((id: string) => removePlugin(id, context));
  plugin.command('list').action(() => listPlugins(context));
  plugin.command('doctor <id>').action((id: string) => doctorPlugin(id, context));
  plugin.command('test <directory>').action((directory: string) => testPlugin(directory, context));
  return program;
}

function addMemoryCommands(
  program: Command,
  context: CommandContext,
  dependencies: CliDependencies,
): void {
  const ingest = program.command('ingest');
  ingest
    .command('file <kind> <slug> <file>')
    .option('--vault <path>', 'explicit vault path')
    .option('--plugin <id>', 'explicit file ingestion plugin')
    .action((kind: EntityKind, slug: string, file: string, options: FileIngestionOptions) =>
      ingestFile(kind, slug, file, options, context),
    );

  program
    .command('compile <kind> <slug> <proposal-id>')
    .requiredOption('--agent <agent>', 'codex or claude')
    .requiredOption('--prompt <text>', 'task prompt')
    .requiredOption('--raw <path...>', 'raw source paths relative to the entity')
    .option('--vault <path>', 'explicit vault path')
    .action(
      (
        kind: EntityKind,
        slug: string,
        proposalId: string,
        options: VaultOption & { agent: string; prompt: string; raw: string[] },
      ) => {
        if (options.agent !== 'codex' && options.agent !== 'claude')
          throw new Error('Agent must be codex or claude.');
        return compileMemory(
          kind,
          slug,
          proposalId,
          { ...options, agent: options.agent },
          context,
          dependencies,
        );
      },
    );

  program
    .command('compile-retry <kind> <slug> <proposal-id>')
    .requiredOption('--from <proposal-id>', 'prior proposal id')
    .requiredOption('--agent <agent>', 'codex or claude')
    .requiredOption('--prompt <text>', 'task prompt')
    .requiredOption('--raw <path...>', 'raw source paths relative to the entity')
    .option('--vault <path>', 'explicit vault path')
    .action(
      (
        kind: EntityKind,
        slug: string,
        proposalId: string,
        options: VaultOption & { agent: string; from: string; prompt: string; raw: string[] },
      ) => {
        if (options.agent !== 'codex' && options.agent !== 'claude') {
          throw new Error('Agent must be codex or claude.');
        }
        return retryCompile(
          kind,
          slug,
          proposalId,
          options.from,
          { ...options, agent: options.agent },
          context,
          dependencies,
        );
      },
    );

  const review = program.command('review');
  review
    .command('preview <kind> <slug> <proposal-id>')
    .option('--vault <path>', 'explicit vault path')
    .action((kind: EntityKind, slug: string, proposalId: string, options: VaultOption) =>
      previewProposal(kind, slug, proposalId, options, context),
    );
  review
    .command('approve <kind> <slug> <proposal-id> <paths...>')
    .option('--vault <path>', 'explicit vault path')
    .action(
      async (
        kind: EntityKind,
        slug: string,
        proposalId: string,
        paths: string[],
        options: VaultOption,
      ) => {
        const root = await resolveVaultPath(context, options.vault);
        const entity = entityDirectory(root, kind, slug);
        await assertProposalNotRejected(entity, proposalId);
        return approveProposal(kind, slug, proposalId, paths, options, context);
      },
    );
  review
    .command('reject <kind> <slug> <proposal-id>')
    .requiredOption('--reason <text>', 'reason for rejecting the proposal')
    .option('--vault <path>', 'explicit vault path')
    .action(
      (
        kind: EntityKind,
        slug: string,
        proposalId: string,
        options: VaultOption & { reason: string },
      ) => rejectProposal(kind, slug, proposalId, options.reason, options, context),
    );
  review
    .command('lint <kind> <slug>')
    .option('--vault <path>', 'explicit vault path')
    .action((kind: EntityKind, slug: string, options: VaultOption) =>
      lintWiki(kind, slug, options, context),
    );
}

function addEntityCommands(program: Command, kind: EntityKind, context: CommandContext): void {
  const entity = program.command(kind);

  entity
    .command('create <title>')
    .option('--description <text>', 'entity description')
    .option('--vault <path>', 'explicit vault path')
    .action((title: string, options: VaultOption & { description?: string }) =>
      createEntity(kind, title, options, context),
    );
  entity
    .command('list')
    .option('--vault <path>', 'explicit vault path')
    .action((options: VaultOption) => listEntities(kind, options, context));
  entity
    .command('show <slug>')
    .option('--vault <path>', 'explicit vault path')
    .action((slug: string, options: VaultOption) => showEntity(kind, slug, options, context));
  entity
    .command('rename <slug> <title>')
    .option('--vault <path>', 'explicit vault path')
    .action((slug: string, title: string, options: VaultOption) =>
      renameEntity(kind, slug, title, options, context),
    );
  entity
    .command('archive <slug>')
    .option('--vault <path>', 'explicit vault path')
    .action((slug: string, options: VaultOption) => archiveEntity(kind, slug, options, context));
}

async function defaultConfirm(message: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`${message} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

async function defaultCommandAvailable(command: string): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const child = spawn(command, ['--version'], { stdio: 'ignore', windowsHide: true });
    const timeout = setTimeout(() => child.kill(), 3_000);
    child.once('error', () => {
      clearTimeout(timeout);
      resolveAvailability(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveAvailability(code === 0);
    });
  });
}
