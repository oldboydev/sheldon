# Source YouTube Caption-first Ingestion Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make source.youtube ingest one public YouTube video with an installed yt-dlp executable and publish metadata plus a preferred caption transcript through sheldon ingest url.

**Architecture:** A URL boundary recognizes only single-video YouTube URLs. A yt-dlp adapter executes a fixed no-media/no-config command in a private directory and returns typed metadata/caption candidates. Caption normalization chooses manual before automatic tracks and the plugin writes one original metadata JSON, one Markdown artifact, and one caption asset. Existing URL selection and publication remain the host boundary.

**Tech Stack:** Node.js 24, TypeScript, Vitest, node:child_process execFile with shell: false, existing plugin SDK/host, user-installed yt-dlp.

## Global Constraints

- Implement one public YouTube video only; reject playlists, channels, mixes, credentials, fragments, and non-YouTube URLs.
- Do not download media, yt-dlp, an STT executable, or an STT model. Never use cookies, credentials, a shell, paid APIs, DRM/paywall bypasses, or external network tests.
- Default caption preference is pt,en. --language accepts a comma-separated preference order and is rejected by plugins that do not support it.
- Prefer manual VTT captions over automatic captions per language. No usable caption fails with YOUTUBE_CAPTIONS_UNAVAILABLE before publication and gives local-STT remediation.
- Preserve generic URL publisher revision/deduplication behavior. Emit one original.info.json, one content.md, and the chosen VTT as an asset.
- Do not modify OCR/native runtime, watchdog, signing, publishing, tags, releases, catalog version, or .superpowers/sdd/task-4-report.md. Do not push.

---

### Task 1: Define and test YouTube URL and yt-dlp boundaries

**Files:**

- Create: packages/plugins/official/source.youtube/src/youtube-url.ts
- Create: packages/plugins/official/source.youtube/src/yt-dlp.ts
- Create: packages/plugins/official/source.youtube/test/youtube-url.test.ts
- Create: packages/plugins/official/source.youtube/test/yt-dlp.test.ts

**Interfaces:**

~~~ts
export interface CanonicalYoutubeVideo { readonly id: string; readonly canonicalUri: string; }
export function canonicalYoutubeVideo(value: string): CanonicalYoutubeVideo;
export function isYoutubeVideo(value: unknown): value is string;
export interface YoutubeCaptionCandidate {
  readonly path: string; readonly language: string; readonly kind: 'manual' | 'automatic';
}
export interface YoutubeExtraction {
  readonly infoJson: Readonly<Record<string, unknown>>;
  readonly infoJsonBytes: Uint8Array;
  readonly captions: readonly YoutubeCaptionCandidate[];
  readonly ytDlpVersion: string;
}
export interface YoutubeRunner {
  run(file: string, arguments_: readonly string[], options: {
    readonly cwd: string; readonly signal: AbortSignal; readonly shell: false;
  }): Promise<{ readonly stdout: string; readonly stderr: string }>;
}
export async function extractYoutubeVideo(input: {
  readonly video: CanonicalYoutubeVideo; readonly outputDirectory: string;
  readonly languages: readonly string[]; readonly signal: AbortSignal;
}, dependencies?: { readonly executable?: string; readonly runner?: YoutubeRunner }): Promise<YoutubeExtraction>;
~~~

- [ ] **Step 1: Write failing tests**

~~~ts
expect(canonicalYoutubeVideo('https://youtu.be/AbCdEf12345?t=9')).toEqual({
  id: 'AbCdEf12345', canonicalUri: 'https://www.youtube.com/watch?v=AbCdEf12345',
});
expect(() => canonicalYoutubeVideo('https://www.youtube.com/playlist?list=PLx'))
  .toThrow('YOUTUBE_INPUT_INVALID');
await expect(extractYoutubeVideo({ video, outputDirectory, languages: ['pt', 'en'], signal }, {
  runner: fakeRunner({ stdout: '{"id":"AbCdEf12345"}\n' }),
})).resolves.toMatchObject({ infoJson: { id: 'AbCdEf12345' } });
expect(fakeRunner).toHaveBeenCalledWith('yt-dlp', expect.arrayContaining([
  '--no-config', '--no-playlist', '--skip-download', '--write-subs', '--write-auto-subs',
]), expect.objectContaining({ cwd: outputDirectory, shell: false }));
~~~

