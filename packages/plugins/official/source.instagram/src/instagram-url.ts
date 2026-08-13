export interface CanonicalInstagramVideo {
  readonly canonicalUri: string;
  readonly kind: 'reel' | 'post';
}

export function canonicalInstagramVideo(value: string): CanonicalInstagramVideo {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw instagramInputError();
  }
  if (
    url.protocol !== 'https:' ||
    !new Set(['instagram.com', 'www.instagram.com']).has(url.hostname)
  ) {
    throw instagramInputError();
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (
    parts.length !== 2 ||
    !new Set(['reel', 'p']).has(parts[0]!) ||
    !/^[A-Za-z0-9_-]{5,64}$/u.test(parts[1]!)
  ) {
    throw instagramInputError();
  }
  return {
    canonicalUri: `https://www.instagram.com/${parts[0]}/${parts[1]}/`,
    kind: parts[0] === 'reel' ? 'reel' : 'post',
  };
}

function instagramInputError(): Error {
  return Object.assign(
    new Error('INSTAGRAM_INPUT_INVALID: A public Instagram Reel or video post URL is required.'),
    { code: 'INSTAGRAM_INPUT_INVALID' },
  );
}
