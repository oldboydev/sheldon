# Issue 50 — YouTube caption HTTP 429 Verification

**Verdict**: PASS
**Profile**: light
**Diff range**: `0a5d06c..d23b553` (+ dirty `.checks/issue-50-youtube-caption-rate-limit.md` C6–C8)
**HEAD**: `d23b553` (`test: refresh issue 50 independent verification after review fixes`)
**Production HEAD**: `3e0b82d` (`fix(plugins): keep YouTube 429 language retries and source identity`)
**Round**: 3 - scoped (added publication proofs C6–C8 after Codex review)
**Previous round**: 2 at `3e0b82d` (C1–C5)
**Verifier**: independent sub-agent (author != verifier)

PATH prepended: `C:\nvm4w\nodejs`. Proofs re-run in full at this tree in **one** vitest invocation. Each named `it('…')` exists (`rg`) and appears individually as **passed**.

Skipped under **light** (not forgotten): step 1 binding screens / ui, Coverage join recompute, Test policy rows, fault injection.

No production `src` was edited. No git commit. No push.

Uncommitted at verify: `M .checks/issue-50-youtube-caption-rate-limit.md` (C6–C8 only). Production code unchanged since `3e0b82d`. C6–C8 `it('…')` bodies landed in `3e0b82d`; this round proves them against the new checklist rows.

## Binding sources

Profile **light**: screen/arrangement comparison did not run.

