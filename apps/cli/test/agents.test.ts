import { fileURLToPath } from 'node:url';

import { LocalAgentHealthProbe, type AgentHealthProbe } from '../src/commands/agents.js';
import { runCli } from '../src/main.js';
import { describe, expect, it } from 'vitest';

const healthFixture = fileURLToPath(
  new URL('./fixtures/agent-health-fixture.mjs', import.meta.url),
);

function fixtureHealthProbe(): LocalAgentHealthProbe {
  const override = { executable: process.execPath, arguments: [healthFixture] };
  return new LocalAgentHealthProbe({
    executables: { codex: override, claude: override, grok: override },
  });
}

const parentEnvWithSecret: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
  HOME: '/home/sheldon',
  USERPROFILE: 'C:\\Users\\sheldon',
  SECRET_TOKEN: 'must-not-be-forwarded',
  XAI_API_KEY: 'xai-test',
  GROK_HOME: '/tmp/grok-home-fixture',
};

describe('agent doctor', () => {
  it('reports binary version and usable authentication through an injected probe', async () => {
    const probe: AgentHealthProbe = {
      check: async (agent) => {
        if (agent === 'codex') {
          return { available: true, version: 'codex 1.2.3', authenticated: true };
        }
        if (agent === 'claude') {
          return { available: true, version: 'claude 4.5.6', authenticated: false };
        }
        return { available: true, version: 'grok 0.1.0', authenticated: true };
      },
    };

    const result = await runCli(['agent', 'doctor'], {
      environment: { SECRET_TOKEN: 'must-not-be-printed' },
      agentHealthProbe: probe,
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('Codex CLI: available (codex 1.2.3)');
    expect(result.stdout).toContain('Authentication: usable');
    expect(result.stdout).toContain('Claude Code: available (claude 4.5.6)');
    expect(result.stdout).toContain('Authentication: unavailable');
    expect(result.stdout).toContain('Grok CLI: available (grok 0.1.0)');
    expect(result.stdout).not.toContain('must-not-be-printed');
  });

  it('prints installation recovery for a missing selected agent', async () => {
    const result = await runCli(['agent', 'doctor', 'codex'], {
      agentHealthProbe: { check: async () => ({ available: false, authenticated: false }) },
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('Codex CLI: not found');
    expect(result.stdout).toContain('install codex');
  });

  it('reports grok installation recovery without printing secrets', async () => {
    const result = await runCli(['agent', 'doctor', 'grok'], {
      environment: { XAI_API_KEY: 'xai-must-not-print' },
      agentHealthProbe: { check: async () => ({ available: false, authenticated: false }) },
    });
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('Grok CLI: not found');
    expect(result.stdout).toMatch(/install grok/i);
    expect(result.stdout).not.toContain('xai-must-not-print');
  });

  it('does not forward SECRET_TOKEN to health-check children', async () => {
    const probe = fixtureHealthProbe();
    for (const agent of ['codex', 'claude', 'grok'] as const) {
      await expect(probe.check(agent, parentEnvWithSecret)).resolves.toMatchObject({
        available: true,
      });
    }
  });

  it('reports fixture agents available and authenticated without printing secrets', async () => {
    const result = await runCli(['agent', 'doctor'], {
      environment: parentEnvWithSecret,
      agentHealthProbe: fixtureHealthProbe(),
    });

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('Codex CLI: available (fixture 1.0 home-forwarded xai-missing');
    expect(result.stdout).toContain(
      'Claude Code: available (fixture 1.0 home-forwarded xai-missing',
    );
    expect(result.stdout).toContain(
      'Grok CLI: available (fixture 1.0 home-forwarded xai-forwarded grok-home-forwarded)',
    );
    expect(result.stdout.match(/Authentication: usable/g)).toHaveLength(3);
    expect(result.stdout).not.toContain('must-not-be-forwarded');
    expect(result.stdout).not.toContain('xai-test');
  });
});
