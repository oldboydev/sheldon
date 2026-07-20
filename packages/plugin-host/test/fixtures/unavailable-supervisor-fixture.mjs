import { initializeWindowsJob } from '../../dist/windows-job-addon.js';
import { runWindowsSupervisorCommand } from '../../dist/windows-supervisor.js';

runWindowsSupervisorCommand(process.argv[2] ?? '', {
  initializeWindowsJob: () =>
    initializeWindowsJob({
      platform: 'win32',
      load: () => {
        throw new Error('missing');
      },
    }),
});
