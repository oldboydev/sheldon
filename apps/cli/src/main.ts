import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import type { EntityKind } from '@sheldon/core';
import type { CommandExecutor } from '@sheldon/agent-runtime';
import { PluginHostError } from '@sheldon/plugin-host';
import { entityDirectory, VaultError } from '@sheldon/vault';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';

import { executeDoctor } from './commands/doctor.js';
import { applicationPaths, migrateLegacyStateFrom, resolveVaultPath } from './config.js';
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
  promoteAnswer,
  queryVault,
  type PromoteAnswerOptions,
  type QueryCommandOptions,
} from './commands/query.js';
import { searchVault, type SearchCommandOptions } from './commands/search.js';
import {
  approveProposal,
  compileMemory,
  ingestCrawl,
  ingestFile,
  ingestRepository,
  ingestUrl,
  lintWiki,
  previewProposal,
  type CrawlIngestionOptions,
  type FileIngestionOptions,
  type RepositoryIngestionOptions,
  type UrlIngestionOptions,
} from './commands/memory.js';
import { assertProposalNotRejected, rejectProposal, retryCompile } from './commands/workflow.js';
import {
  doctorPlugin,
  infoPlugin,
  installPlugin,
  listPlugins,
  removePlugin,
  testPlugin,
} from './commands/plugins.js';
import {
  installImageLanguageCommand,
  listImageLanguageCommand,
  removeImageLanguageCommand,
} from './commands/images.js';
import {
  configureMcpConsumer,
  doctorMcp,
  installSheldonSkill,
  serveMcp,
  type McpConfigureOptions,
  type McpInstallSkillOptions,
} from './commands/mcp.js';
import {
  buildBundle,
  createBundle,
  diffBundles,
  validateBundle,
  type BundleBuildOptions,
  type BundleCreateOptions,
  type BundleValidateOptions,
} from './commands/bundle.js';
import type { OfficialPlatform } from '@sheldon/plugin-host';
import { startWebServer } from '@sheldon/web';
import { createWebApplication } from './web-api.js';

import {
  createOfficialCatalogClient,
  currentPlatform,
  type OfficialCatalogClient,
} from './official-catalog.js';
import type { CommandContext } from './runtime.js';

