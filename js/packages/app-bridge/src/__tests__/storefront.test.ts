import { describe, it } from 'node:test';
import assert from 'node:assert';
import type {} from '../storefront.js';

const target = new EventTarget();
Object.assign(globalThis, {
  window: Object.assign(target, { FlyCommerce: { store: 'demo.flycom.shop', locale: 'bn', currency: 'BDT', pageType: 'home' } }),
});

describe('@flycommerce/app-bridge/storefront', () => {
  it('types window.FlyCommerce and the flycommerce:page event for a storefront script', () => {
    const pages: string[] = [];
    window.addEventListener('flycommerce:page', (event) => pages.push(`${event.detail.pageType} ${event.detail.path}`));

    window.dispatchEvent(new CustomEvent('flycommerce:page', { detail: { pageType: 'product', path: '/products/tea' } }));

    assert.strictEqual(window.FlyCommerce?.currency, 'BDT');
    assert.deepStrictEqual(pages, ['product /products/tea']);
  });
});
