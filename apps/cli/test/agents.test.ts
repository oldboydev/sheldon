import type { AgentHealthProbe } from '../src/commands/agents.js';
import { runCli } from '../src/main.js';
import { describe, expect, it } from 'vitest';

describe('agent doctor', () => {
  it('reports binary version and usable authentication through an injected probe', async () => {
    const probe: AgentHealthProbe = {
      check: async (agent) =>
        agent === 'codex'
          ? { available: true, version: 'codex 1.2.3', authenticated: true }
          : { available: true, version: 'claude 4.5.6', authenticated: false },
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
});