- [ ] **Step 2: Run to verify failure**

Run: npm test -- --run packages/plugins/official/source.youtube/test/youtube-url.test.ts packages/plugins/official/source.youtube/test/yt-dlp.test.ts

Expected: FAIL because these modules do not exist.

- [ ] **Step 3: Implement minimal boundaries**

Canonicalize only the listed video forms. Build a fixed command with --no-config, --no-playlist, --skip-download, --write-subs, --write-auto-subs, --sub-format vtt, ordered --sub-langs, JSON output, and a safe template under the supplied directory. Read only regular files inside that directory, classify declared manual/automatic captions, and give spawn/JSON/path failures YOUTUBE_RUNTIME_UNAVAILABLE, YOUTUBE_EXTRACTION_FAILED, or YOUTUBE_RESPONSE_INVALID code properties.

- [ ] **Step 4: Run focused tests**

Run: npm test -- --run packages/plugins/official/source.youtube/test/youtube-url.test.ts packages/plugins/official/source.youtube/test/yt-dlp.test.ts

Expected: PASS with injected runners and no network.

- [ ] **Step 5: Commit**

~~~bash
git add packages/plugins/official/source.youtube/src/youtube-url.ts packages/plugins/official/source.youtube/src/yt-dlp.ts packages/plugins/official/source.youtube/test/youtube-url.test.ts packages/plugins/official/source.youtube/test/yt-dlp.test.ts
git commit -m "feat(youtube): add bounded yt-dlp adapter"
~~~

### Task 2: Select and normalize captions deterministically

**Files:**

- Create: packages/plugins/official/source.youtube/src/captions.ts
- Create: packages/plugins/official/source.youtube/test/captions.test.ts

**Interfaces:**

~~~ts
export interface SelectedYoutubeCaption {
  readonly candidate: YoutubeCaptionCandidate; readonly text: string; readonly warnings: readonly string[];
}
export function selectYoutubeCaption(input: {
  readonly candidates: readonly YoutubeCaptionCandidate[];
  readonly languages: readonly string[];
  readonly readCaption: (path: string) => Promise<string>;
}): Promise<SelectedYoutubeCaption>;
export function normalizeYoutubeMarkdown(input: {
  readonly canonicalUri: string; readonly info: Readonly<Record<string, unknown>>;
  readonly caption: SelectedYoutubeCaption; readonly ytDlpVersion: string;
}): { readonly content: string; readonly warnings: readonly string[] };
~~~

- [ ] **Step 1: Write failing tests**

~~~ts
await expect(selectYoutubeCaption({
  candidates: [automaticPt, manualEn, manualPt], languages: ['pt', 'en'], readCaption,
})).resolves.toMatchObject({ candidate: manualPt, text: 'Primeira linha\nSegunda linha\n' });
expect(normalizeYoutubeMarkdown({
  canonicalUri, info: { title: 'Talk', description: 'Notes' }, caption, ytDlpVersion: '2026.07.01',
}).content).toContain('## Transcript');
await expect(selectYoutubeCaption({ candidates: [], languages: ['pt'], readCaption }))
  .rejects.toThrow('YOUTUBE_CAPTIONS_UNAVAILABLE');
~~~

- [ ] **Step 2: Run to verify failure**

Run: npm test -- --run packages/plugins/official/source.youtube/test/captions.test.ts

Expected: FAIL because caption selection and VTT normalization do not exist.

- [ ] **Step 3: Implement selection and normalization**

For each requested language, check manual candidates before automatic candidates and use stable path order. Parse UTF-8 WebVTT by removing headers, cue identifiers, timestamps/settings, tags, and adjacent duplicate lines; retain only text. Reject empty/unreadable tracks with YOUTUBE_CAPTIONS_UNAVAILABLE. Build Markdown with escaped title, canonical source, optional uploader/date/duration/description, caption language/kind, and transcript. Return deterministic warnings, never replacement text.

