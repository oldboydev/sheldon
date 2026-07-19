import { createRequire } from 'node:module';

import { PluginHostError } from './errors.js';

interface WindowsJobAddon {
  initialize(): void;
}

interface WindowsJobOptions {
  platform?: NodeJS.Platform;
  load?: () => WindowsJobAddon;
}

const requireGeneratedAddon = createRequire(import.meta.url);

function loadGeneratedAddon(): WindowsJobAddon {
  return requireGeneratedAddon(
    '../native/windows-job/build/Release/sheldon_job_object.node',
  ) as WindowsJobAddon;
}

export function initializeWindowsJob(options: WindowsJobOptions = {}): void {
  if ((options.platform ?? process.platform) !== 'win32') return;

  try {
    const addon = options.load?.() ?? loadGeneratedAddon();
    addon.initialize();
  } catch (cause) {
    throw new PluginHostError(
      'PLUGIN_SUPERVISOR_UNAVAILABLE',
      'The Windows plugin supervisor could not initialize its native Job Object.',
      '',
      'Rebuild the Windows-native Sheldon plugin host component for this Node architecture.',
      { cause },
    );
  }
}
