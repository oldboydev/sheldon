# Agent Registry and Grok CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex, Claude and Grok are three built-in agent profiles; `--agent grok` compiles and queries, and `mcp configure` / `install-skill` set up Grok as a scoped MCP consumer.

**Architecture:** A closed table in `@sheldon/agent-runtime` owns ids, argv, parser, timeout, env allowlist, health and consumer paths. Adapters and the executor read the table instead of `'codex' | 'claude'` branches. Grok is a row, not a special case. The host still never calls a model API.

**Tech Stack:** TypeScript, Node.js 24, Vitest, Commander, existing `JsonCommandExecutor` spawn path, `smol-toml` (already in the lockfile, BSD-3-Clause) for `.grok/config.toml` merge.

**Spec:** `docs/superpowers/specs/2026-09-16-agent-registry-and-grok-design.md`

## Global Constraints

- No direct xAI / OpenAI / Anthropic API calls; only local CLIs the user already authenticated.
- No user-configurable generic agent adapter. The registry is closed in code.
- `--agent both` stays Codex + Claude. Default `mcp install-skill` stays `both`.
- `compile` and `query` still require `--agent`. Do not invent a default agent.
- `agentVersion` stays `unknown` unless the existing executor already had a value.
- Do not read `auth.json`. Do not print `XAI_API_KEY` or secret env values.
- Grok must not write the wiki; sandbox read-only, permission plan, write/shell denylist, `wiki/` path validation remain in force.
- Existing vault JSON with `agent: "codex" | "claude"` must still load. No vault migration.
- ADR-014 already exists (README). Record this decision as **ADR-015**.
- `smol-toml` is BSD-3-Clause (OSI, already locked). Promote it to a direct `apps/cli` dependency; do not parse TOML with regex.
- Conventional Commits; update `CHANGELOG.md` Unreleased on user-facing commits; `npm run verify` before claiming done.
- Do not import `@sheldon/agent-runtime` from `apps/web/src/App.tsx` (browser bundle). Server-side `jobs.ts` may import it.

## File map

- Create: `packages/agent-runtime/src/profiles.ts` — closed profile table and guards.
- Create: `packages/agent-runtime/test/profiles.test.ts` — registry contract.
- Create: `packages/agent-runtime/test/fixtures/grok-executor-fixture.mjs` — fake Grok CLI.
- Modify: `packages/agent-runtime/src/adapters.ts` — `AgentKind` from profiles; adapters take a profile.
- Modify: `packages/agent-runtime/src/command-executor.ts` — placeholders, Grok parser, env allowlist, per-profile timeout.
- Modify: `packages/agent-runtime/src/index.ts` — export profiles and new factories.
- Modify: `packages/agent-runtime/src/runtime.ts`, `proposal-store.ts`, `query-answer.ts`, `query-answer-schema.ts` — `AgentKind` / schema enum.
- Modify: `packages/agent-runtime/test/agent-runtime.test.ts` — Grok executor, parser, schema size, Claude placeholder args.
- Modify: `apps/cli/src/commands/agents.ts`, `doctor.ts`, `memory.ts`, `query.ts`, `workflow.ts`, `mcp.ts`, `main.ts`.
- Modify: `apps/cli/package.json` — add `smol-toml`.
- Modify: `apps/web/package.json` — add `@sheldon/agent-runtime` for server-side `jobs.ts`.
- Modify: `apps/web/src/jobs.ts`, `apps/web/src/App.tsx`, `apps/web/test/jobs.test.ts`.
- Modify: CLI tests (`agents`, `m2-acceptance`, `query-acceptance`, `mcp`, `main` as needed).
- Modify: README, CHANGELOG, PRDs 004/007, architecture, vision, decisions (ADR-015), docs index.

---

### Task 1: Built-in agent profile registry

**Files:**

- Create: `packages/agent-runtime/src/profiles.ts`
- Create: `packages/agent-runtime/test/profiles.test.ts`
- Modify: `packages/agent-runtime/src/index.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `AGENT_PROFILE_IDS`, `AgentKind`, `AgentProfile`, `AgentOutputParser`, `isAgentKind`, `requireAgentProfile`, `listAgentProfiles`, `formatAgentKindList`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent-runtime/test/profiles.test.ts`
Expected: FAIL resolving `../src/profiles.js`.

- [ ] **Step 3: Write the registry**

Create `packages/agent-runtime/src/profiles.ts` with the spec table. Include:

```ts
export const AGENT_PROFILE_IDS = ['codex', 'claude', 'grok'] as const;
export type AgentKind = (typeof AGENT_PROFILE_IDS)[number];
export type AgentOutputParser = 'codex-jsonl' | 'claude-json' | 'grok-json';

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
```