- [ ] **Step 4: Run focused tests**

Run: npm test -- --run packages/plugins/official/source.youtube/test/captions.test.ts

Expected: PASS with manual preference, automatic fallback, and actionable no-caption failure.

- [ ] **Step 5: Commit**

~~~bash
git add packages/plugins/official/source.youtube/src/captions.ts packages/plugins/official/source.youtube/test/captions.test.ts
git commit -m "feat(youtube): normalize preferred captions"
~~~

### Task 3: Replace the scaffold with a contract-valid plugin

**Files:**

- Create: packages/plugins/official/source.youtube/src/plugin.ts
- Modify: packages/plugins/official/source.youtube/src/index.ts
- Modify: packages/plugins/official/source.youtube/sheldon-plugin.json
- Create: packages/plugins/official/source.youtube/sheldon-plugin.contract.json
- Modify: packages/plugins/official/source.youtube/test/plugin.test.ts
- Modify: scripts/verify-plugin-contract.mjs
- Modify: packages/plugin-host/src/process-runner.ts
- Test: packages/plugin-host/test/process-runner.test.ts

**Interfaces:**

~~~ts
export interface OfficialSourceYoutubeDependencies {
  readonly executable?: string; readonly runner?: YoutubeRunner;
  readonly version?: () => Promise<string>;
}
export function createOfficialSourceYoutubePlugin(
  dependencies?: OfficialSourceYoutubeDependencies,
): PluginImplementation;
~~~

- [ ] **Step 1: Write failing tests**

~~~ts
const artifacts = await createOfficialSourceYoutubePlugin({ runner: fixtureRunner })
  .ingest({ input: { url: 'https://youtu.be/AbCdEf12345' }, options: {}, temporaryDirectory }, context);
expect(artifacts.map(({ path }) => path)).toEqual([
  'original.info.json', 'content.md', 'assets/pt.manual.vtt',
]);
expect(artifacts[1]?.metadata).toMatchObject({
  canonicalUri: 'https://www.youtube.com/watch?v=AbCdEf12345',
  extractor: 'yt-dlp', extractionStatus: 'complete', language: 'pt', captionKind: 'manual',
});
await expect(plugin.ingest(noCaptionRequest, context)).rejects.toThrow('YOUTUBE_CAPTIONS_UNAVAILABLE');
~~~

- [ ] **Step 2: Run to verify failure**

Run: npm test -- --run packages/plugins/official/source.youtube/test/plugin.test.ts packages/plugin-host/test/process-runner.test.ts && npm run verify:plugin-contract

Expected: FAIL because the scaffold cannot ingest and has no contract fixture.

- [ ] **Step 3: Implement plugin composition**

Put description/runPlugin entrypoint in the modular layout. Set priority 200 and add a required yt-dlp executable dependency with network true/cookies false. Validate exactly { url: string } and either {} or { language: string }; parse ordered, deduplicated tags defaulting to pt,en. Materialize metadata JSON, Markdown, and VTT with hash/size fields. Healthcheck runs a bounded version probe and has remediation. Add stable YOUTUBE_* codes to host diagnostics and a missing-runtime contract fixture that makes no network request.

- [ ] **Step 4: Run focused tests**

Run: npm test -- --run packages/plugins/official/source.youtube/test/plugin.test.ts packages/plugin-host/test/process-runner.test.ts && npm run verify:plugin-contract

Expected: PASS, including source.youtube protocol validation and diagnostic preservation.

- [ ] **Step 5: Commit**

~~~bash
git add packages/plugins/official/source.youtube packages/plugin-host/src/process-runner.ts packages/plugin-host/test/process-runner.test.ts scripts/verify-plugin-contract.mjs
git commit -m "feat(youtube): ingest captioned public videos"
~~~

### Task 4: Wire language option, documentation, and automatic selection

**Files:**

