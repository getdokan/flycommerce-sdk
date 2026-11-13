import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loopbackOrigins, moveOrigins, releaseProblems } from '../surfaces.js';

const config = {
  appId: 'order-export-dev',
  appUrl: 'http://localhost:4000',
  plans: [{ key: 'free', name: 'Free', default: true }],
  planCallback: 'http://localhost:4000/callbacks/plan',
  dashboard: {
    pages: [
      {
        slug: 'export',
        label: 'Export',
        path: '/export',
        callback: 'http://127.0.0.1:4000/callbacks/export-locked',
        children: [{ slug: 'history', label: 'History', path: '/export/history', callback: '/callbacks/history-locked' }],
      },
    ],
  },
};

describe('callback URLs in a dev push and a release', () => {
  it('moves callbacks written on this computer onto the tunnel, and leaves paths alone', () => {
    const moved = moveOrigins(config, 'https://tunnel.example.dev', loopbackOrigins(4000)) as typeof config;

    assert.equal(moved.planCallback, 'https://tunnel.example.dev/callbacks/plan');
    assert.equal(moved.dashboard.pages[0].callback, 'https://tunnel.example.dev/callbacks/export-locked');
    assert.equal(moved.dashboard.pages[0].children[0].callback, '/callbacks/history-locked');
    assert.equal(moved.dashboard.pages[0].path, '/export');
  });

  it('names a callback FlyCommerce could not reach before a release', () => {
    assert.deepEqual(releaseProblems({ ...config, appUrl: 'https://export.example.com' }), [
      'planCallback is http://localhost:4000/callbacks/plan, which only this computer or a private network can reach.',
      'dashboard.pages[0].callback is http://127.0.0.1:4000/callbacks/export-locked, which only this computer or a private network can reach.',
    ]);
  });
});