Codex `envAllowlist` and Claude `envAllowlist` are empty arrays. Labels: `Codex CLI`, `Claude Code`, `Grok CLI`. Health version args are `['--version']` for all three. Codex auth `codex-login-status`, Claude `claude-auth-status`, Grok `grok-auth-store`. Codex consumer: `.codex/skills/sheldon` and `.codex/config.toml`. Claude consumer: `.claude/skills/sheldon` and `.mcp.json`.

Export the new symbols from `packages/agent-runtime/src/index.ts`. Leave `AgentKind` re-exported from `adapters.ts` until Task 2, or re-export it from `profiles.ts` immediately and delete the type in adapters in Task 2 — do not keep two `AgentKind` types.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run packages/agent-runtime/test/profiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime/src/profiles.ts packages/agent-runtime/test/profiles.test.ts packages/agent-runtime/src/index.ts
git commit -m "feat(agent-runtime): add built-in agent profile registry"
```

---

### Task 2: Derive AgentKind and query schema from the registry

**Files:**

- Modify: `packages/agent-runtime/src/adapters.ts`
- Modify: `packages/agent-runtime/src/runtime.ts`
- Modify: `packages/agent-runtime/src/proposal-store.ts`
- Modify: `packages/agent-runtime/src/query-answer.ts`
- Modify: `packages/agent-runtime/src/query-answer-schema.ts`
- Modify: `packages/agent-runtime/test/agent-runtime.test.ts`

**Interfaces:**

- Consumes: `AgentKind`, `AGENT_PROFILE_IDS`, `isAgentKind` from Task 1.
- Produces: `AgentCommand.executable: AgentKind`, `ProposalMetadata.agent: AgentKind`, `QueryAnswer.agent: AgentKind`, `queryAnswerJsonSchema.properties.agent.enum` generated from `AGENT_PROFILE_IDS`. Schema version stays `1`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/agent-runtime/test/agent-runtime.test.ts` inside the existing query persistence describe:

```ts
it('accepts grok query answers and rejects agents outside the registry', () => {
  expect(validateQueryAnswer(answer({ agent: 'grok' })).answer.agent).toBe('grok');
  expect(() => validateQueryAnswer(answer({ agent: 'cursor' as 'codex' }))).toThrow('unsupported');
});

it('publishes the registry agent enum without exceeding the Windows argv budget', () => {
  expect(queryAnswerJsonSchema.properties.agent).toEqual({
    enum: ['codex', 'claude', 'grok'],
  });
  expect(JSON.stringify(queryAnswerJsonSchema).length).toBeLessThanOrEqual(4000);
  expect(JSON.stringify(structuredProposalJsonSchema).length).toBeLessThanOrEqual(4000);
});
```

Import `structuredProposalJsonSchema` if the test file does not already.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent-runtime/test/agent-runtime.test.ts`
Expected: FAIL on grok acceptance and/or enum `['codex', 'claude']`.

- [ ] **Step 3: Replace the unions**

In `adapters.ts`, delete `export type AgentKind = 'codex' | 'claude'` and `import type { AgentKind } from './profiles.js'` (or re-export `export type { AgentKind } from './profiles.js'`). Change:

```ts
export interface AgentCommand {
  readonly executable: AgentKind;
  // ...unchanged fields
}
```

Same for `QueryAgentCommand.executable`.

`proposal-store.ts`: `readonly agent: AgentKind` (import from profiles).

`runtime.ts` `metadata(..., agent: AgentKind, ...)`.

`query-answer.ts`: `readonly agent: AgentKind` and:

```ts
if (!isAgentKind(answer.agent)) {
  issues.push('The query answer agent is unsupported.');
}
```

`query-answer-schema.ts`:

```ts
import { AGENT_PROFILE_IDS } from './profiles.js';
// ...
agent: { enum: [...AGENT_PROFILE_IDS] },
```

Keep `QUERY_ANSWER_SCHEMA_VERSION` at `1`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run packages/agent-runtime/test/agent-runtime.test.ts packages/agent-runtime/test/profiles.test.ts`
Expected: PASS. Existing Codex/Claude fixtures still load.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime/src packages/agent-runtime/test/agent-runtime.test.ts
git commit -m "feat(agent-runtime): derive agent kind from the profile registry"
```

---

### Task 3: Executor placeholders, Grok parser, and env allowlist

**Files:**

- Create: `packages/agent-runtime/test/fixtures/grok-executor-fixture.mjs`
- Modify: `packages/agent-runtime/src/command-executor.ts`
- Modify: `packages/agent-runtime/test/agent-runtime.test.ts`

**Interfaces:**

- Consumes: `requireAgentProfile`, `AgentKind`, profile `parser` / `appendPrompt` / `timeoutMilliseconds` / `envAllowlist`.
- Produces: `JsonCommandExecutor` substitutes `{sheldon-output-schema-json}` and `{sheldon-prompt-file}`; Grok parser reads `structuredOutput` then `structured_output` then JSON `text` and never treats the envelope root as the payload; child env = current PATH/locale keys plus `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `TMP`, `TEMP` plus the profile allowlist; constructor `timeoutMilliseconds` remains an override, otherwise the profile timeout is used; `executables` is `Partial<Record<AgentKind, { executable: string; arguments?: readonly string[] }>>`.

