import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runPlugin } from '../../../../../plugin-sdk/dist/index.js';
import { createOfficialSourceYoutubePlugin } from '../../dist/index.js';

const runner = {
  async run(_file, arguments_, { cwd }) {
    const automatic = arguments_.includes('--write-auto-subs');
    const captionPath = join(
      cwd,
      automatic ? 'AbCdEf12345.pt.automatic.vtt' : 'AbCdEf12345.pt.manual.vtt',
    );
    await writeFile(
      captionPath,
      automatic
        ? 'WEBVTT\n\n00:00.000 --> 00:01.000\nLegenda automática\n'
        : 'WEBVTT\n\n00:00.000 --> 00:01.000\nLegenda manual\n',
    );
    return {
      stdout: JSON.stringify({
        id: 'AbCdEf12345',
        title: 'Official host boundary fixture',
        _version: { version: '2026.07.24' },
        requested_subtitles: { pt: { ext: 'vtt', filepath: captionPath } },
      }),
      stderr: '',
    };
  },
};

await runPlugin(createOfficialSourceYoutubePlugin({ runner }));
