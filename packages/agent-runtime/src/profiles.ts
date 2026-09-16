export const AGENT_PROFILE_IDS = ['codex', 'claude', 'grok'] as const;
export type AgentKind = (typeof AGENT_PROFILE_IDS)[number];
export type AgentOutputParser = 'codex-jsonl' | 'claude-json' | 'grok-json';

export interface AgentProfile {
  readonly id: AgentKind;
  readonly label: string;
  readonly executable: AgentKind;
  readonly arguments: readonly string[];
  readonly appendPrompt: boolean;
  readonly parser: AgentOutputParser;
  readonly timeoutMilliseconds: number;
  readonly envAllowlist: readonly string[];
  readonly health: {
    readonly versionArguments: readonly string[];
    readonly authentication: 'codex-login-status' | 'claude-auth-status' | 'grok-auth-store';
  };
  readonly consumer: {
    readonly skillDirectory: string;
    readonly mcpConfigRelativePath: string;
  };
}

const profiles: readonly AgentProfile[] = [
  {
    id: 'codex',
    label: 'Codex CLI',
    executable: 'codex',
    arguments: [
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--output-schema',
      '{sheldon-output-schema-file}',
      '--output-last-message',
      '{sheldon-last-message-file}',
    ],
    appendPrompt: true,
    parser: 'codex-jsonl',
    timeoutMilliseconds: 120_000,
    envAllowlist: [],
    health: {
      versionArguments: ['--version'],
      authentication: 'codex-login-status',
    },
    consumer: {
      skillDirectory: '.codex/skills/sheldon',
      mcpConfigRelativePath: '.codex/config.toml',
    },
  },
  {
    id: 'claude',
    label: 'Claude Code',
    executable: 'claude',
    arguments: [
      '--print',
      '--permission-mode',
      'plan',
      '--output-format',
      'json',
      '--json-schema',
      '{sheldon-output-schema-json}',
    ],
    appendPrompt: true,
    parser: 'claude-json',
    timeoutMilliseconds: 120_000,
    envAllowlist: [],
    health: {
      versionArguments: ['--version'],
      authentication: 'claude-auth-status',
    },
    consumer: {
      skillDirectory: '.claude/skills/sheldon',
      mcpConfigRelativePath: '.mcp.json',
    },
  },
  {
    id: 'grok',
    label: 'Grok CLI',
    executable: 'grok',
    arguments: [
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
    ],
    appendPrompt: false,
    parser: 'grok-json',
    timeoutMilliseconds: 300_000,
    envAllowlist: ['GROK_HOME', 'XAI_API_KEY'],
    health: {
      versionArguments: ['--version'],
      authentication: 'grok-auth-store',
    },
    consumer: {
      skillDirectory: '.grok/skills/sheldon',
      mcpConfigRelativePath: '.grok/config.toml',
    },
  },
];

export function isAgentKind(value: string): value is AgentKind {
  return (AGENT_PROFILE_IDS as readonly string[]).includes(value);
}

export function requireAgentProfile(id: AgentKind): AgentProfile {
  const profile = profiles.find((entry) => entry.id === id);
  if (profile === undefined) throw new Error(`Unknown agent profile: ${id}`);
  return profile;
}

export function listAgentProfiles(): readonly AgentProfile[] {
  return profiles;
}

export function formatAgentKindList(): string {
  const ids = [...AGENT_PROFILE_IDS];
  const last = ids.pop();
  return `${ids.join(', ')}, or ${last}`;
}
