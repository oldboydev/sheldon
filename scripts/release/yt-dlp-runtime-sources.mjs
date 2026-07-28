const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

const VERSION = '2026.07.04';
const REVISION = 'fdec00e0bf530dc6c3cc7b1dd780e95d9ae460e9';
const RELEASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}`;
const SOURCE = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${REVISION}`;

export const YT_DLP_RUNTIME_SOURCES = Object.freeze({
  version: VERSION,
  revision: REVISION,
  license: Object.freeze({
    url: `${SOURCE}/LICENSE`,
    sha256: '7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c',
  }),
  thirdPartyLicenses: Object.freeze({
    url: `${SOURCE}/THIRD_PARTY_LICENSES.txt`,
    sha256: 'b085c65586a953cdb4b13c6390d63ec984d66912e4b6a19e66ba3582f2ed104b',
  }),
  artifacts: Object.freeze({
    'win32-x64': Object.freeze({
      url: `${RELEASE}/yt-dlp.exe`,
      file: 'yt-dlp.exe',
      sha256: '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8',
    }),
    'darwin-arm64': Object.freeze({
      url: `${RELEASE}/yt-dlp_macos`,
      file: 'yt-dlp',
      sha256: '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b',
    }),
    'darwin-x64': Object.freeze({
      url: `${RELEASE}/yt-dlp_macos`,
      file: 'yt-dlp',
      sha256: '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b',
    }),
    'linux-x64': Object.freeze({
      url: `${RELEASE}/yt-dlp_linux`,
      file: 'yt-dlp',
      sha256: '6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae',
    }),
  }),
});

export function assertPinnedYtDlpRuntimeSources(sources = YT_DLP_RUNTIME_SOURCES) {
  if (!sources || typeof sources !== 'object') throw unpinnedSourceError();
  const { version, revision, license, thirdPartyLicenses, artifacts } = sources;
  if (
    typeof version !== 'string' ||
    !/^\d{4}\.\d{2}\.\d{2}$/u.test(version) ||
    typeof revision !== 'string' ||
    !COMMIT.test(revision) ||
    !isPinnedLicense(license, revision) ||
    !isPinnedLicense(thirdPartyLicenses, revision) ||
    !artifacts ||
    typeof artifacts !== 'object'
  ) {
    throw unpinnedSourceError();
  }
  for (const [platform, expectedFile] of [
    ['win32-x64', 'yt-dlp.exe'],
    ['darwin-arm64', 'yt-dlp'],
    ['darwin-x64', 'yt-dlp'],
    ['linux-x64', 'yt-dlp'],
  ]) {
    const artifact = artifacts[platform];
    if (
      !artifact ||
      typeof artifact !== 'object' ||
      artifact.file !== expectedFile ||
      !isHttpsUrl(artifact.url) ||
      !artifact.url.startsWith(`https://github.com/yt-dlp/yt-dlp/releases/download/${version}/`) ||
      !SHA256.test(artifact.sha256 ?? '')
    ) {
      throw unpinnedSourceError();
    }
  }
}

function isPinnedLicense(value, revision) {
  return (
    value &&
    typeof value === 'object' &&
    isHttpsUrl(value.url) &&
    value.url.startsWith(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${revision}/`) &&
    SHA256.test(value.sha256 ?? '')
  );
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function unpinnedSourceError() {
  const error = new Error(
    'YOUTUBE_RUNTIME_SOURCE_UNPINNED: yt-dlp runtime downloads require immutable HTTPS URLs, SHA-256 values, and pinned license sources.',
  );
  error.code = 'YOUTUBE_RUNTIME_SOURCE_UNPINNED';
  return error;
}
