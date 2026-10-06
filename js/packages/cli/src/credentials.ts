import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SavedCredential {
  token: string;
  expiresAt?: string;
}

interface CredentialsFile {
  portals: Record<string, SavedCredential>;
}

/** ~/.config/flycommerce/credentials.json, or under XDG_CONFIG_HOME when it is set. */
export function credentialsPath(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'flycommerce', 'credentials.json');
}

/** The file's sign-ins; `corrupt` when it exists but can't be read as one. */
function read(file: string): { contents: CredentialsFile; corrupt: boolean } {
  let text: string;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { contents: { portals: {} }, corrupt: false };
  }

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.portals === 'object' && parsed.portals !== null) {
      return { contents: parsed as CredentialsFile, corrupt: false };
    }
  } catch {
    // Reported below.
  }
  return { contents: { portals: {} }, corrupt: true };
}

function write(file: string, contents: CredentialsFile): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir keeps an existing directory's mode, so tighten one that others can read.
  if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);

  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(contents, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

export function readCredential(env: NodeJS.ProcessEnv, portal: string): SavedCredential | undefined {
  const saved = read(credentialsPath(env)).contents.portals[portal];
  return saved && typeof saved.token === 'string' && saved.token !== '' ? saved : undefined;
}

/** Keyed by portal, so a staging sign-in sits beside the production one. Returns where an unreadable old file was kept. */
export function saveCredential(env: NodeJS.ProcessEnv, portal: string, credential: SavedCredential): { backup?: string } {
  const file = credentialsPath(env);
  const { contents, corrupt } = read(file);
  let backup: string | undefined;

  if (corrupt) {
    backup = `${file}.bak`;
    fs.renameSync(file, backup);
  }

  contents.portals[portal] = credential;
  write(file, contents);
  return { backup };
}

export function deleteCredential(env: NodeJS.ProcessEnv, portal: string): boolean {
  const file = credentialsPath(env);
  const { contents, corrupt } = read(file);

  if (corrupt || !(portal in contents.portals)) return false;

  delete contents.portals[portal];
  write(file, contents);
  return true;
}
