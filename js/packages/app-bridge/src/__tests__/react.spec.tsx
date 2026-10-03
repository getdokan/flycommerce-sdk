import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dashboard = 'https://store.flycommerce.com';
const posted: { message: any; origin: string }[] = [];
const parent = { postMessage: (message: any, origin: string) => posted.push({ message, origin }) };

vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as unknown as Window);
Object.defineProperty(document, 'referrer', { value: `${dashboard}/admin/apps/printer/invoices` });

const { AppBridgeProvider, useDashboardContext, useTitleBar } = await import('../react.js');

// jsdom's MessageEvent only accepts a real window as its source.
function fromDashboard(data: Record<string, unknown>) {
  const event = Object.assign(new Event('message'), { source: parent, origin: dashboard, data });
  act(() => {
    window.dispatchEvent(event);
  });
}

function Page({ title, onPrint }: { title: string; onPrint: () => void }) {
  const { embedded } = useTitleBar({
    title,
    actions: [{ id: 'print', label: 'Print', variant: 'primary', onAction: onPrint }],
  });

  return <p>{embedded ? 'embedded' : 'standalone'}</p>;
}

const titleBars = (appId: string) =>
  posted.filter((entry) => entry.message.appId === appId && entry.message.action === 'TITLE_BAR').map((entry) => entry.message.payload);

describe('@flycommerce/app-bridge/react', () => {
  // Each bridge takes the nonce out of the URL, so every test's frame needs its own.
  beforeEach(() => {
    window.location.hash = '#nonce=n-1';
  });

  afterEach(cleanup);

  it('shows the title bar in the dashboard, and sends it again only when it changes', () => {
    const { rerender, getByText } = render(
      <AppBridgeProvider appId="title-app">
        <Page title="Invoices" onPrint={() => {}} />
      </AppBridgeProvider>
    );

    rerender(
      <AppBridgeProvider appId="title-app">
        <Page title="Invoices" onPrint={() => {}} />
      </AppBridgeProvider>
    );
    rerender(
      <AppBridgeProvider appId="title-app">
        <Page title="Packing slips" onPrint={() => {}} />
      </AppBridgeProvider>
    );

    expect(titleBars('title-app').map((titleBar) => titleBar.title)).toEqual(['Invoices', 'Packing slips']);
    expect(titleBars('title-app')[0].actions).toEqual([{ id: 'print', label: 'Print', variant: 'primary' }]);
    expect(posted.every((entry) => entry.origin === dashboard)).toBe(true);
    expect(getByText('embedded')).toBeTruthy();
  });

  it('runs the latest handler for the action clicked in the dashboard header', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(
      <AppBridgeProvider appId="click-app">
        <Page title="Invoices" onPrint={first} />
      </AppBridgeProvider>
    );
    rerender(
      <AppBridgeProvider appId="click-app">
        <Page title="Invoices" onPrint={latest} />
      </AppBridgeProvider>
    );

    fromDashboard({ source: 'flycom-dashboard', appId: 'click-app', event: 'TITLE_ACTION', payload: { id: 'print' } });

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('re-renders with the context the dashboard answers with', async () => {
    function Locale() {
      return <p>{useDashboardContext()?.locale ?? 'waiting'}</p>;
    }

    const { findByText } = render(
      <AppBridgeProvider appId="context-app">
        <Locale />
      </AppBridgeProvider>
    );
    const ready = posted.find((entry) => entry.message.appId === 'context-app' && entry.message.action === 'APP_READY')!.message;

    fromDashboard({
      source: 'flycom-dashboard',
      appId: 'context-app',
      requestId: ready.requestId,
      action: 'APP_READY',
      success: true,
      payload: { locale: 'bn', direction: 'ltr', theme: 'light' },
    });

    expect(await findByText('bn')).toBeTruthy();
    expect(document.documentElement.lang).toBe('bn');
  });
});
