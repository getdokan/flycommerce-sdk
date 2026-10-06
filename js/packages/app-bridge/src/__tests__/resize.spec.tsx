import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const dashboard = 'https://store.flycommerce.com';
const posted: { action: string; payload: unknown }[] = [];
const parent = { postMessage: (message: { action: string; payload: unknown }) => posted.push(message) };

vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
Object.defineProperty(document, 'referrer', { value: `${dashboard}/admin/apps/export/export` });
window.location.hash = '#nonce=n-resize';

// jsdom has no layout: the page is 200px tall, and a popup ends wherever a test puts it.
const unobserved: Element[] = [];
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve(element: Element) {
      unobserved.push(element);
    }
    disconnect() {}
  }
);
vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback));
vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue({ height: 200 } as DOMRect);

const { createApp } = await import('../index.js');

const heights = () => posted.filter((message) => message.action === 'RESIZE').map((message) => message.payload);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function openPopup(bottom: number, { height = 300, side = 'bottom' } = {}): HTMLElement {
  const popup = document.createElement('div');
  popup.setAttribute('data-radix-popper-content-wrapper', '');
  popup.getBoundingClientRect = () => ({ top: bottom - height, bottom, height }) as DOMRect;

  const content = document.createElement('div');
  content.setAttribute('data-side', side);
  popup.append(content);

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

  it('makes room below a popup that flipped up and runs off the top, so it flips back down', async () => {
    // Radix put it above its trigger, which sits low on a short page: its top is cut off by the frame.
    const popup = openPopup(180, { height: 330, side: 'top' });
    await settle();

    expect(heights().at(-1)).toEqual({ height: 180 + 330 + 64 });
    popup.remove();
    await settle();
  });

  it('stops watching a popup once it closes', async () => {
    const popup = openPopup(480);
    await settle();
    popup.remove();
    await settle();

    expect(unobserved).toContain(popup);
  });

  it('stays the page height for a popup that fits, above or below its trigger', async () => {
    const below = openPopup(150, { height: 100 });
    const above = openPopup(120, { height: 100, side: 'top' });
    await settle();
    below.remove();
    above.remove();
    await settle();

    expect(heights()).toEqual([]);
  });
});
