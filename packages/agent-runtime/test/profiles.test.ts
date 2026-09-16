import { describe, expect, it } from 'vitest';

import {
  AGENT_PROFILE_IDS,
  formatAgentKindList,
  isAgentKind,
  listAgentProfiles,
  requireAgentProfile,
} from '../src/profiles.js';

describe('agent profiles', () => {
  it('treats codex, claude, and grok as the only agent kinds', () => {
    expect(AGENT_PROFILE_IDS).toEqual(['codex', 'claude', 'grok']);
    expect(isAgentKind('codex')).toBe(true);
    expect(isAgentKind('claude')).toBe(true);
    expect(isAgentKind('grok')).toBe(true);
    expect(isAgentKind('both')).toBe(false);
    expect(isAgentKind('all')).toBe(false);
    expect(isAgentKind('cursor')).toBe(false);
  });

  it('exposes grok as a read-only worker with prompt-file argv', () => {
    const grok = requireAgentProfile('grok');
    expect(grok).toMatchObject({
      id: 'grok',
      executable: 'grok',
      appendPrompt: false,
      parser: 'grok-json',
      timeoutMilliseconds: 300_000,
      envAllowlist: ['GROK_HOME', 'XAI_API_KEY'],
      health: { authentication: 'grok-auth-store' },
      consumer: {
        skillDirectory: '.grok/skills/sheldon',
        mcpConfigRelativePath: '.grok/config.toml',
      },
    });
    expect(grok.arguments).toEqual([
      '--prompt-file',
      '{sheldon-prompt-file}',
      '--json-schema',
      '{sheldon-output-schema-json}',
      '--sandbox',
      'read-only',
      '--permission-mode',
      'plan',
      '--tools',
      'read_file,grep,list_dir',
      '--disallowed-tools',
      'search_replace,run_terminal_cmd,web_search,web_fetch',
      '--no-subagents',
      '--disable-web-search',
      '--no-auto-update',
      '--verbatim',
    ]);
    expect(formatAgentKindList()).toBe('codex, claude, or grok');
  });

  it('keeps codex and claude argv compatible with the current adapters', () => {
    const codex = requireAgentProfile('codex');
    const claude = requireAgentProfile('claude');
    expect(codex.appendPrompt).toBe(true);
    expect(codex.parser).toBe('codex-jsonl');
    expect(codex.timeoutMilliseconds).toBe(120_000);
    expect(codex.arguments).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--output-schema',
      '{sheldon-output-schema-file}',
      '--output-last-message',
      '{sheldon-last-message-file}',
    ]);
    expect(claude.appendPrompt).toBe(true);
    expect(claude.parser).toBe('claude-json');
    expect(claude.arguments).toEqual([
      '--print',
      '--permission-mode',
      'plan',
      '--output-format',
      'json',
      '--json-schema',
      '{sheldon-output-schema-json}',
    ]);
    expect(listAgentProfiles().map((profile) => profile.id)).toEqual([...AGENT_PROFILE_IDS]);
  });
});
