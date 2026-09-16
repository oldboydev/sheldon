import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  listAgentProfiles,
  requireAgentProfile,
  type AgentKind,
  type AgentProfile,
} from '@sheldon/agent-runtime';

import type { CommandContext } from '../runtime.js';

export type { AgentKind };

export interface AgentHealth {
  readonly available: boolean;
  readonly version?: string;
  readonly authenticated: boolean;
}

/** Injectable boundary for checks that call locally installed agent CLIs. */
export interface AgentHealthProbe {
  check(agent: AgentKind, environment: NodeJS.ProcessEnv): Promise<AgentHealth>;
}

export async function doctorAgents(
  agent: AgentKind | undefined,
  context: CommandContext,
  probe: AgentHealthProbe = new LocalAgentHealthProbe(),
): Promise<void> {
  const profiles = agent === undefined ? listAgentProfiles() : [requireAgentProfile(agent)];
  const results = await Promise.all(
    profiles.map(async (profile) => ({
      profile,
      health: await probe.check(profile.id, context.environment),
    })),
  );

  for (const { profile, health } of results) {
    if (!health.available) {
      context.write(`${profile.label}: not found`);
      context.write(`  Recovery: ${missingBinaryRecovery(profile)}`);
      continue;
    }
    context.write(
      `${profile.label}: available${health.version === undefined ? '' : ` (${health.version})`}`,
    );
    context.write(
      `  Authentication: ${health.authenticated ? 'usable' : 'unavailable'}${
        health.authenticated ? '' : `; sign in with ${profile.executable} and retry.`
      }`,
    );
  }
}

function missingBinaryRecovery(profile: AgentProfile): string {
  const install = `install ${profile.executable}`;
  const pathHint =
    profile.id === 'grok' && process.platform === 'win32'
      ? ' and ensure %USERPROFILE%\\.grok\\bin is on PATH'
      : '';
  return `${install}${pathHint} and run sheldon agent doctor ${profile.executable}.`;
}

/**
 * Checks only process exit status and a short version string. Authentication command output is
 * intentionally discarded so credentials and tokens cannot reach CLI output.
 */
export class LocalAgentHealthProbe implements AgentHealthProbe {
  public async check(agent: AgentKind, environment: NodeJS.ProcessEnv): Promise<AgentHealth> {
    const profile = requireAgentProfile(agent);
    const version = await invoke(
      profile.executable,
      profile.health.versionArguments,
      environment,
      true,
    );
    if (version.exitCode !== 0) return { available: false, authenticated: false };

    return {
      available: true,
      ...(version.output === undefined ? {} : { version: version.output }),
      authenticated: await checkAuthentication(profile, environment),
    };
  }
}

async function checkAuthentication(
  profile: AgentProfile,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  switch (profile.health.authentication) {
    case 'codex-login-status': {
      const authentication = await invoke(
        profile.executable,
        ['login', 'status'],
        environment,
        false,
      );
      return authentication.exitCode === 0;
    }
    case 'claude-auth-status': {
      const authentication = await invoke(
        profile.executable,
        ['auth', 'status'],
        environment,
        false,
      );
      return authentication.exitCode === 0;
    }
    case 'grok-auth-store': {
      const grokHome = environment.GROK_HOME ?? join(homedir(), '.grok');
      const hasKey = (environment.XAI_API_KEY ?? '').trim().length > 0;
      const hasStore = await pathExists(join(grokHome, 'auth.json'));
      return hasKey || hasStore;
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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
