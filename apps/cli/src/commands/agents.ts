import { spawn } from 'node:child_process';

import type { CommandContext } from '../runtime.js';

export type AgentName = 'codex' | 'claude';

export interface AgentHealth {
  readonly available: boolean;
  readonly version?: string;
  readonly authenticated: boolean;
}

/** Injectable boundary for checks that call locally installed agent CLIs. */
export interface AgentHealthProbe {
  check(agent: AgentName, environment: NodeJS.ProcessEnv): Promise<AgentHealth>;
}

export async function doctorAgents(
  agent: AgentName | undefined,
  context: CommandContext,
  probe: AgentHealthProbe = new LocalAgentHealthProbe(),
): Promise<void> {
  const agents: readonly AgentName[] = agent === undefined ? ['codex', 'claude'] : [agent];
  const results = await Promise.all(
    agents.map(async (name) => ({ name, health: await probe.check(name, context.environment) })),
  );

  for (const { name, health } of results) {
    const label = name === 'codex' ? 'Codex CLI' : 'Claude Code';
    if (!health.available) {
      context.write(`${label}: not found`);
      context.write(`  Recovery: install ${name} and run sheldon agent doctor ${name}.`);
      continue;
    }
    context.write(
      `${label}: available${health.version === undefined ? '' : ` (${health.version})`}`,
    );
    context.write(
      `  Authentication: ${health.authenticated ? 'usable' : 'unavailable'}${
        health.authenticated ? '' : `; sign in with ${name} and retry.`
      }`,
    );
  }
}

/**
 * Checks only process exit status and a short version string. Authentication command output is
 * intentionally discarded so credentials and tokens cannot reach CLI output.
 */
export class LocalAgentHealthProbe implements AgentHealthProbe {
  public async check(agent: AgentName, environment: NodeJS.ProcessEnv): Promise<AgentHealth> {
    const version = await invoke(agent, ['--version'], environment, true);
    if (version.exitCode !== 0) return { available: false, authenticated: false };

    const authentication = await invoke(
      agent,
      agent === 'codex' ? ['login', 'status'] : ['auth', 'status'],
      environment,
      false,
    );
    return {
      available: true,
      ...(version.output === undefined ? {} : { version: version.output }),
      authenticated: authentication.exitCode === 0,
    };
  }
}

async function invoke(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  captureOutput: boolean,
): Promise<{ readonly exitCode: number | null; readonly output?: string }> {
  return new Promise((resolve) => {
    let output = '';
    let finished = false;
    const child = spawn(executable, arguments_, {
      shell: false,
      env: environment,
      stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'ignore'],
      windowsHide: true,
    });
    const timeout = setTimeout(() => child.kill(), 5_000);
    const finish = (result: {
      readonly exitCode: number | null;
      readonly output?: string;
    }): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(result);
    };
    if (captureOutput) {
      child.stdout?.on('data', (chunk: Buffer) => {
        if (output.length < 256) output += chunk.toString('utf8').slice(0, 256 - output.length);
      });
    }
    child.once('error', () => finish({ exitCode: null }));
    child.once('close', (exitCode) => {
      const version = output.trim().replace(/\s+/g, ' ');
      finish({ exitCode, ...(version === '' ? {} : { output: version }) });
    });
  });
}