export interface CliDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly commandAvailable?: (command: string) => Promise<boolean>;
  readonly officialCatalogClient?: OfficialCatalogClient;
  readonly platform?: OfficialPlatform;
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
  const environment = dependencies.environment ?? process.env;
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const platform = dependencies.platform ?? currentPlatform();
  const context: CommandContext = {
    environment,
    homeDirectory,
    platform,
    officialCatalogClient:
      dependencies.officialCatalogClient ??
      createOfficialCatalogClient({
        platform,
        temporaryRoot: catalogTemporaryRoot(environment, homeDirectory),
      }),
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

  program
    .command('migrate-state')
    .description(
      'Copy legacy plugin state to this platform state directory after hash verification.',
    )
    .requiredOption('--from <directory>', 'legacy Sheldon application-state directory')
    .action(async (options: { from: string }) => {
      const target = applicationPaths(context).stateRoot;
      await migrateLegacyStateFrom(resolve(options.from), target);
      context.write(`Plugin state migrated to: ${target}`);
    });

  program
    .command('web')
    .description('Start the local Sheldon web interface on loopback only.')
    .option('--vault <path>', 'explicit vault path')
    .option(
      '--port <port>',
      'loopback port; omit to choose a free port',
      boundedInteger('--port', 0, 65_535),
    )
    .action(async (options: VaultOption & { port?: number }) => {
      const vaultRoot = await resolveVaultPath(context, options.vault);
      const started = await startWebServer({
        vaultRoot,
        application: createWebApplication(context, vaultRoot),
        ...(options.port === undefined ? {} : { port: options.port }),
      });
      context.write(`Sheldon web: ${started.url}`);
      context.write('Access is restricted to 127.0.0.1. Press Ctrl+C to stop the local server.');
    });

  addEntityCommands(program, 'topic', context);
  addEntityCommands(program, 'project', context);
  addMemoryCommands(program, context, dependencies);
  addBundleCommands(program, context);
  program
    .command('search <query>')
    .option('--topic <slug>', 'restrict results to one topic')
    .option('--project <slug>', 'restrict results to one project')
    .option('--type <type>', 'restrict results to one concept type')
    .option('--tag <tag>', 'restrict results to one tag')
    .option('--status <status>', 'restrict results to one concept status')
    .option(
      '--updated-after <timestamp>',
      'restrict results updated at or after an ISO-8601 instant',
    )
    .option(
      '--updated-before <timestamp>',
      'restrict results updated at or before an ISO-8601 instant',
    )
    .option('--rebuild', 'rebuild the disposable local index before searching')
    .option('--vault <path>', 'explicit vault path')
    .action((query: string, options: SearchCommandOptions) => searchVault(query, options, context));
  program
    .command('query <kind> <slug> <answer-id>')
    .requiredOption('--question <text>', 'question to answer from indexed wiki context')
    .requiredOption(
      '--agent <agent>',
      'agent that writes the cited answer (codex or claude)',
      agentKind,
    )
    .option(
      '--link-depth <depth>',
      'maximum local wiki-link expansion depth (0-2; default 1)',
      boundedInteger('--link-depth', 0, 2),
    )
    .option(
      '--max-context-chars <characters>',
      'maximum characters in selected wiki concept records (1000-200000; default 24000)',
      boundedInteger('--max-context-chars', 1_000, 200_000),
    )
    .option('--rebuild', 'rebuild the disposable local index before selecting context')
    .option('--vault <path>', 'explicit vault path')
    .action((kind: EntityKind, slug: string, answerId: string, options: QueryCommandOptions) =>
      queryVault(kind, slug, answerId, options, context, dependencies),
    );
  const answer = program.command('answer');
  answer
    .command('promote <kind> <slug> <answer-id> <proposal-id>')
    .requiredOption('--prompt <text>', 'instruction for the proposed durable wiki change')
    .option('--vault <path>', 'explicit vault path')
    .action(
      (
        kind: EntityKind,
        slug: string,
        answerId: string,
        proposalId: string,
        options: PromoteAnswerOptions,
      ) => promoteAnswer(kind, slug, answerId, proposalId, options, context, dependencies),
    );
  const agent = program.command('agent');
  agent.command('doctor [agent]').action((name: string | undefined) => {
    if (name !== undefined && name !== 'codex' && name !== 'claude') {
      throw new Error('Agent must be codex or claude.');
    }
    return doctorAgents(name as AgentName | undefined, context, dependencies.agentHealthProbe);
  });
  const mcp = program.command('mcp').description('Configure local scoped MCP knowledge access.');
  mcp
    .command('configure <consumer>')
    .requiredOption('--vault <path>', 'absolute Sheldon vault path')
    .requiredOption('--consumer-id <id>', 'stable identity for the consumer project')
    .requiredOption('--scope <kind:slug...>', 'authorized topic or project scope; repeat as needed')
    .option('--bundle <path>', 'optional bundle definition relative to vault/bundles')
    .option('--apply', 'apply the previewed local configuration changes')
    .action((consumer: string, options: McpConfigureOptions) =>
      configureMcpConsumer(consumer, options, context),
    );
  mcp
    .command('install-skill <consumer>')
    .option('--agent <agent>', 'codex, claude, or both', (value) => {
      if (value === 'codex' || value === 'claude' || value === 'both') return value;
      throw new InvalidArgumentError('--agent must be codex, claude, or both.');
    })
    .option('--apply', 'copy the generated skill after displaying the targets')
    .action((consumer: string, options: McpInstallSkillOptions) =>
      installSheldonSkill(consumer, options, context),
    );
  mcp
    .command('doctor')
    .requiredOption('--consumer <path>', 'consumer project directory')
    .action((options: { consumer: string }) => doctorMcp(options.consumer, context));
  mcp
    .command('serve')
    .requiredOption('--consumer-config <path>', 'absolute consumer MCP configuration path')
    .action((options: { consumerConfig: string }) => serveMcp(options.consumerConfig));
  const plugin = program.command('plugin');
  plugin.command('install <id>').action((id: string) => installPlugin(id, context));
  plugin.command('remove <id>').action((id: string) => removePlugin(id, context));
  plugin
    .command('list')
    .option('--remote', 'load the signed official catalog')
    .action((options: { remote?: boolean }) => listPlugins(context, options));
  plugin
    .command('info <id>')
    .option('--remote', 'load the signed official catalog')
    .action((id: string, options: { remote?: boolean }) => infoPlugin(id, context, options));
  plugin.command('doctor <id>').action((id: string) => doctorPlugin(id, context));
  plugin.command('test <directory>').action((directory: string) => testPlugin(directory, context));
  const image = program.command('image');
  const language = image.command('language');
  language.command('list').action(() => listImageLanguageCommand(context));
  language
    .command('install <code>')
    .action((code: string) => installImageLanguageCommand(code, context));
  language
    .command('remove <code>')
    .action((code: string) => removeImageLanguageCommand(code, context));
  return program;
}

function agentKind(value: string): AgentName {
  if (value === 'codex' || value === 'claude') return value;
  throw new InvalidArgumentError('Agent must be codex or claude.');
}

function catalogTemporaryRoot(environment: NodeJS.ProcessEnv, homeDirectory: string): string {
  return applicationPaths({ environment, homeDirectory }).temporaryRoot;
}

