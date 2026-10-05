import crypto from 'node:crypto';

/** AES-256-GCM for the secrets an app holds on a merchant's behalf: API keys, webhook secrets. */
export class Sealer {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');

    if (this.key.length !== 32) {
      throw new Error('The encryption key must be 32 bytes, base64-encoded.');
    }
  }

  seal(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }

  open(sealed: string): string {
    const parts = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
    const [iv, tag, encrypted] = parts;

    if (parts.length !== 3 || iv.length !== 12 || tag.length !== 16) {
      throw new Error('Not a sealed value.');
    }

    // A short tag would accept forgeries far more often; GCM only checks as many bytes as it is given.
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
