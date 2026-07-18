import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

import type { EntityKind } from '@sheldon/core';
import { VaultError } from '@sheldon/vault';
import { Command, CommanderError, Option } from 'commander';

import { executeDoctor } from './commands/doctor.js';
import {
  archiveEntity,
  createEntity,
  listEntities,
  renameEntity,
  showEntity,
  type VaultOption,
} from './commands/entities.js';
import { executeInit } from './commands/init.js';
import type { CommandContext } from './runtime.js';

export interface CliDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly commandAvailable?: (command: string) => Promise<boolean>;
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
    confirm: dependencies.confirm ?? defaultConfirm,
    commandAvailable: dependencies.commandAvailable ?? defaultCommandAvailable,
    write: (message) => stdout.push(`${message}\n`),
  };
  const program = createProgram(context);
  program.exitOverride();
  program.configureOutput({
    writeOut: (message) => stdout.push(message),
    writeErr: (message) => stderr.push(message),
  });

  try {
    await program.parseAsync([...args], { from: 'user' });
    return { exitCode: 0, stdout: stdout.join(''), stderr: stderr.join('') };
  } catch (error) {
    if (error instanceof VaultError) {
      stderr.push(
        `Error: ${error.message}\nTarget: ${error.target}\nRecovery: ${error.recovery}\n`,
      );
      return { exitCode: 1, stdout: stdout.join(''), stderr: stderr.join('') };
    }
    if (error instanceof CommanderError) {
      return { exitCode: error.exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
    }
    const message = error instanceof Error ? error.message : String(error);
    stderr.push(
      `Error: ${message}\nTarget: command execution\nRecovery: review the command and retry.\n`,
    );
    return { exitCode: 1, stdout: stdout.join(''), stderr: stderr.join('') };
  }
}

function createProgram(context: CommandContext): Command {
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
  return program;
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