- [ ] **Step 1: Write the Grok fixture and failing tests**

`packages/agent-runtime/test/fixtures/grok-executor-fixture.mjs`:

```js
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const promptFile = args.indexOf('--prompt-file');
const schemaFlag = args.indexOf('--json-schema');
const sandbox = args.indexOf('--sandbox');

if (promptFile < 0 || schemaFlag < 0 || args[sandbox + 1] !== 'read-only') {
  process.exit(2);
}
if (args.includes('--')) process.exit(3);
if (process.env.SECRET_TOKEN) process.exit(4);

const prompt = await readFile(args[promptFile + 1], 'utf8');
const schema = JSON.parse(args[schemaFlag + 1]);
const proposal = {
  schemaVersion: 1,
  id: 'proposal-001',
  sources: [{ rawPath: 'raw/source-001/content.md', citation: 'Lines 1-3' }],
  files: [
    {
      path: 'wiki/concepts/example.md',
      operation: 'create',
      content: [
        process.env.XAI_API_KEY ? 'xai-forwarded' : 'xai-missing',
        process.env.USERPROFILE || process.env.HOME ? 'home-forwarded' : 'home-missing',
        prompt.includes('Turn the cited raw') ? 'prompt-file-used' : 'prompt-missing',
        schema.$id === 'sheldon-proposal/v1' ? 'schema-inline-used' : 'schema-missing',
      ].join('\n'),
      citations: ['raw/source-001/content.md'],
    },
  ],
};
const envelope = {
  text: JSON.stringify(proposal),
  stopReason: 'end_turn',
  structuredOutput: proposal,
};
if (prompt.includes('missing-payload')) {
  process.stdout.write(JSON.stringify({ text: 'not-json', stopReason: 'end_turn' }));
} else {
  process.stdout.write(JSON.stringify(envelope));
}
```

Add tests to `command adapters and runtime` in `agent-runtime.test.ts`:

```ts
it('runs grok through prompt-file, inline schema, and structuredOutput without leaking secrets', async () => {
  const executor = new JsonCommandExecutor({
    executables: { grok: { executable: process.execPath, arguments: [grokExecutorFixture] } },
    environment: {
      PATH: process.env.PATH,
      USERPROFILE: process.env.USERPROFILE ?? 'C:\\Users\\sheldon',
      HOME: process.env.HOME ?? '/home/sheldon',
      XAI_API_KEY: 'xai-test',
      SECRET_TOKEN: 'must-not-be-forwarded',
    },
  });

  await expect(createGrokCommandAdapter(executor).execute(task)).resolves.toMatchObject({
    status: 'proposal',
    proposal: {
      files: [{ content: expect.stringContaining('xai-forwarded') }],
    },
  });
  await expect(createGrokCommandAdapter(executor).execute(task)).resolves.toMatchObject({
    proposal: { files: [{ content: expect.stringContaining('home-forwarded') }] },
  });
  await expect(createGrokCommandAdapter(executor).execute(task)).resolves.toMatchObject({
    proposal: { files: [{ content: expect.stringContaining('prompt-file-used') }] },
  });
  await expect(
    createGrokCommandAdapter(executor).execute({ ...task, prompt: 'missing-payload' }),
  ).resolves.toEqual({
    status: 'error',
    message: 'The agent command did not produce a valid proposal.',
  });
});
```

`createGrokCommandAdapter` will not exist yet — that is the intended red. Point `grokExecutorFixture` at the new fixture URL the same way `commandExecutorFixture` is resolved.

If Task 4 has not exported `createGrokCommandAdapter` yet, call `createCommandAdapter(requireAgentProfile('grok'), executor)` instead and export `createCommandAdapter` in this task. Prefer exporting both here if adapters still take `kind`; otherwise wait until Task 4 and keep this test using `createCommandAdapter` after you temporarily teach adapters to accept `'grok'` via profile lookup.

Practical order for this task: keep `createCodexCommandAdapter` working; add Grok execution by looking up `requireAgentProfile(command.executable)` inside the executor even before adapter factories change. For the test, construct the adapter as:

```ts
const grokAdapter: AgentAdapter = {
  kind: 'grok',
  execute: (current, options) =>
    executor.execute(
      {
        executable: 'grok',
        arguments: requireAgentProfile('grok').arguments,
        prompt: current.prompt,
        input: current,
        outputSchema: structuredProposalJsonSchema,
      },
      options,
    ),
};
```

