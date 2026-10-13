# Issue 49 — yt-dlp stdout maxBuffer Verification

**Verdict**: PASS
**Profile**: light
**HEAD**: 04f7a09d5d5f4c5c6a8fdc3e794fa015a4e2b790 (working tree with issue-49 changes)
**Round**: 2 — C1–C3 (C3 added to checklist)
**Verifier**: independent sub-agent (author != verifier)

PATH prepended: `C:\nvm4w\nodejs`. Proofs run sequentially (vitest globalSetup `npm run build` races on the native job object if parallel). Only PASS if the command exit code is 0.

No production `src` was edited.

## Checks

| Check | Result | Command | Result detail |
| ----- | ------ | ------- | ------------- |
| C1 | PASS | `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "declares a yt-dlp stdout maxBuffer"` | exit 0; 1 passed, 15 skipped (16) |
| C2 | PASS | `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "accepts yt-dlp JSON stdout larger than the Node execFile default maxBuffer"` | exit 0; 1 passed, 15 skipped (16) |
| C3 | PASS | `npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "maps execFile maxBuffer overflow to YOUTUBE_RESPONSE_INVALID"` | exit 0; 1 passed, 15 skipped (16) |

No name filter matched 0 tests.

### C1

```
npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "declares a yt-dlp stdout maxBuffer"
```

exit 0. `✓ packages/plugins/official/source.youtube/test/yt-dlp.test.ts (16 tests | 15 skipped) 2ms`. Test Files 1 passed (1). Tests 1 passed | 15 skipped (16). Duration 18.99s.

### C2

```
npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "accepts yt-dlp JSON stdout larger than the Node execFile default maxBuffer"
```

exit 0. `✓ packages/plugins/official/source.youtube/test/yt-dlp.test.ts (16 tests | 15 skipped) 14ms`. Test Files 1 passed (1). Tests 1 passed | 15 skipped (16). Duration 58.42s.

### C3

```
npx vitest run packages/plugins/official/source.youtube/test/yt-dlp.test.ts -t "maps execFile maxBuffer overflow to YOUTUBE_RESPONSE_INVALID"
```

exit 0. `✓ packages/plugins/official/source.youtube/test/yt-dlp.test.ts (16 tests | 15 skipped) 5ms`. Test Files 1 passed (1). Tests 1 passed | 15 skipped (16). Duration 39.09s.
