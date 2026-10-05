import fs from 'node:fs';
import path from 'node:path';
import type { Sealer } from './sealer.js';

export interface StoreCredential {
  clientId: string;
  clientSecret: string;
  scope: string;
}

export interface CredentialStore {
  get(store: string): StoreCredential | undefined;
  put(store: string, credential: StoreCredential): void;
  delete(store: string): void;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly items = new Map<string, StoreCredential>();

  get(store: string): StoreCredential | undefined {
    return this.items.get(store);
  }

  put(store: string, credential: StoreCredential): void {
    this.items.set(store, credential);
  }

  delete(store: string): void {
    this.items.delete(store);
  }
}

type Stored = StoreCredential | string;

// One JSON file is enough for an app running as a single instance. Pass a Sealer to keep each credential encrypted.
export class FileCredentialStore implements CredentialStore {
  constructor(
    private readonly file: string,
    private readonly options: { sealer?: Sealer } = {}
  ) {}

  get(store: string): StoreCredential | undefined {
    const stored = this.read()[store];

    if (typeof stored !== 'string') return stored;
    if (!this.options.sealer) throw new Error(`The credential for ${store} is sealed; pass the Sealer that sealed it.`);

    return JSON.parse(this.options.sealer.open(stored)) as StoreCredential;
  }

  put(store: string, credential: StoreCredential): void {
    const all = this.read();
    all[store] = this.options.sealer ? this.options.sealer.seal(JSON.stringify(credential)) : credential;
    this.write(all);
  }

  delete(store: string): void {
    const all = this.read();
    if (!(store in all)) return;
    delete all[store];
    this.write(all);
  }

  private write(all: Record<string, Stored>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });

    // Written beside the file and renamed over it, so a crash mid-write never loses every store's credential.
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }

  private read(): Record<string, Stored> {
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