Replace that inline adapter with `createGrokCommandAdapter` in Task 4.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent-runtime/test/agent-runtime.test.ts`
Expected: FAIL (Grok executable not in executor map type, parser does not read `structuredOutput`, or env not forwarded).

- [ ] **Step 3: Implement executor changes**

In `command-executor.ts`:

1. `executables` keyed by `AgentKind`.
2. `timeoutMilliseconds` optional override. If omitted, use `requireAgentProfile(command.executable).timeoutMilliseconds`.
3. Write `prompt.txt` next to the schema file when `{sheldon-prompt-file}` appears.
4. Substitute placeholders:

```ts
argument === '{sheldon-output-schema-file}'
  ? schemaFile
  : argument === '{sheldon-last-message-file}'
    ? lastMessageFile
    : argument === '{sheldon-output-schema-json}'
      ? JSON.stringify(command.outputSchema)
      : argument === '{sheldon-prompt-file}'
        ? promptFile
        : argument;
```

1. After mapping arguments, if `requireAgentProfile(command.executable).appendPrompt` then push `'--', command.prompt`. Grok does not append.
2. Env: start from today's keys, add `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `TMP`, `TEMP`, then copy each key in the profile `envAllowlist` when present. Never copy `SECRET_TOKEN`.
3. Parse:

```ts
function parseGrokResponse<T>(
  output: string,
  parse: (value: unknown) => T | undefined,
): T | undefined {
  const result = parseJsonObject(output);
  if (result === undefined) return undefined;
  if (isRecord(result.structuredOutput)) return parse(result.structuredOutput);
  if (isRecord(result.structured_output)) return parse(result.structured_output);
  if (typeof result.text === 'string') return parse(result.text);
  return undefined;
}
```

Do **not** `parse(result)` for Grok. Switch on `requireAgentProfile(kind).parser` (`codex-jsonl` | `claude-json` | `grok-json`). Keep Claude `parse(structured_output) ?? parse(result) ?? parse(result)` behavior unchanged.

Existing Codex secret test must still resolve `content: 'schema-file-used'` (secret not forwarded).

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run packages/agent-runtime/test/agent-runtime.test.ts`
Expected: PASS, including the existing Codex sanitization test.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime/src/command-executor.ts packages/agent-runtime/test
git commit -m "feat(agent-runtime): execute grok with structuredOutput parsing"
```

---

### Task 4: Adapters read profiles

**Files:**

- Modify: `packages/agent-runtime/src/adapters.ts`
- Modify: `packages/agent-runtime/src/index.ts`
- Modify: `packages/agent-runtime/test/agent-runtime.test.ts`

**Interfaces:**

- Consumes: `AgentProfile`, `requireAgentProfile` from Task 1; executor from Task 3.
- Produces: `createCommandAdapter(profile, executor)`, `createQueryCommandAdapter(profile, executor)`, `createGrokCommandAdapter`, `createGrokQueryAdapter`. Existing Codex/Claude factories become one-line wrappers. `commandArguments(kind, schema)` is deleted.

- [ ] **Step 1: Write the failing test**

Update the existing test `builds real Codex and Claude structured-output commands...` so Claude arguments contain `{sheldon-output-schema-json}` instead of inline JSON. Add:

```ts
it('builds grok compile and query commands from the grok profile', async () => {
  const commands: AgentCommand[] = [];
  const queryCommands: QueryAgentCommand[] = [];
  const executor: CommandExecutor = {
    execute: async (command) => {
      commands.push(command);
      return { status: 'proposal', proposal: proposal(), agentVersion: 'fixture-1.0' };
    },
    executeQuery: async (command) => {
      queryCommands.push(command);
      return { status: 'answer', answer: answer({ agent: 'grok' }), agentVersion: 'fixture-1.0' };
    },
  };

  await createGrokCommandAdapter(executor).execute(task);
  await createGrokQueryAdapter(executor).execute(queryTask);
  expect(commands[0]?.executable).toBe('grok');
  expect(commands[0]?.arguments).toEqual(requireAgentProfile('grok').arguments);
  expect(queryCommands[0]?.arguments).toEqual(requireAgentProfile('grok').arguments);
  expect(commands[0]?.arguments).not.toContain('--');
});
```

Also replace the inline Grok adapter from Task 3 with `createGrokCommandAdapter`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent-runtime/test/agent-runtime.test.ts`
Expected: FAIL on missing `createGrokCommandAdapter` or Claude still interpolating JSON in `arguments`.

- [ ] **Step 3: Implement adapters**

```ts
export function createCommandAdapter(
  profile: AgentProfile,
  executor: CommandExecutor,
): AgentAdapter {
  return {
    kind: profile.id,
    execute: (task, options) =>
      executor.execute(
        {
          executable: profile.executable,
          arguments: profile.arguments,
          prompt: renderPrompt(task),
          input: task,
          outputSchema: structuredProposalJsonSchema,
        },
        options,
      ),
  };
}

