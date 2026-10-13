# Issue 49 — yt-dlp stdout maxBuffer Verification

**Verdict**: C1–C4 PASS; prettier --check FAIL
**Profile**: light
**HEAD**: `30533aa55486925488a21e0a60f3ef1d075fbe4a` (`fix(plugins): raise yt-dlp maxBuffer for YouTube ingest`)
**Round**: 3 — C1–C4 (C4 added to checklist)
**Verifier**: independent sub-agent (author != verifier)

PATH prepended: `C:\nvm4w\nodejs`. Proofs run sequentially (vitest globalSetup `npm run build` races on the native job object if parallel). Only PASS if the command exit code is 0.

No production `src` was edited.

Working tree at verify: `M .checks/issue-49-youtube-ytdlp-maxbuffer.md` (C4 added); branch `fix/youtube-ytdlp-maxbuffer` ahead of `origin/main` by 1.

## Checks

| Check    | Result | Command                                                                                                                                                                                                                                                  | Result detail                                               |
| -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| C1       | PASS   | `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "declares a yt-dlp stdout maxBuffer"`                                                                                                                                    | exit 0; 1 passed, 15 skipped (16)                           |
| C2       | PASS   | `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "accepts yt-dlp JSON stdout larger than the Node execFile default maxBuffer"`                                                                                            | exit 0; 1 passed, 15 skipped (16)                           |
| C3       | PASS   | `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "maps execFile maxBuffer overflow to YOUTUBE_RESPONSE_INVALID"`                                                                                                          | exit 0; 1 passed, 15 skipped (16)                           |
| C4       | PASS   | `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts`                                                                                                                                                                            | exit 0; 16 passed (16)                                      |
| prettier | FAIL   | `npx prettier --check packages/plugins/official/source.youtube/src/yt-dlp.ts packages/plugins/official/source.youtube/test/yt-dlp.test.ts CHANGELOG.md README.md .checks/issue-49-youtube-ytdlp-maxbuffer.md .tasks/issue-49-youtube-ytdlp-maxbuffer.md` | exit 1; `[warn] .tasks/issue-49-youtube-ytdlp-maxbuffer.md` |

No name filter matched 0 tests.

### C1

```bash
npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "declares a yt-dlp stdout maxBuffer"
```

exit 0. `✓ packages/plugins/official/source.youtube/test/yt-dlp.test.ts (16 tests | 15 skipped) 2ms`. Test Files 1 passed (1). Tests 1 passed | 15 skipped (16). Duration 7.44s. Start at 14:28:36.

### C2

```bash
npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "accepts yt-dlp JSON stdout larger than the Node execFile default maxBuffer"
```

exit 0. `✓ packages/plugins/official/source.youtube/test/yt-dlp.test.ts (16 tests | 15 skipped) 10ms`. Test Files 1 passed (1). Tests 1 passed | 15 skipped (16). Duration 7.70s. Start at 14:28:50.

### C3

```bash
npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "maps execFile maxBuffer overflow to YOUTUBE_RESPONSE_INVALID"
```

exit 0. `✓ packages/plugins/official/source.youtube/test/yt-dlp.test.ts (16 tests | 15 skipped) 4ms`. Test Files 1 passed (1). Tests 1 passed | 15 skipped (16). Duration 7.54s. Start at 14:29:03.

### C4

```bash
npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts
```

exit 0. `✓ packages/plugins/official/source.youtube/test/yt-dlp.test.ts (16 tests) 34ms`. Test Files 1 passed (1). Tests 16 passed (16). Duration 10.22s. Start at 14:29:15.

### prettier --check

```bash
npx prettier --check packages/plugins/official/source.youtube/src/yt-dlp.ts packages/plugins/official/source.youtube/test/yt-dlp.test.ts CHANGELOG.md README.md .checks/issue-49-youtube-ytdlp-maxbuffer.md .tasks/issue-49-youtube-ytdlp-maxbuffer.md
```

exit 1.

```text
Checking formatting...
[warn] .tasks/issue-49-youtube-ytdlp-maxbuffer.md
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
```

The other five paths were not warned. Verifier did not run `--write` and did not edit `src`.
