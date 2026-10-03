import { describe, it } from 'node:test';
import assert from 'node:assert';
import { installReturnUrl } from '../install.js';

const ANCESTORS = ['https://*.flycommerce.com', 'http://localhost:3001'];

const returning = (target: string) =>
  installReturnUrl(new URL(`https://app.test/auth/callback?code=c&return_to=${encodeURIComponent(target)}`), ANCESTORS);

describe('installReturnUrl', () => {
  it('returns to the app’s page on a dashboard the app lets frame it', () => {
    assert.strictEqual(
      returning('https://acme.flycommerce.com/admin/apps/mailchimp/overview'),
      'https://acme.flycommerce.com/admin/apps/mailchimp/overview'
    );
    assert.strictEqual(returning('http://localhost:3001/admin/apps/mailchimp'), 'http://localhost:3001/admin/apps/mailchimp');
  });

  it('refuses anywhere else, so the callback is not an open redirect', () => {
    for (const target of [
      'https://evil.test/admin/apps/mailchimp',
      'https://flycommerce.com/admin/apps/mailchimp',
      'https://acme.flycommerce.com.evil.test/admin/apps/mailchimp',
      'http://acme.flycommerce.com/admin/apps/mailchimp',
      'http://localhost:3002/admin/apps/mailchimp',
      'https://acme.flycommerce.com/admin/orders',
      'https://user:pass@acme.flycommerce.com/admin/apps/mailchimp',
      'javascript:alert(1)//admin/apps/x',
      'not a url',
    ]) {
      assert.strictEqual(returning(target), null, target);
    }
  });

  it('is absent when the install did not start in a dashboard', () => {
    assert.strictEqual(installReturnUrl(new URL('https://app.test/auth/callback?code=c'), ANCESTORS), null);
  });
});