export function createCodexCommandAdapter(executor: CommandExecutor): AgentAdapter {
  return createCommandAdapter(requireAgentProfile('codex'), executor);
}
export function createClaudeCommandAdapter(executor: CommandExecutor): AgentAdapter {
  return createCommandAdapter(requireAgentProfile('claude'), executor);
}
export function createGrokCommandAdapter(executor: CommandExecutor): AgentAdapter {
  return createCommandAdapter(requireAgentProfile('grok'), executor);
}
```

Same pattern for query adapters with `queryAnswerJsonSchema`. Delete `commandArguments`. Export the new functions and `createCommandAdapter` / `createQueryCommandAdapter` from `index.ts`.

Update the Claude query-command assertion to expect `{sheldon-output-schema-json}` rather than `JSON.stringify(queryAnswerJsonSchema)`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run packages/agent-runtime`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime/src/adapters.ts packages/agent-runtime/src/index.ts packages/agent-runtime/test/agent-runtime.test.ts
git commit -m "feat(agent-runtime): build agent commands from profiles"
```

---

### Task 5: CLI worker surface — compile, query, doctor

**Files:**

- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/commands/agents.ts`
- Modify: `apps/cli/src/commands/doctor.ts`
- Modify: `apps/cli/src/commands/memory.ts`
- Modify: `apps/cli/src/commands/query.ts`
- Modify: `apps/cli/src/commands/workflow.ts`
- Modify: `apps/cli/test/agents.test.ts`
- Modify: `apps/cli/test/m2-acceptance.test.ts`
- Modify: `apps/cli/test/query-acceptance.test.ts`
- Modify: `apps/cli/test/main.test.ts` if it asserts `--agent` errors

**Interfaces:**

- Consumes: `isAgentKind`, `formatAgentKindList`, `requireAgentProfile`, `createCommandAdapter`, `createQueryCommandAdapter`, `AgentKind`.
- Produces: `--agent grok` accepted for compile / compile-retry / query / `agent doctor`; `--agent cursor` errors with `codex, claude, or grok`; `sheldon doctor` reports Grok CLI; Grok health uses `--version` plus auth-store / `XAI_API_KEY` without printing secrets; `promoteAnswer` uses `requireAgentProfile(answer.agent)`.

- [ ] **Step 1: Write the failing tests**

`apps/cli/test/agents.test.ts` — extend the injected probe test so a third Grok result is printed, and add:

```ts
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
```

`m2-acceptance.test.ts`: in `fakeExecutor`, title `command.executable === 'grok' ? 'Grok concept' : ...`. After the Claude compile, run `--agent grok` with id `grok-proposal` and expect `metadata.agent === 'grok'`.

`query-acceptance.test.ts`: copy the successful cited-query case (the one that uses `--agent claude` or `codex` and persists an answer) with `--agent grok` and `agent: 'grok'` in the fake executor output.

Add a CLI parse test (in `main.test.ts` if that is where Commander errors are asserted, otherwise `agents.test.ts`):

```ts
it('rejects unknown compile agents with the registry list', async () => {
  const result = await runCli([
    'compile',
    'topic',
    'memory',
    'p1',
    '--agent',
    'cursor',
    '--prompt',
    'x',
    '--raw',
    'raw/a/content.md',
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain('codex, claude, or grok');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/cli/test/agents.test.ts apps/cli/test/m2-acceptance.test.ts apps/cli/test/query-acceptance.test.ts apps/cli/test/main.test.ts`
Expected: FAIL (`Agent must be codex or claude`, Grok doctor unknown).

- [ ] **Step 3: Implement CLI wiring**

`main.ts` `agentKind`:

```ts
function agentKind(value: string): AgentKind {
  if (isAgentKind(value)) return value;
  throw new InvalidArgumentError(`Agent must be ${formatAgentKindList()}.`);
}
```

Use it for compile, compile-retry, query, and `agent doctor [agent]`. Help strings: `agent that writes the cited answer (${formatAgentKindList()})`. Remove the duplicated `if (options.agent !== 'codex' && options.agent !== 'claude')` blocks.

`agents.ts`: `AgentName` becomes `AgentKind`. `doctorAgents` iterates `listAgentProfiles()` when no name is passed. Labels from `profile.label`. Missing binary recovery: `install ${profile.executable}` and, for Grok, mention `%USERPROFILE%\\.grok\\bin` on win32. Auth: switch on `profile.health.authentication`. For `grok-auth-store`:

```ts
const grokHome = environment.GROK_HOME ?? join(homedir(), '.grok');
const hasKey = (environment.XAI_API_KEY ?? '').trim().length > 0;
const hasStore = await exists(join(grokHome, 'auth.json')); // access only
return { available: true, version, authenticated: hasKey || hasStore };
```

Never read the file. Never write the key or path into `context.write`.

`doctor.ts`: also `commandAvailable('grok')` and `Grok CLI: available | not found (warning)`.

`memory.ts` compile:

```ts
const adapter = createCommandAdapter(requireAgentProfile(options.agent), executor);
```

Delete the `options.agent === 'codex' ? createCodex... : createClaude...` branch.

