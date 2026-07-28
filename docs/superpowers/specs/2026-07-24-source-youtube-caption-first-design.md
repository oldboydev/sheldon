# Source YouTube caption-first ingestion design

## Goal

Replace the source.youtube scaffold with an optional official plugin that ingests one public YouTube video through the existing sheldon ingest url flow. It preserves yt-dlp metadata JSON as the original artifact and publishes deterministic Markdown from a usable caption.

## Scope and explicit boundaries

- Accept public YouTube video URLs in youtube.com/watch, youtu.be, youtube.com/shorts, and youtube.com/embed forms. Reject playlists, channels, mixes, credentials, fragments, and non-YouTube URLs.
- Use a user-installed yt-dlp executable only. It is never downloaded, upgraded, configured from a user configuration file, or invoked through a shell.
- Request metadata and VTT captions without downloading media. Prefer a human-provided caption for each requested language, then an automatic caption. Default preference is Portuguese then English.
- Emit exactly one original.info.json, one content.md, and the chosen VTT as an asset. Normalized metadata records canonical URI, selected track kind/language, extractor version, status, and warnings.
- Fail before publication with YOUTUBE_CAPTIONS_UNAVAILABLE when no usable captions exist. The remediation makes clear that local STT is not configured; this slice never downloads or runs STT/models.
- Keep playlists, channels, batch publication, checkpoints, cookies, credentials, paid APIs, DRM/paywall bypasses, media downloads, and local STT out of scope.

## Approaches considered

1. Extend source.url for YouTube. It would mix the page-request boundary with a volatile external extractor.
2. Add an ingest-video capability and a new CLI command. It would duplicate the generic URL publication path.
3. Retain ingest-url and give source.youtube a specialized probe with priority 200.

Approach 3 is selected. source.youtube reports confidence 100 and priority 200 for a supported video; source.url continues to handle ordinary public URLs and remains explicitly selectable.

## Components and data flow

youtube-url.ts canonicalizes supported forms to `https://www.youtube.com/watch?v=<id>`. yt-dlp.ts owns a fixed no-config/no-playlist/no-media command, private output directory, JSON parsing, safe caption discovery, and injected test runner. captions.ts selects manual before automatic tracks and removes WebVTT timing/markup without inventing text. plugin.ts validates inputs/options, materializes host-validated artifacts, and exposes yt-dlp health checks with stable YOUTUBE_* codes.

The existing URL command gains an optional --language preference string and passes it only to the selected plugin. Source publication, revisioning, and deduplication remain unchanged.

## Error handling and verification

The plugin fails closed for absent yt-dlp, spawn failures, malformed metadata, unsafe generated paths, unreadable captions, and no captions. Commands use shell: false and no cookies or credentials. All unit/plugin tests inject the runner; they make no external request. CLI acceptance proves that YouTube wins specialized selection while a normal page still selects source.url.

## Autonomous approval

The originating instruction requests autonomous progress and requires a concrete plan before code. This bounded caption-first design is approved for implementation. It intentionally does not claim the broader playlist/channel/STT requirements in PRD 003 are complete.
