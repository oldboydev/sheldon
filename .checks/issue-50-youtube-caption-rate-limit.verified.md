# Issue 50 — YouTube caption HTTP 429 Verification

**Verdict**: PASS
**Profile**: light
**Diff range**: `0a5d06c..bec8258` (same tree as `b17d2b6..93d0444`; rebased onto `origin/main` after #51 squash)
**HEAD**: `bec8258` (`fix(plugins): map YouTube caption HTTP 429 to YOUTUBE_RATE_LIMITED`)
**Round**: 1 - full
**Verifier**: independent sub-agent (author != verifier)

PATH prepended: `C:\nvm4w\nodejs`. Proofs run at HEAD in one vitest invocation. Each named `it('…')` exists (`rg`) and appears individually as **passed**.

Skipped under **light** (not forgotten): step 1 binding screens / ui, Coverage join recompute, Test policy rows, fault injection.

No production `src` was edited. No git commit. No push.

## Binding sources

Profile **light**: screen/arrangement comparison did not run.

| Source                                                      | Opened                  | Contradiction           | Uncovered        |
| ----------------------------------------------------------- | ----------------------- | ----------------------- | ---------------- |
| step 1 (screens / ui)                                       | skipped - profile light | n/a                     | n/a              |
| issue [#50](https://github.com/oldboydev/sheldon/issues/50) | yes - GitHub issue body | none vs C1–C5 / Landing | n/a (no screens) |
| `.tasks/issue-50-youtube-caption-rate-limit.md`             | yes                     | none                    | n/a              |
| checklist `.checks/issue-50-youtube-caption-rate-limit.md`  | yes                     | none marked **binding** | n/a              |

Issue #50 expected: 429 → `YOUTUBE_RATE_LIMITED` with wait-and-retry; combined `pt,en` 429 retries each language; no `--stt` fails closed; `--stt` follows local STT; tests inject runner, no network. Checks C1–C5 match those decisions.

## Checks

Named proofs confirmed via `rg` (each `it('…')` exists) and via verbose vitest at HEAD (each line **passed**). One invocation; 5 passed, 0 failed, 53 skipped by name filter.

C5 checklist filter `"maps YouTube caption rate limits"` is a prefix of `it('maps YouTube caption rate limits to a wait-and-retry remediation')` (`packages/plugin-host/test/process-runner-url-diagnostics.test.ts:107`). Vitest `-t` matched that one test.

| Check | Claim                                                                    | Proof run                                                                                                              | Evidence                                                                                                                                                                                                                                     | Result |
| ----- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1    | Combined 429 retries each requested language and returns usable captions | batched verbose vitest (Gate); `retries each requested language when the combined caption pass is rate-limited` passed | `packages/plugins/official/source.youtube/test/yt-dlp.test.ts:113` `expect(languageArgs).toEqual(['pt,en', 'pt,en', 'pt', 'en'])`; `:107-109` `toMatchObject({ captions: [{ path: englishPath, language: 'en', kind: 'automatic' }] })`      | PASS   |
| C2    | No captions, extract fails `YOUTUBE_RATE_LIMITED`                        | batched verbose vitest; `fails with YOUTUBE_RATE_LIMITED when every caption pass is rate-limited` passed               | `packages/plugins/official/source.youtube/test/yt-dlp.test.ts:124-126` `rejects.toMatchObject({ code: 'YOUTUBE_RATE_LIMITED' })`                                                                                                             | PASS   |
| C3    | Ingest without `--stt` propagates `YOUTUBE_RATE_LIMITED`                 | batched verbose vitest; `reports rate-limited captions with YOUTUBE_RATE_LIMITED` passed                               | `packages/plugins/official/source.youtube/test/plugin.test.ts:135` `rejects.toMatchObject({ code: 'YOUTUBE_RATE_LIMITED' })`                                                                                                                 | PASS   |
| C4    | Ingest with valid `--stt` follows STT after 429                          | batched verbose vitest; `falls back to local STT when caption extraction is rate-limited` passed                       | `packages/plugins/official/source.youtube/test/plugin.test.ts:173` `expect(await readFile(join(temporaryDirectory, 'content.md'), 'utf8')).toContain('fala local')` (STT stdout at `:154`)                                                   | PASS   |
| C5    | Host maps `YOUTUBE_RATE_LIMITED` with wait-and-retry recovery            | batched verbose vitest; `maps YouTube caption rate limits to a wait-and-retry remediation` passed                      | `packages/plugin-host/test/process-runner-url-diagnostics.test.ts:119-121` `code: 'YOUTUBE_RATE_LIMITED'`, `message: 'YouTube rate-limited caption extraction.'`, `recovery: 'Wait before retrying; the plugin will not loop indefinitely.'` | PASS   |

All five proofs sit in the feature diff (`0a5d06c..bec8258`). Proofs ran at `93d0444`; `git diff 93d0444 bec8258` is empty. No name filter matched 0 tests.

## Swept existing (re-read against code)

| Row                                         | Cited constraint                                                                                        | Present                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `YOUTUBE_RATE_LIMITED` mapping              | 429 / rate-limit text → plugin + host code                                                              | yes — `packages/plugins/official/source.youtube/src/yt-dlp.ts:360-382` `isRateLimitedError` (`http error 429`, `too many requests`, `rate-limit` / `rate limit`); `:211-213` maps to `youtubeError('YOUTUBE_RATE_LIMITED', …)`; `:119-123` throws that code when no pass completed; `packages/plugins/official/source.youtube/src/plugin.ts:130-131` throws when `rateLimited` and no captions and no `--stt`; `:467` / `:476-477` plugin code union + `isRateLimited`; `packages/plugin-host/src/process-runner.ts:132` diagnostic allow-list; `:878-880` host recovery |
| no sleep retry                              | Decided: no timed retry; language fallback only                                                         | yes — no `sleep` under `source.youtube`. The only `setTimeout` is `plugin.ts:259` (yt-dlp version-probe abort, unrelated). Per-language attempts are sequential `await attemptCaptionPass` (`yt-dlp.ts:104-112`), not delayed                                                                                                                                                                                                                                                                                                                                            |
| `infoJson` preserved via `rateLimited` flag | Valid JSON + 429 returns partial extraction; rejected: empty `infoJson` in plugin catch as the 429 path | yes — `yt-dlp.ts:119-122` if any pass was rate-limited, `extractionFromOutcomes(..., true)` returns the successful JSON (`:133-149` keeps `selected.infoJson` / `infoJsonBytes`, sets `rateLimited`); plugin publishes that object (`plugin.ts:306`, `:326`, `:371`, `:381`). Catch at `plugin.ts:122-128` still assigns empty `infoJson` **only** when `extractYoutubeVideo` throws (no pass completed) **and** `--stt`; that is the no-JSON case, not the rejected “empty catch instead of partial return”                                                             |

## Test policy rows

Skipped (profile light). Checklist has no `## Test policy` section.

## Faults injected

Skipped (profile light).

## Coverage join

Skipped (profile light).

## Gate

```bash
npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts packages/plugins/official/source.youtube/test/plugin.test.ts packages/plugin-host/test/process-runner-url-diagnostics.test.ts --reporter=verbose -t "retries each requested language when the combined caption pass is rate-limited|fails with YOUTUBE_RATE_LIMITED when every caption pass is rate-limited|reports rate-limited captions with YOUTUBE_RATE_LIMITED|falls back to local STT when caption extraction is rate-limited|maps YouTube caption rate limits"
```

5 passed, 0 failed (53 skipped by name filter). Named tests in output:

```text
✓ …/process-runner-url-diagnostics.test.ts > PluginProcessRunner URL diagnostics > maps YouTube caption rate limits to a wait-and-retry remediation
✓ …/plugin.test.ts > source.youtube > reports rate-limited captions with YOUTUBE_RATE_LIMITED
✓ …/plugin.test.ts > source.youtube > falls back to local STT when caption extraction is rate-limited
✓ …/yt-dlp.test.ts > extractYoutubeVideo > retries each requested language when the combined caption pass is rate-limited
✓ …/yt-dlp.test.ts > extractYoutubeVideo > fails with YOUTUBE_RATE_LIMITED when every caption pass is rate-limited
```

Test Files 3 passed (3). Tests 5 passed | 53 skipped (58). Duration 6.60s. Start at 14:44:54. Exit 0.