`query.ts` `answerFromAgent` and `promoteAnswer`: same, using `createQueryCommandAdapter` / `createCommandAdapter` with `requireAgentProfile(options.agent)` or `requireAgentProfile(answer.agent)`.

`workflow.ts`: `agent: AgentKind`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run apps/cli/test/agents.test.ts apps/cli/test/m2-acceptance.test.ts apps/cli/test/query-acceptance.test.ts apps/cli/test/main.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src apps/cli/test
git commit -m "feat(cli): accept grok as a compile and query agent"
```

---

### Task 6: Grok MCP consumer and skill

**Files:**

- Modify: `apps/cli/package.json` (direct dependency `smol-toml`, same version as the lockfile: `1.7.0`)
- Modify: `apps/cli/src/commands/mcp.ts`
- Modify: `apps/cli/src/main.ts` (`install-skill --agent`)
- Modify: `apps/cli/test/mcp.test.ts`

**Interfaces:**

- Consumes: `requireAgentProfile('grok').consumer`, skill source already used for Codex/Claude.
- Produces: `mcp configure` preview/apply merges `[mcp_servers.sheldon]` into `<consumer>/.grok/config.toml`; existing unrelated TOML keys survive; conflicting `mcp_servers.sheldon` is refused; unreadable TOML is refused; rollback restores original bytes; `install-skill --agent grok` and `--agent all`; `--agent both` still only Codex+Claude and remains the default; `mcp doctor` warns on missing Grok config/skill without failing.

- [ ] **Step 1: Write the failing tests**

Add to `apps/cli/test/mcp.test.ts`:

```ts
it('previews and applies a grok MCP config without touching an unrelated toml key', async () => {
  const { vault, consumer } = await fixture();
  await mkdir(join(consumer, '.grok'), { recursive: true });
  await writeFile(join(consumer, '.grok', 'config.toml'), 'theme = "dark"\n', 'utf8');
  const args = [
    'mcp',
    'configure',
    consumer,
    '--vault',
    vault,
    '--consumer-id',
    'consumer-a',
    '--scope',
    'project:alpha',
  ];
  const preview = await runCli(args);
  expect(preview.exitCode).toBe(0);
  expect(preview.stdout).toContain('.grok');
  expect(await readFile(join(consumer, '.grok', 'config.toml'), 'utf8')).toBe('theme = "dark"\n');

  const applied = await runCli([...args, '--apply']);
  expect(applied.exitCode).toBe(0);
  const grok = await readFile(join(consumer, '.grok', 'config.toml'), 'utf8');
  expect(grok).toContain('theme');
  expect(grok).toContain('mcp_servers');
  expect(grok).toContain('sheldon');
  expect(grok).toContain('mcp');
  expect(grok).toContain('serve');
});

it('refuses a conflicting grok sheldon MCP server and leaves consumer yaml unwritten', async () => {
  const { vault, consumer } = await fixture();
  await mkdir(join(consumer, '.grok'), { recursive: true });
  await writeFile(
    join(consumer, '.grok', 'config.toml'),
    '[mcp_servers.sheldon]\ncommand = "other"\n',
    'utf8',
  );
  const result = await runCli([
    'mcp',
    'configure',
    consumer,
    '--vault',
    vault,
    '--consumer-id',
    'consumer-a',
    '--scope',
    'project:alpha',
    '--apply',
  ]);
  expect(result.exitCode).toBe(1);
  await expect(access(join(consumer, '.sheldon', 'mcp.yaml'))).rejects.toThrow();
});

it('installs the sheldon skill for grok and for all agents', async () => {
  const { vault, consumer } = await fixture();
  await runCli([
    'mcp',
    'configure',
    consumer,
    '--vault',
    vault,
    '--consumer-id',
    'consumer-a',
    '--scope',
    'project:alpha',
    '--apply',
  ]);
  const grokOnly = await runCli(['mcp', 'install-skill', consumer, '--agent', 'grok', '--apply']);
  expect(grokOnly.exitCode).toBe(0);
  await access(join(consumer, '.grok', 'skills', 'sheldon', 'SKILL.md'));
  await expect(access(join(consumer, '.codex', 'skills', 'sheldon', 'SKILL.md'))).rejects.toThrow();

  const { consumer: other } = await fixture();
  await runCli([
    'mcp',
    'configure',
    other,
    '--vault',
    vault,
    '--consumer-id',
    'consumer-b',
    '--scope',
    'project:alpha',
    '--apply',
  ]);
  const all = await runCli(['mcp', 'install-skill', other, '--agent', 'all', '--apply']);
  expect(all.exitCode).toBe(0);
  await access(join(other, '.codex', 'skills', 'sheldon', 'SKILL.md'));
  await access(join(other, '.claude', 'skills', 'sheldon', 'SKILL.md'));
  await access(join(other, '.grok', 'skills', 'sheldon', 'SKILL.md'));
});
```

Update the existing preview/apply test to also expect `.grok/config.toml` after `--apply`. Update the existing default `install-skill --apply` test so it still only creates Codex+Claude skills (not Grok). Extend `mcp doctor` assertions with `Grok project config` and `Grok skill` warning lines.

Add a rollback test: pre-write `.grok/config.toml` with `theme = "dark"`, force a later write to fail the same way the Claude rollback test does (`.codex` as a file), expect the grok file bytes restored to `theme = "dark"\n`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/cli/test/mcp.test.ts`
Expected: FAIL (no `.grok/config.toml`, `--agent grok` invalid).

