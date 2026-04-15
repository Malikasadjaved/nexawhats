import { platform } from 'node:os';
import { join } from 'node:path';

/** Detect current OS */
export function getPlatform(): 'windows' | 'macos' | 'linux' {
  const p = platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  return 'linux';
}

/** Get default data directory for the current platform */
export function getDefaultDataDir(appName = 'nexawhats'): string {
  const p = getPlatform();
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';

  switch (p) {
    case 'windows':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), appName);
    case 'macos':
      return join(home, 'Library', 'Application Support', appName);
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), appName);
  }
}