- Modify: apps/cli/src/commands/memory.ts
- Modify: apps/cli/src/main.ts
- Modify: apps/cli/test/url-ingestion-acceptance.test.ts
- Modify: README.md
- Modify: CHANGELOG.md
- Modify: docs/roadmap.md

**Interfaces:**

~~~ts
export interface UrlIngestionOptions extends VaultOption {
  readonly plugin?: string; readonly language?: string;
}
// Commander: ingest url <kind> <slug> <url> [--language <tags>] [--plugin <id>]
~~~

- [ ] **Step 1: Write failing selection and forwarding tests**

~~~ts
const youtube = await runCli([
  ...ingestArguments('https://youtu.be/AbCdEf12345'), '--language', 'en,pt',
], dependencies);
expect(youtube).toMatchObject({ exitCode: 0 });
expect(selectedYoutubeFixture.lastOptions).toEqual({ language: 'en,pt' });
const page = await runCli(ingestArguments('https://example.test/article'), dependencies);
expect(selectedUrlFixture.calls).toHaveLength(1);
~~~

- [ ] **Step 2: Run to verify failure**

Run: npm test -- --run apps/cli/test/url-ingestion-acceptance.test.ts

Expected: FAIL because --language is neither declared nor forwarded.

- [ ] **Step 3: Implement command wiring and docs**

Add --language only to ingest url and construct plugin options only when supplied. Add a YouTube-like fixture with priority 200 that declines non-YouTube URLs. Document installation of yt-dlp, the single-video/caption-first behavior, preference option, no-media/no-STT policy, and no-caption remediation. Replace stale scaffold claims in README/CHANGELOG; keep M3 in progress and list crawl, playlists/channels, local STT, and repositories as pending.

- [ ] **Step 4: Run CLI and public regression**

Run: npm test -- --run apps/cli/test/url-ingestion-acceptance.test.ts packages/plugins/official/source.url/test packages/plugins/official/source.youtube/test && npm run build && npm run verify:plugin-contract

Expected: PASS; videos select YouTube, ordinary pages select source.url, and no external request occurs.

- [ ] **Step 5: Commit**

~~~bash
git add apps/cli/src/commands/memory.ts apps/cli/src/main.ts apps/cli/test/url-ingestion-acceptance.test.ts README.md CHANGELOG.md docs/roadmap.md
git commit -m "feat(cli): route captioned YouTube videos"
~~~

### Task 5: Independent review gates and final verification

**Files:** Review only: Task 1-4 diff and .superpowers/sdd/task-4-report.md status.

- [ ] **Step 1: Run focused regression**

Run: npm test -- --run packages/plugins/official/source.youtube/test apps/cli/test/url-ingestion-acceptance.test.ts packages/plugin-host/test/process-runner.test.ts

Expected: PASS.

- [ ] **Step 2: Run static/artifact verification**

Run: npm run format:check && npm run lint && npm run typecheck && npm run lint:md && npm run build && npm run verify:plugin-contract && npm run lint:domain && npm run lint:repo && git diff --check

Expected: PASS with no paused-scope files and no change to .superpowers/sdd/task-4-report.md.

- [ ] **Step 3: Final independent review**

Inspect for shell execution, implicit downloads, cookies/credentials, playlist/channel acceptance, path escape, URL-selection ambiguity, lost stable errors, raw publication after no captions, and docs that claim full YouTube/STT support. Repair every actionable finding and repeat steps 1-2.

- [ ] **Step 4: Commit review remediation**

~~~bash
git add <only reviewer-approved source.youtube, CLI, host, test, and documentation files>
git commit -m "fix(youtube): address review findings"
~~~

## Plan self-review

Tasks 1-3 cover URL policy, no-download yt-dlp, captions, source artifacts, health, contracts, and stable diagnostics. Task 4 covers CLI selection, language configuration, and accurate public documentation. Task 5 supplies the requested independent gates. Playlist/channel batch ingestion and STT are explicitly deferred because the current single-source publisher has no checkpoint/batch model.

## Execution decision

The originating instruction requires subagents for all implementation and autonomous progress. Execute with a fresh task-level implementer, a read-only review gate after each task, and an independent final review.