- [ ] **Step 3: Implement configure / skill / doctor**

`npm install smol-toml@1.7.0 --workspace @sheldon/cli` (do not invent a different version).

`import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';`

Merge function (Claude-style, TOML): parse existing file if present; if `mcp_servers` is not a table, refuse; if `mcp_servers.sheldon` exists and `command`/`args` differ from expected, refuse; if TOML throws, refuse with `Refusing to overwrite unreadable Grok configuration`; otherwise spread remaining keys and set `mcp_servers.sheldon = { command: 'sheldon', args: ['mcp', 'serve', '--consumer-config', consumerMcpConfigPath(consumer)] }`. Create the file when absent.

Do **not** add the Grok path to `assertConfigurationTargetsWritable` (merge is allowed). Keep Codex refuse-if-exists.

Include the Grok path in the preview `changes` array. Persist original bytes and restore them in `rollbackConfigure` (delete if the file did not exist).

`McpInstallSkillOptions.agent`: `AgentKind | 'both' | 'all'`. Commander:

```ts
if (value === 'both' || value === 'all' || isAgentKind(value)) return value;
throw new InvalidArgumentError('--agent must be codex, claude, grok, both, or all.');
```

Default remains `both`.

```ts
function skillTargets(consumer: string, agent: AgentKind | 'both' | 'all'): readonly string[] {
  const pathFor = (id: AgentKind) =>
    join(consumer, requireAgentProfile(id).consumer.skillDirectory);
  if (agent === 'all') return AGENT_PROFILE_IDS.map(pathFor);
  if (agent === 'both') return [pathFor('codex'), pathFor('claude')];
  return [pathFor(agent)];
}
```

`doctorMcp`: check Grok config by parsing TOML and comparing `command`/`args` like Claude; check `join(root, '.grok', 'skills', 'sheldon', 'SKILL.md')`; print the two warning lines from the spec. Do not fail when Grok is missing.

Do not spawn `grok mcp add`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run apps/cli/test/mcp.test.ts`
Expected: PASS. Default install-skill still omits `.grok/skills`.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/package.json package-lock.json apps/cli/src/commands/mcp.ts apps/cli/src/main.ts apps/cli/test/mcp.test.ts
git commit -m "feat(cli): configure grok as a scoped MCP consumer"
```

---

### Task 7: Local web compile/query agent select

**Files:**

- Modify: `apps/web/package.json` — dependency `@sheldon/agent-runtime: "*"`
- Modify: `apps/web/src/jobs.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/test/jobs.test.ts`

**Interfaces:**

- Consumes: `isAgentKind`, `AgentKind` on the **server** only.
- Produces: `WebJobRequest` compile/query `agent: AgentKind`; `validAgent` delegates to `isAgentKind`; query form lists Codex, Claude, Grok; default remains Codex.

- [ ] **Step 1: Write the failing test**

```ts
it('accepts grok compile jobs and rejects unknown agents', async () => {
  const root = await vault();
  const jobs = new WebJobService(root, async () => undefined);
  expect(
    jobs.enqueue({
      type: 'compile',
      kind: 'topic',
      slug: 'memory',
      proposalId: 'p1',
      agent: 'grok',
      prompt: 'compile',
      raw: ['raw/a/content.md'],
    }).payload,
  ).toMatchObject({ agent: 'grok' });
  expect(() =>
    jobs.enqueue({
      type: 'compile',
      kind: 'topic',
      slug: 'memory',
      proposalId: 'p1',
      agent: 'cursor',
      prompt: 'compile',
      raw: ['raw/a/content.md'],
    }),
  ).toThrow('não segue o contrato');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/test/jobs.test.ts`
Expected: FAIL (`validAgent` rejects `grok`).

- [ ] **Step 3: Implement**

Add `@sheldon/agent-runtime` to `apps/web/package.json` dependencies.

`jobs.ts`:

```ts
import { isAgentKind, type AgentKind } from '@sheldon/agent-runtime';
// WebJobRequest compile/query agent: AgentKind
function validAgent(value: unknown): value is AgentKind {
  return typeof value === 'string' && isAgentKind(value);
}
```

