import crypto from 'node:crypto';

/** AES-256-GCM for the secrets an app holds on a merchant's behalf: API keys, webhook secrets. */
export class Sealer {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');

    if (this.key.length !== 32) {
      throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
    }
  }

  seal(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }

  open(sealed: string): string {
    const [iv, tag, encrypted] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
