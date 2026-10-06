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

function read(file: string): CredentialsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.portals === 'object' && parsed.portals !== null) {
      return parsed as CredentialsFile;
    }
  } catch {
    // Missing or unreadable: no sign-ins.
  }
  return { portals: {} };
}

function write(file: string, contents: CredentialsFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(contents, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

export function readCredential(env: NodeJS.ProcessEnv, portal: string): SavedCredential | undefined {
  const saved = read(credentialsPath(env)).portals[portal];
  return saved && typeof saved.token === 'string' && saved.token !== '' ? saved : undefined;
}

/** Keyed by portal, so a staging sign-in sits beside the production one. */
export function saveCredential(env: NodeJS.ProcessEnv, portal: string, credential: SavedCredential): void {
  const file = credentialsPath(env);
  const contents = read(file);
  contents.portals[portal] = credential;
  write(file, contents);
}

export function deleteCredential(env: NodeJS.ProcessEnv, portal: string): boolean {
  const file = credentialsPath(env);
  const contents = read(file);

  if (!(portal in contents.portals)) return false;

  delete contents.portals[portal];
  write(file, contents);
  return true;
}