`App.tsx` query form: add `<option value="grok">Grok</option>`. State type `'codex' | 'claude' | 'grok'` (literal union is acceptable in the UI file; do not import the runtime package into the client module). Default stays `'codex'`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run apps/web/test/jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/src/jobs.ts apps/web/src/App.tsx apps/web/test/jobs.test.ts
git commit -m "feat(web): accept grok as a local job agent"
```

---

### Task 8: Documentation, ADR-015, and verify

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/prds/004-agent-runtime-and-review.md`
- Modify: `docs/prds/007-agent-integration-mcp-and-skill.md`
- Modify: `docs/product/architecture.md`
- Modify: `docs/product/vision.md`
- Modify: `docs/product/decisions.md`
- Modify: `docs/README.md` (link this plan)

**Interfaces:**

- Consumes: the behavior shipped in Tasks 1–7.
- Produces: user-facing docs that list Grok as an optional local CLI equivalent to Codex/Claude; ADR-015; `npm run verify` green; no remaining product union `'codex' | 'claude'` for agents except skill alias `both` and historical fixture JSON.

- [ ] **Step 1: Write the documentation changes**

README compile example: keep `--agent codex` as the shown default. Add one sentence: `Substitua codex por claude ou grok se preferir.` MCP section: `sheldon mcp configure` also writes `.grok/config.toml`; `sheldon mcp install-skill <consumer> --agent grok` (or `--agent all`) installs `.grok/skills/sheldon`. `--agent both` remains Codex + Claude.

CHANGELOG Unreleased Added: Grok CLI as a third local agent for compile/query and as an MCP/skill consumer, via a built-in profile registry.

PRD 004: workers are Codex CLI, Claude Code, and Grok CLI. Still no direct model APIs.

PRD 007: consumer files include `.grok/config.toml` and `.grok/skills/sheldon`. `--agent both` unchanged; `all` includes Grok.

architecture.md Agent runtime: three equivalent CLI adapters from a profile table. vision.md: “Codex CLI, Claude Code ou Grok CLI”; principle 3 names Grok as an optional compiler CLI, not an xAI API. Audience sentence can stay Windows-first; do not make Grok required.

decisions.md **ADR-015 — Built-in agent profiles**:

- Decision: closed in-code registry; Grok is a profile row; no generic user-defined CLI adapter in this slice.
- Reason: `'codex' | 'claude'` was already copied across runtime, CLI, web and MCP; a third agent must not copy it again.
- Alternative rejected: add `'grok'` to every union; rejected because the fourth agent repeats the tax.

docs/README.md: add this plan next to the spec link.

Grep the repo for `'codex' | 'claude'` in `apps/` and `packages/` (exclude tests that load historical JSON and the skill alias `'both'`). Replace remaining product unions with `AgentKind`.

- [ ] **Step 2: Run documentation-sensitive tests if any exist, then the full gate**

Run: `npm run verify`
Expected: PASS (format, lint, typecheck, markdown, tests, coverage, build, plugin contract, domain, repo policy, `git diff --check`).

If `lint:repo` requires changelog/README on the same commit as behavior, and those files were not in Tasks 5–7, this commit is the one that satisfies the policy for the user-facing slice. If a previous commit already shipped CLI behavior without README, fold the README/changelog into that commit only if you are still amending unpushed work; otherwise this docs commit is the required follow-up and must include the changelog.

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md docs apps packages
git commit -m "docs(agent-runtime): document grok profiles and mcp consumer"
```

Do not run a live `grok -p` in CI. The fixture is the contract. A local optional smoke (`grok --version` plus `sheldon agent doctor grok`) is fine and must be skipped when `grok` is missing.

---

## Spec coverage

| Spec requirement                                       | Task    |
| ------------------------------------------------------ | ------- |
| Profile table / `AgentKind` derived                    | 1, 2    |
| Grok worker argv, parser, timeout 300s                 | 1, 3, 4 |
| Env allowlist + home/temp + no secret leak             | 3       |
| Schema enum + 4000-byte argv gate                      | 2       |
| Existing `codex`/`claude` JSON still loads             | 2       |
| `--agent grok` compile/query/doctor                    | 5       |
| `--agent both` unchanged; `all` added                  | 6       |
| Grok MCP merge + rollback + skill                      | 6       |
| Web select + job validation                            | 7       |
| README, changelog, PRDs, ADR-015, architecture, vision | 8       |
| `npm run verify`                                       | 8       |
| No product `'codex' \| 'claude'` union left            | 8       |
| Live Grok optional / CI uses fixture                   | 3, 8    |

## Placeholder / consistency notes

- Spec said ADR-014; the repo already has ADR-014 (README). This plan writes **ADR-015**.
- Spec said `smol-toml` is MIT; the locked copy is **BSD-3-Clause**. Still OSI-compatible (ADR-010). Use 1.7.0 from the lockfile.
- `createCommandAdapter` in Task 4 takes `AgentProfile`, matching the spec. Task 3 may use an inline adapter until that factory exists.
- Claude `AgentCommand.arguments` after Task 4 contain `{sheldon-output-schema-json}`, not the interpolated schema string. The executor interpolates.
