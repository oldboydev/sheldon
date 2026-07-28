import type { YoutubeCaptionCandidate } from './yt-dlp.js';
import { normalizeYoutubeLanguageTag } from './languages.js';

export interface SelectedYoutubeCaption {
  readonly candidate: YoutubeCaptionCandidate;
  readonly text: string;
  readonly warnings: readonly string[];
}

export interface SelectYoutubeCaptionInput {
  readonly candidates: readonly YoutubeCaptionCandidate[];
  readonly languages: readonly string[];
  readonly readCaption: (path: string) => Promise<string>;
}

export interface NormalizeYoutubeMarkdownInput {
  readonly canonicalUri: string;
  readonly info: Readonly<Record<string, unknown>>;
  readonly caption: SelectedYoutubeCaption;
  readonly ytDlpVersion: string;
}

export async function selectYoutubeCaption(
  input: SelectYoutubeCaptionInput,
): Promise<SelectedYoutubeCaption> {
  const warnings: string[] = [];
  const candidates = input.candidates.flatMap((candidate) => {
    const language = normalizeYoutubeLanguageTag(candidate.language);
    return language === undefined ? [] : [{ ...candidate, language }];
  });
  for (const requestedLanguage of input.languages) {
    const language = normalizeYoutubeLanguageTag(requestedLanguage);
    if (language === undefined) continue;
    for (const kind of ['manual', 'automatic'] as const) {
      const matching = candidates
        .filter((candidate) => candidate.language === language && candidate.kind === kind)
        .toSorted(compareCaptionPaths);
      for (const candidate of matching) {
        let raw: string;
        try {
          raw = await input.readCaption(candidate.path);
        } catch {
          warnings.push(skippedWarning(candidate, 'unreadable'));
          continue;
        }
        const text = normalizeWebVtt(raw);
        if (text.length === 0) {
          warnings.push(skippedWarning(candidate, 'unusable'));
          continue;
        }
        return { candidate, text, warnings };
      }
    }
  }
  throw new YoutubeCaptionsError(
    'YOUTUBE_CAPTIONS_UNAVAILABLE',
    'No usable requested captions were available. Local speech-to-text fallback is not implemented; retry with another requested language or provide a captioned source.',
  );
}

export function normalizeYoutubeMarkdown(input: NormalizeYoutubeMarkdownInput): {
  readonly content: string;
  readonly warnings: readonly string[];
} {
  const warnings = [...input.caption.warnings];
  const title = textValue(input.info.title);
  const lines = [`# ${escapeMarkdown(title ?? '')}`, ''];
  if (title === undefined) warnings.push('Missing video title metadata.');

  lines.push(`- Source: ${input.canonicalUri}`);
  appendOptionalLine(lines, 'Uploader', textValue(input.info.uploader));
  const uploadDate = normalizedUploadDate(input.info.upload_date);
  if (uploadDate === undefined && input.info.upload_date !== undefined) {
    warnings.push('Ignored invalid upload_date metadata.');
  }
  appendOptionalLine(lines, 'Upload date', uploadDate);
  const duration = normalizedDuration(input.info.duration);
  if (duration === undefined && input.info.duration !== undefined) {
    warnings.push('Ignored invalid duration metadata.');
  }
  appendOptionalLine(lines, 'Duration', duration);
  lines.push(`- Caption: ${input.caption.candidate.language} (${input.caption.candidate.kind})`);
  lines.push(`- yt-dlp: ${input.ytDlpVersion}`);

  const description = textValue(input.info.description);
  if (description !== undefined) {
    lines.push('', '## Description', '', description);
  }
  lines.push('', '## Transcript', '', input.caption.text.trimEnd(), '');
  return { content: lines.join('\n'), warnings };
}

function compareCaptionPaths(
  left: YoutubeCaptionCandidate,
  right: YoutubeCaptionCandidate,
): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function normalizeWebVtt(raw: string): string {
  const lines = raw
    .replace(/^\uFEFF/u, '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n');
  const text: string[] = [];
  let inHeader = true;
  let skipBlock = false;
  for (const [index, source] of lines.entries()) {
    const line = source.trim();
    if (inHeader) {
      if (line.length === 0) inHeader = false;
      continue;
    }
    if (line.length === 0) {
      skipBlock = false;
      continue;
    }
    if (skipBlock) continue;
    if (
      line === 'NOTE' ||
      line.startsWith('NOTE ') ||
      line === 'STYLE' ||
      line.startsWith('STYLE ') ||
      line === 'REGION' ||
      line.startsWith('REGION ')
    ) {
      skipBlock = true;
      continue;
    }
    if (isTimestamp(line) || isCueIdentifier(line, lines[index + 1])) continue;
    const cleaned = line.replaceAll(/<[^>]*>/gu, '').trim();
    if (cleaned.length > 0 && text.at(-1) !== cleaned) text.push(cleaned);
  }
  return text.length === 0 ? '' : `${text.join('\n')}\n`;
}

function isTimestamp(line: string): boolean {
  return /^\d{2,}:\d{2}(?::\d{2})?\.\d{3}\s+-->\s+\d{2,}:\d{2}(?::\d{2})?\.\d{3}(?:\s+.*)?$/u.test(
    line,
  );
}

function isCueIdentifier(line: string, following: string | undefined): boolean {
  return following !== undefined && line.length > 0 && isTimestamp(following.trim());
}

function skippedWarning(
  candidate: YoutubeCaptionCandidate,
  reason: 'unreadable' | 'unusable',
): string {
  return `Skipped ${reason} caption ${candidate.language}.${candidate.kind}.`;
}

function appendOptionalLine(lines: string[], label: string, value: string | undefined): void {
  if (value !== undefined) lines.push(`- ${label}: ${escapeMarkdown(value)}`);
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizedUploadDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{8}$/u.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : undefined;
}

function normalizedDuration(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${value} seconds`
    : undefined;
}

function escapeMarkdown(value: string): string {
  const escapable = new Set([
    '\\',
    '`',
    '*',
    '_',
    '{',
    '}',
    '[',
    ']',
    '<',
    '>',
    '(',
    ')',
    '#',
    '+',
    '.',
    '!',
  ]);
  return [...value]
    .map((character) => (escapable.has(character) ? `\\${character}` : character))
    .join('');
}

class YoutubeCaptionsError extends Error {
  public constructor(
    public readonly code: 'YOUTUBE_CAPTIONS_UNAVAILABLE',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'YoutubeCaptionsError';
  }
}
