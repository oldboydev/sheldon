export interface CanonicalYoutubeVideo {
  readonly id: string;
  readonly canonicalUri: string;
}

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/u;
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const shortHost = 'youtu.be';

export function canonicalYoutubeVideo(value: string): CanonicalYoutubeVideo {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidYoutubeInput();
  }

  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    value.includes('#') ||
    url.searchParams.has('list')
  ) {
    throw invalidYoutubeInput();
  }

  const id = youtubeVideoId(url);
  if (id === undefined || !videoIdPattern.test(id)) throw invalidYoutubeInput();

  return {
    id,
    canonicalUri: `https://www.youtube.com/watch?v=${id}`,
  };
}

export function isYoutubeVideo(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    canonicalYoutubeVideo(value);
    return true;
  } catch {
    return false;
  }
}

function youtubeVideoId(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  if (host === shortHost || host === `www.${shortHost}`) {
    const segments = url.pathname.split('/').filter(Boolean);
    return segments.length === 1 ? segments[0] : undefined;
  }
  if (!youtubeHosts.has(host)) return undefined;

  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v');
    return id === null || [...url.searchParams.keys()].filter((key) => key === 'v').length !== 1
      ? undefined
      : id;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  return segments.length === 2 && (segments[0] === 'shorts' || segments[0] === 'embed')
    ? segments[1]
    : undefined;
}

function invalidYoutubeInput(): Error {
  return new YoutubeInputError(
    'YOUTUBE_INPUT_INVALID',
    'A single public YouTube video URL is required.',
  );
}

class YoutubeInputError extends Error {
  public constructor(
    public readonly code: 'YOUTUBE_INPUT_INVALID',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'YoutubeInputError';
  }
}