| Source                                                      | Opened                               | Contradiction           | Uncovered        |
| ----------------------------------------------------------- | ------------------------------------ | ----------------------- | ---------------- |
| step 1 (screens / ui)                                       | skipped - profile light              | n/a                     | n/a              |
| issue [#50](https://github.com/oldboydev/sheldon/issues/50) | yes - GitHub issue body (this round) | none vs C1–C8 / Landing | n/a (no screens) |
| `.tasks/issue-50-youtube-caption-rate-limit.md`             | yes                                  | none                    | n/a              |
| checklist `.checks/issue-50-youtube-caption-rate-limit.md`  | yes (dirty C6–C8)                    | none marked **binding** | n/a              |

Issue #50 expected: 429 → `YOUTUBE_RATE_LIMITED` with wait-and-retry; combined `pt,en` 429 retries each language and **publishes** recovered captions; no `--stt` fails closed; `--stt` follows local STT; tests inject runner, no network. C6 is the publication proof the issue criterion names. C7/C8 match Landing from `3e0b82d` (empty VTT + 429 → `YOUTUBE_RATE_LIMITED`; per-kind language retries even when the other kind already returned files).

## Checks

Named proofs confirmed via `rg` (each `it('…')` exists) and via verbose vitest at this tree (each line **passed**). One invocation; 8 passed, 0 failed, 53 skipped by name filter.

C5 checklist filter `"maps YouTube caption rate limits"` is a prefix of `it('maps YouTube caption rate limits to a wait-and-retry remediation')` (`packages/plugin-host/test/process-runner-url-diagnostics.test.ts:107`). Vitest `-t` matched that one test.

| Check | Claim                                                                                                                                        | Proof run                                                                                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                          | Result |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1    | Combined 429 retries each requested language and returns usable captions (`languageArgs` `['pt,en','pt,en','pt','en']`; cue Hello recovered) | batched verbose vitest (Gate); `retries each requested language when the combined caption pass is rate-limited` passed  | `packages/plugins/official/source.youtube/test/yt-dlp.test.ts:113` `expect(languageArgs).toEqual(['pt,en', 'pt,en', 'pt', 'en'])`; `:107-109` `toMatchObject({ captions: [{ path: englishPath, language: 'en', kind: 'automatic' }] })`; cue string is the `:83` fixture `writeFile(..., '…Hello recovered\n')` (extract asserts the recovered file, not VTT text; publication of that cue is C6) | PASS   |
| C2    | No captions, extract fails `YOUTUBE_RATE_LIMITED`                                                                                            | batched verbose vitest; `fails with YOUTUBE_RATE_LIMITED when every caption pass is rate-limited` passed                | `packages/plugins/official/source.youtube/test/yt-dlp.test.ts:172-174` `rejects.toMatchObject({ code: 'YOUTUBE_RATE_LIMITED' })`                                                                                                                                                                                                                                                                  | PASS   |
| C3    | Ingest without `--stt` propagates `YOUTUBE_RATE_LIMITED`                                                                                     | batched verbose vitest; `reports rate-limited captions with YOUTUBE_RATE_LIMITED` passed                                | `packages/plugins/official/source.youtube/test/plugin.test.ts:135` `rejects.toMatchObject({ code: 'YOUTUBE_RATE_LIMITED' })`                                                                                                                                                                                                                                                                      | PASS   |
| C4    | Ingest with valid `--stt` follows STT after 429; `fala local` and `original.info.json` keeps video id                                        | batched verbose vitest; `falls back to local STT when caption extraction is rate-limited` passed                        | `packages/plugins/official/source.youtube/test/plugin.test.ts:173` `toContain('fala local')`; `:176-178` `original.info.json` `toContain('AbCdEf12345')`                                                                                                                                                                                                                                          | PASS   |
| C5    | Host maps `YOUTUBE_RATE_LIMITED` with wait-and-retry recovery                                                                                | batched verbose vitest; `maps YouTube caption rate limits to a wait-and-retry remediation` passed                       | `packages/plugin-host/test/process-runner-url-diagnostics.test.ts:118-121` `code: 'YOUTUBE_RATE_LIMITED'`, `message: 'YouTube rate-limited caption extraction.'`, `recovery: 'Wait before retrying; the plugin will not loop indefinitely.'`                                                                                                                                                      | PASS   |
| C6    | Ingest publishes recovered caption text after combined 429 (`content.md` Hello recovered; `assets/en.automatic.vtt`)                         | batched verbose vitest; `publishes captions recovered after a combined caption pass is rate-limited` passed             | `packages/plugins/official/source.youtube/test/plugin.test.ts:216-218` `content.md` `toContain('Hello recovered')`; `:219-223` `artifacts.map(({ path }) => path)` `toEqual(['original.info.json', 'content.md', 'assets/en.automatic.vtt'])`                                                                                                                                                     | PASS   |
| C7    | Recovered VTT with no usable text fails `YOUTUBE_RATE_LIMITED`                                                                               | batched verbose vitest; `reports YOUTUBE_RATE_LIMITED when recovered caption files have no usable text` passed          | `packages/plugins/official/source.youtube/test/plugin.test.ts:259` `rejects.toMatchObject({ code: 'YOUTUBE_RATE_LIMITED' })`                                                                                                                                                                                                                                                                      | PASS   |
| C8    | Rate-limited kind still retries each language when the other kind already returned captions                                                  | batched verbose vitest; `retries a rate-limited caption kind even when the other kind already returned captions` passed | `packages/plugins/official/source.youtube/test/yt-dlp.test.ts:152-157` `toMatchObject({ captions: expect.arrayContaining([{ path: manualPath, language: 'en', kind: 'manual' }, { path: automaticPath, language: 'pt', kind: 'automatic' }]) })`; `:161` `expect(languageArgs).toEqual(['pt,en', 'pt,en', 'pt', 'en'])`                                                                           | PASS   |

All eight named proofs sit in the feature diff (`0a5d06c..3e0b82d`). C6–C8 tests were added in `3e0b82d`; checklist rows for them are the uncommitted edit. No name filter matched 0 tests.

`it('…')` hits:

```text
packages/plugins/official/source.youtube/test/yt-dlp.test.ts:80
packages/plugins/official/source.youtube/test/yt-dlp.test.ts:116
packages/plugins/official/source.youtube/test/yt-dlp.test.ts:164
packages/plugins/official/source.youtube/test/plugin.test.ts:121
packages/plugins/official/source.youtube/test/plugin.test.ts:141
packages/plugins/official/source.youtube/test/plugin.test.ts:181
packages/plugins/official/source.youtube/test/plugin.test.ts:226
packages/plugin-host/test/process-runner-url-diagnostics.test.ts:107
```

## Swept existing (re-read against code at `3e0b82d` / this tree)

Carried from round 2 at `3e0b82d`; production `src` unchanged. Line numbers re-checked this round.

| Row                                                                     | Cited constraint                                 | Present                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `YOUTUBE_RATE_LIMITED` mapping                                          | 429 / rate-limit text → plugin + host            | yes — `yt-dlp.ts:351` `isRateLimitedError`; `:113-115` throws when no pass completed; `plugin.ts:131-132` / `:143-144`; `process-runner.ts:132` allow-list; `:878-880` `recovery: 'Wait before retrying; the plugin will not loop indefinitely.'` |
| no sleep retry                                                          | language fallback only                           | yes — `yt-dlp.ts:99-107` sequential `await attemptCaptionPass`; no `sleep` under `source.youtube`                                                                                                                                                 |
| `infoJson` preserved via `rateLimited`                                  | valid JSON + 429 returns partial extraction      | yes — `yt-dlp.ts:110-115` / `:134-140`                                                                                                                                                                                                            |
| `{ id, webpage_url }` seed on STT catch                                 | catch STT without yt-dlp JSON writes identity    | yes — `plugin.ts:122` `{ id: video.id, webpage_url: video.canonicalUri }`; C4 asserts `AbCdEf12345`                                                                                                                                               |
| unusable VTT + 429 → `YOUTUBE_RATE_LIMITED`                             | empty recovered VTT fails rate-limited           | yes — `plugin.ts:141-144`; C7 asserts the code                                                                                                                                                                                                    |
| retry rate-limited kind even when the other kind already returned files | combined 429 on a kind still walks each language | yes — `yt-dlp.ts:99-107` retries a kind iff that kind’s combined outcome was rate-limited; C8 asserts both kinds + `languageArgs`                                                                                                                 |

## Test policy rows

Skipped (profile light). Checklist has no `## Test policy` section. Carried from round 1.

## Faults injected

Skipped (profile light). Carried from round 1.

## Coverage join

Skipped (profile light). Carried from round 1.

## Gate

```bash
npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts packages/plugins/official/source.youtube/test/plugin.test.ts packages/plugin-host/test/process-runner-url-diagnostics.test.ts --reporter=verbose -t "retries each requested language when the combined caption pass is rate-limited|fails with YOUTUBE_RATE_LIMITED when every caption pass is rate-limited|reports rate-limited captions with YOUTUBE_RATE_LIMITED|falls back to local STT when caption extraction is rate-limited|maps YouTube caption rate limits|publishes captions recovered after a combined caption pass is rate-limited|reports YOUTUBE_RATE_LIMITED when recovered caption files have no usable text|retries a rate-limited caption kind even when the other kind already returned captions"
```

8 passed, 0 failed (53 skipped by name filter). Named tests in output:

```text
✓ …/process-runner-url-diagnostics.test.ts > PluginProcessRunner URL diagnostics > maps YouTube caption rate limits to a wait-and-retry remediation
✓ …/plugin.test.ts > source.youtube > reports rate-limited captions with YOUTUBE_RATE_LIMITED
✓ …/plugin.test.ts > source.youtube > falls back to local STT when caption extraction is rate-limited
✓ …/plugin.test.ts > source.youtube > publishes captions recovered after a combined caption pass is rate-limited
✓ …/plugin.test.ts > source.youtube > reports YOUTUBE_RATE_LIMITED when recovered caption files have no usable text
✓ …/yt-dlp.test.ts > extractYoutubeVideo > retries each requested language when the combined caption pass is rate-limited
✓ …/yt-dlp.test.ts > extractYoutubeVideo > retries a rate-limited caption kind even when the other kind already returned captions
✓ …/yt-dlp.test.ts > extractYoutubeVideo > fails with YOUTUBE_RATE_LIMITED when every caption pass is rate-limited
```

Test Files 3 passed (3). Tests 8 passed | 53 skipped (61). Duration 8.43s. Start at 15:09:16. Exit 0.