function addBundleCommands(program: Command, context: CommandContext): void {
  const bundle = program
    .command('bundle')
    .description('Create, compile, validate, and compare local portable OKF bundles.');
  bundle
    .command('create <bundle-id>')
    .requiredOption('--concept <concept-id...>', 'stable approved concept id; repeat as needed')
    .option('--title <title>', 'human-readable bundle title')
    .option('--description <description>', 'bundle purpose')
    .option('--dependencies <mode>', 'explicit, direct, or recursive', 'explicit')
    .option(
      '--max-depth <depth>',
      'maximum recursive dependency depth',
      boundedInteger('--max-depth', 1, 32),
    )
    .option('--unresolved-link <policy>', 'include, keep-broken, or remove-warning', 'include')
    .option('--vault <path>', 'explicit vault path')
    .action((bundleId: string, options: BundleCreateOptions) => {
      if (!['explicit', 'direct', 'recursive'].includes(options.dependencies ?? 'explicit')) {
        throw new InvalidArgumentError('--dependencies must be explicit, direct, or recursive.');
      }
      if (
        !['include', 'keep-broken', 'remove-warning'].includes(options.unresolvedLink ?? 'include')
      ) {
        throw new InvalidArgumentError(
          '--unresolved-link must be include, keep-broken, or remove-warning.',
        );
      }
      if (options.maxDepth !== undefined && options.dependencies !== 'recursive') {
        throw new InvalidArgumentError('--max-depth is valid only with --dependencies recursive.');
      }
      return createBundle(bundleId, options, context);
    });
  bundle
    .command('build <bundle-id>')
    .option('--mode <mode>', 'strict or lenient validation', 'strict')
    .option('--apply', 'write the previewed portable bundle after selection review')
    .option('--vault <path>', 'explicit vault path')
    .action((bundleId: string, options: BundleBuildOptions) => {
      assertOkfMode(options.mode);
      return buildBundle(bundleId, options, context);
    });
  bundle
    .command('validate <directory>')
    .option('--mode <mode>', 'strict or lenient validation', 'strict')
    .action((directory: string, options: BundleValidateOptions) => {
      assertOkfMode(options.mode);
      return validateBundle(directory, options, context);
    });
  bundle
    .command('diff <previous-directory> <next-directory>')
    .action((previousDirectory: string, nextDirectory: string) =>
      diffBundles(previousDirectory, nextDirectory, context),
    );
}

function assertOkfMode(
  value: string | undefined,
): asserts value is 'strict' | 'lenient' | undefined {
  if (value !== undefined && value !== 'strict' && value !== 'lenient') {
    throw new InvalidArgumentError('--mode must be strict or lenient.');
  }
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
  ingest
    .command('url <kind> <slug> <url>')
    .option('--vault <path>', 'explicit vault path')
    .option('--plugin <id>', 'explicit URL ingestion plugin')
    .option('--language <tags>', 'preferred comma-separated language tags')
    .option('--cookies <path>', 'optional local cookie file (never stored)')
    .option('--media <mode>', 'social media capture: none, thumbnail, or images', parseMediaMode)
    .option('--ocr', 'derive local OCR from explicitly downloaded image assets')
    .option(
      '--stt',
      'allow an already-installed local speech-to-text runtime (may download temporary audio up to 50 MiB, even with --media none)',
    )
    .action((kind: EntityKind, slug: string, url: string, options: UrlIngestionOptions) =>
      ingestUrl(kind, slug, url, options, context),
    );
  ingest
    .command('crawl <kind> <slug> <seed-url>')
    .requiredOption(
      '--max-pages <count>',
      'maximum page attempts (1-10)',
      boundedInteger('--max-pages', 1, 10),
    )
    .requiredOption(
      '--max-depth <depth>',
      'maximum link depth (0-2)',
      boundedInteger('--max-depth', 0, 2),
    )
    .option('--vault <path>', 'explicit vault path')
    .option('--plugin <id>', 'explicit site ingestion plugin')
    .action((kind: EntityKind, slug: string, seed: string, options: CrawlIngestionOptions) =>
      ingestCrawl(kind, slug, seed, options, context),
    );
  ingest
    .command('repository <kind> <slug> <directory>')
    .option('--vault <path>', 'explicit vault path')
    .option('--plugin <id>', 'explicit repository ingestion plugin')
    .action(
      (kind: EntityKind, slug: string, directory: string, options: RepositoryIngestionOptions) =>
        ingestRepository(kind, slug, directory, options, context),
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

function boundedInteger(name: string, minimum: number, maximum: number): (value: string) => number {
  return (value) => {
    if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
      throw new InvalidArgumentError(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    const parsed = Number(value);
    if (parsed < minimum || parsed > maximum) {
      throw new InvalidArgumentError(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    return parsed;
  };
}

function parseMediaMode(value: string): 'none' | 'thumbnail' | 'images' {
  if (value !== 'none' && value !== 'thumbnail' && value !== 'images') {
    throw new InvalidArgumentError('--media must be none, thumbnail, or images.');
  }
  return value;
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
