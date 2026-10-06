import { expect, it, vi } from 'vitest';

const posted: { action: string; payload: unknown }[] = [];
const parent = { postMessage: (message: { action: string; payload: unknown }) => posted.push(message) };

vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
Object.defineProperty(document, 'referrer', { value: 'https://store.flycommerce.com/admin/apps/export/export' });
window.location.hash = '#nonce=n-early';
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);
vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback));
vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue({ height: 200 } as DOMRect);

const { createApp } = await import('../index.js');
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

it('starts when loaded in <head>, and watches popups once <body> exists', async () => {
  const body = document.body;
  body.remove();

  let failed: unknown = null;
  createApp({ appId: 'export' }).ready.catch((error) => (failed = error));
  await settle();
  expect(failed).toBeNull();

  document.documentElement.append(body);
  document.dispatchEvent(new Event('DOMContentLoaded'));

  const popup = document.createElement('div');
  popup.setAttribute('data-radix-popper-content-wrapper', '');
  popup.getBoundingClientRect = () => ({ top: 180, bottom: 480, height: 300 }) as DOMRect;
  document.body.append(popup);
  await settle();

  expect(posted.filter((message) => message.action === 'RESIZE').at(-1)?.payload).toEqual({ height: 488 });
});
