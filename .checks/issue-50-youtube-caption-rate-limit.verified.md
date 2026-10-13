# Issue 50 — YouTube caption HTTP 429 Verification

**Verdict**: PASS
**Profile**: light
**Diff range**: `0a5d06c..3e0b82d`
**HEAD**: `3e0b82d` (`fix(plugins): keep YouTube 429 language retries and source identity`)
**Round**: 2 - scoped (review follow-up)
**Previous round**: 1 at `93d0444` / `bec8258`
**Verifier**: independent sub-agent (author != verifier)

PATH prepended: `C:\nvm4w\nodejs`. Proofs re-run in full at this HEAD in one vitest invocation. Each named `it('…')` exists (`rg`) and appears individually as **passed**.

Skipped under **light** (not forgotten): step 1 binding screens / ui, Coverage join recompute, Test policy rows, fault injection.

No production `src` was edited. No git commit. No push.

Follow-up `3e0b82d` (vs `bec8258`) touched `yt-dlp.ts`, `plugin.ts`, the two YouTube test files, and Landing/Decided prose. `process-runner.ts` was not in that commit; C5 proof still re-ran.

## Binding sources

Profile **light**: screen/arrangement comparison did not run.

| Source                                                      | Opened                               | Contradiction           | Uncovered        |
| ----------------------------------------------------------- | ------------------------------------ | ----------------------- | ---------------- |
| step 1 (screens / ui)                                       | skipped - profile light              | n/a                     | n/a              |
| issue [#50](https://github.com/oldboydev/sheldon/issues/50) | yes - GitHub issue body (this round) | none vs C1–C5 / Landing | n/a (no screens) |
| `.tasks/issue-50-youtube-caption-rate-limit.md`             | yes (updated in `3e0b82d`)           | none                    | n/a              |
| checklist `.checks/issue-50-youtube-caption-rate-limit.md`  | yes (updated in `3e0b82d`)           | none marked **binding** | n/a              |

Issue #50 expected: 429 → `YOUTUBE_RATE_LIMITED` with wait-and-retry; combined `pt,en` 429 retries each language; no `--stt` fails closed; `--stt` follows local STT; tests inject runner, no network. Checks C1–C5 match those decisions. Landing added in `3e0b82d`: per-kind language retries even when the other kind already returned files; unusable VTT + 429 → `YOUTUBE_RATE_LIMITED`; STT catch seeds `{ id, webpage_url }`.

## Checks

Named proofs confirmed via `rg` (each `it('…')` exists) and via verbose vitest at HEAD (each line **passed**). One invocation; 5 passed, 0 failed, 56 skipped by name filter.

C5 checklist filter `"maps YouTube caption rate limits"` is a prefix of `it('maps YouTube caption rate limits to a wait-and-retry remediation')` (`packages/plugin-host/test/process-runner-url-diagnostics.test.ts:107`). Vitest `-t` matched that one test.

| Check | Claim                                                                    | Proof run                                                                                                                                                     | Evidence                                                                                                                                                                                                                                                                                                                                | Result |
| ----- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1    | Combined 429 retries each requested language and returns usable captions | batched verbose vitest (Gate); `retries each requested language when the combined caption pass is rate-limited` passed                                        | `packages/plugins/official/source.youtube/test/yt-dlp.test.ts:113` `expect(languageArgs).toEqual(['pt,en', 'pt,en', 'pt', 'en'])`; `:83` fixture `writeFile(englishPath, 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello recovered\n')`; `:107-109` `toMatchObject({ captions: [{ path: englishPath, language: 'en', kind: 'automatic' }] })` | PASS   |
| C2    | No captions, extract fails `YOUTUBE_RATE_LIMITED`                        | batched verbose vitest; `fails with YOUTUBE_RATE_LIMITED when every caption pass is rate-limited` passed                                                      | `packages/plugins/official/source.youtube/test/yt-dlp.test.ts:172-174` `rejects.toMatchObject({ code: 'YOUTUBE_RATE_LIMITED' })`                                                                                                                                                                                                        | PASS   |
| C3    | Ingest without `--stt` propagates `YOUTUBE_RATE_LIMITED`                 | batched verbose vitest; `reports rate-limited captions with YOUTUBE_RATE_LIMITED` passed                                                                      | `packages/plugins/official/source.youtube/test/plugin.test.ts:135` `rejects.toMatchObject({ code: 'YOUTUBE_RATE_LIMITED' })`                                                                                                                                                                                                            | PASS   |
| C4    | Ingest with valid `--stt` follows STT after 429; original keeps video id | batched verbose vitest; `falls back to local STT when caption extraction is rate-limited` passed                                                              | `packages/plugins/official/source.youtube/test/plugin.test.ts:154` STT stdout `'fala local'`; `:173` `toContain('fala local')`; `:176-178` `original.info.json` `toContain('AbCdEf12345')`                                                                                                                                              | PASS   |
| C5    | Host maps `YOUTUBE_RATE_LIMITED` with wait-and-retry recovery            | batched verbose vitest; `maps YouTube caption rate limits to a wait-and-retry remediation` passed (file untouched since `bec8258`; proof re-run at `3e0b82d`) | `packages/plugin-host/test/process-runner-url-diagnostics.test.ts:118-121` `code: 'YOUTUBE_RATE_LIMITED'`, `message: 'YouTube rate-limited caption extraction.'`, `recovery: 'Wait before retrying; the plugin will not loop indefinitely.'`                                                                                            | PASS   |

All five named proofs sit in the feature diff (`0a5d06c..3e0b82d`). C1 fixture cue text and C4 `original.info.json` assertion were added in `3e0b82d`. No name filter matched 0 tests.

## Swept existing (re-read against code at `3e0b82d`)

| Row                                                                     | Cited constraint                                                                                             | Present                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `YOUTUBE_RATE_LIMITED` mapping                                          | 429 / rate-limit text → plugin + host code                                                                   | yes — `packages/plugins/official/source.youtube/src/yt-dlp.ts:351-373` `isRateLimitedError` (`http error 429`, `too many requests`, `rate-limit` / `rate limit`); `:202-204` maps to `youtubeError('YOUTUBE_RATE_LIMITED', …)`; `:113-115` throws that code when no pass completed; `packages/plugins/official/source.youtube/src/plugin.ts:131-132` throws when `rateLimited` and no captions and no `--stt`; `:472` / `:481-482` plugin code union + `isRateLimited`; `packages/plugin-host/src/process-runner.ts:132` diagnostic allow-list; `:878-880` host recovery |
| no sleep retry                                                          | Decided: no timed retry; language fallback only                                                              | yes — no `sleep` under `source.youtube`. The only production `setTimeout` is `plugin.ts:264` (yt-dlp version-probe abort, unrelated). Per-language attempts are sequential `await attemptCaptionPass` (`yt-dlp.ts:104-106`), not delayed                                                                                                                                                                                                                                                                                                                                 |
| `infoJson` preserved via `rateLimited` flag                             | Valid JSON + 429 returns partial extraction; rejected: empty `infoJson` in plugin catch as the 429 path      | yes — `yt-dlp.ts:110-114` if any pass was rate-limited and a success exists, `extractionFromOutcomes(..., true)` returns it (`:134-140` keeps `selected.infoJson` / `infoJsonBytes`, sets `rateLimited`). Catch at `plugin.ts:120-129` no longer assigns empty bytes                                                                                                                                                                                                                                                                                                     |
| `{ id, webpage_url }` seed on STT catch                                 | Catch STT without yt-dlp JSON writes identity so `sourceId` does not collide                                 | yes — `plugin.ts:122` `const infoJson = { id: video.id, webpage_url: video.canonicalUri }`; `:125` encodes those bytes. C4 asserts `original.info.json` contains `AbCdEf12345`                                                                                                                                                                                                                                                                                                                                                                                           |
| unusable VTT + 429 → `YOUTUBE_RATE_LIMITED`                             | VTT without speech after 429 fails rate-limited, not captions-unavailable                                    | yes — `plugin.ts:141-144` after `selectYoutubeCaption` raises `YOUTUBE_CAPTIONS_UNAVAILABLE`, `extraction.rateLimited && !options.stt` rethrows `YOUTUBE_RATE_LIMITED`. Extract still returns file candidates (`yt-dlp.ts:112`) so selection is where emptiness is judged                                                                                                                                                                                                                                                                                                |
| retry rate-limited kind even when the other kind already returned files | Combined 429 on a kind still walks each language; presence of the other kind’s files does not skip that loop | yes — `yt-dlp.ts:99-107` retries a kind iff that kind’s combined outcome was rate-limited; there is no early return when another kind already has captions. Outcomes are concatenated (`:109`) and successes are flattened (`:137`)                                                                                                                                                                                                                                                                                                                                      |

## Test policy rows

Skipped (profile light). Checklist has no `## Test policy` section. Carried from round 1.

## Faults injected

Skipped (profile light). Carried from round 1.

## Coverage join

Skipped (profile light). Carried from round 1.

## Gate

```bash
npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts packages/plugins/official/source.youtube/test/plugin.test.ts packages/plugin-host/test/process-runner-url-diagnostics.test.ts --reporter=verbose -t "retries each requested language when the combined caption pass is rate-limited|fails with YOUTUBE_RATE_LIMITED when every caption pass is rate-limited|reports rate-limited captions with YOUTUBE_RATE_LIMITED|falls back to local STT when caption extraction is rate-limited|maps YouTube caption rate limits"
```

5 passed, 0 failed (56 skipped by name filter). Named tests in output:

```text
✓ …/process-runner-url-diagnostics.test.ts > PluginProcessRunner URL diagnostics > maps YouTube caption rate limits to a wait-and-retry remediation
✓ …/plugin.test.ts > source.youtube > reports rate-limited captions with YOUTUBE_RATE_LIMITED
✓ …/plugin.test.ts > source.youtube > falls back to local STT when caption extraction is rate-limited
✓ …/yt-dlp.test.ts > extractYoutubeVideo > retries each requested language when the combined caption pass is rate-limited
✓ …/yt-dlp.test.ts > extractYoutubeVideo > fails with YOUTUBE_RATE_LIMITED when every caption pass is rate-limited
```

Test Files 3 passed (3). Tests 5 passed | 56 skipped (61). Duration 6.21s. Start at 14:57:10. Exit 0.
