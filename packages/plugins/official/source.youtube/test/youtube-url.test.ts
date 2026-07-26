import { describe, expect, it } from 'vitest';

import { canonicalYoutubeVideo, isYoutubeVideo } from '../src/youtube-url.js';

describe('canonicalYoutubeVideo', () => {
  it('canonicalizes a youtu.be video URL without retaining its query', () => {
    expect(canonicalYoutubeVideo('https://youtu.be/AbCdEf12345?t=9')).toEqual({
      id: 'AbCdEf12345',
      canonicalUri: 'https://www.youtube.com/watch?v=AbCdEf12345',
    });
  });

  it('canonicalizes a YouTube watch URL', () => {
    expect(canonicalYoutubeVideo('https://www.youtube.com/watch?v=AbCdEf12345')).toEqual({
      id: 'AbCdEf12345',
      canonicalUri: 'https://www.youtube.com/watch?v=AbCdEf12345',
    });
  });

  it('rejects playlists, fragments, and non-video URLs with a stable code', () => {
    for (const value of [
      'https://www.youtube.com/playlist?list=PLx',
      'https://www.youtube.com/watch?v=AbCdEf12345&list=PLx',
      'https://youtu.be/AbCdEf12345#chapter',
      'https://youtu.be/AbCdEf12345#',
      'https://user:password@youtu.be/AbCdEf12345',
      'https://user@www.youtube.com/watch?v=AbCdEf12345',
      'https://www.youtube.com/channel/UC1234567890',
      'https://example.test/watch?v=AbCdEf12345',
    ]) {
      expect(() => canonicalYoutubeVideo(value)).toThrow('YOUTUBE_INPUT_INVALID');
    }
  });
});

describe('isYoutubeVideo', () => {
  it('only narrows accepted single-video URL strings', () => {
    expect(isYoutubeVideo('https://www.youtube.com/watch?v=AbCdEf12345')).toBe(true);
    expect(isYoutubeVideo('https://user:password@youtu.be/AbCdEf12345')).toBe(false);
    expect(isYoutubeVideo('https://www.youtube.com/playlist?list=PLx')).toBe(false);
    expect(isYoutubeVideo({ url: 'https://youtu.be/AbCdEf12345' })).toBe(false);
  });
});
