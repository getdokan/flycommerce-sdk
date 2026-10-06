import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const dashboard = 'https://store.flycommerce.com';
const posted: { action: string; payload: unknown }[] = [];
const parent = { postMessage: (message: { action: string; payload: unknown }) => posted.push(message) };

vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
Object.defineProperty(document, 'referrer', { value: `${dashboard}/admin/apps/export/export` });
window.location.hash = '#nonce=n-resize';

// jsdom has no layout: the page is 200px tall, and a popup ends wherever a test puts it.
const resized = new Set<() => void>();
vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(callback: () => void) {
      resized.add(callback);
    }
    observe() {}
    disconnect() {}
  }
);
vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback));
vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue({ height: 200 } as DOMRect);

const { createApp } = await import('../index.js');

const heights = () => posted.filter((message) => message.action === 'RESIZE').map((message) => message.payload);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function openPopup(bottom: number): HTMLElement {
  const popup = document.createElement('div');
  popup.setAttribute('data-radix-popper-content-wrapper', '');
  popup.getBoundingClientRect = () => ({ bottom }) as DOMRect;
  document.body.append(popup);
  return popup;
}

describe('the frame height the app reports', () => {
  beforeAll(() => {
    createApp({ appId: 'export' });
  });

  afterEach(() => {
    posted.length = 0;
  });

  it('is the page height', () => {
    expect(heights()).toEqual([{ height: 200 }]);
  });

  it('grows while a popup reaches past the page, so the dashboard does not cut it off', async () => {
    const popup = openPopup(480);
    await settle();
    expect(heights().at(-1)).toEqual({ height: 488 });

    popup.remove();
    await settle();
    expect(heights().at(-1)).toEqual({ height: 200 });
  });

  it('stays the page height for a popup that fits', async () => {
    const popup = openPopup(150);
    await settle();
    popup.remove();
    await settle();

    expect(heights()).toEqual([]);
  });
});
