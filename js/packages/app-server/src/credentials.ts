import fs from 'node:fs';
import path from 'node:path';

export interface StoreCredential {
  clientId: string;
  clientSecret: string;
  scope: string;
}

export interface CredentialStore {
  get(store: string): StoreCredential | undefined;
  put(store: string, credential: StoreCredential): void;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly items = new Map<string, StoreCredential>();

  get(store: string): StoreCredential | undefined {
    return this.items.get(store);
  }

  put(store: string, credential: StoreCredential): void {
    this.items.set(store, credential);
  }
}

// One JSON file is enough for an internal app running as a single instance.
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly file: string) {}

  get(store: string): StoreCredential | undefined {
    return this.read()[store];
  }

  put(store: string, credential: StoreCredential): void {
    const all = this.read();
    all[store] = credential;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });

    // Written beside the file and renamed over it, so a crash mid-write never loses every store's credential.
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }

  private read(): Record<string, StoreCredential> {
    let raw: string;

    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }

    // A corrupt file must stop the app, not read as empty: the next put() would overwrite every other store.
    return JSON.parse(raw);
  }
}
