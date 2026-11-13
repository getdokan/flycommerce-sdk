import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AppConfig } from '../app-config.js';
import { defaultPlan, pageAccess, planOf } from '../plans.js';

const config: Pick<AppConfig, 'plans' | 'dashboard'> = {
  plans: [
    { key: 'free', name: 'Free' },
    { key: 'pro', name: 'Pro', default: true },
    { key: 'team', name: 'Team' },
  ],
  dashboard: {
    pages: [
      { slug: 'home', label: 'Home', path: '/' },
      {
        slug: 'reports',
        label: 'Reports',
        path: '/reports',
        plans: ['pro', 'team'],
        children: [
          { slug: 'sales', label: 'Sales', path: '/reports/sales' },
          { slug: 'forecast', label: 'Forecast', path: '/reports/forecast', plans: ['team'] },
        ],
      },
      { slug: 'beta', label: 'Beta', path: '/beta', plans: ['free'], isActive: false },
    ],
  },
};

describe('plans', () => {
  it('reads the plan from a token, and the default plan when the token has none', () => {
    assert.strictEqual(defaultPlan(config), 'pro');
    assert.strictEqual(planOf(config, { plan: 'team' }), 'team');
    assert.strictEqual(planOf(config, {}), 'pro');
    assert.strictEqual(planOf(config, { plan: null }), 'pro');
    assert.strictEqual(planOf({}, {}), null);
  });

  it('opens a page on its plans, and every page without plans', () => {
    assert.strictEqual(pageAccess(config, 'home', 'free'), 'available');
    assert.strictEqual(pageAccess(config, 'home', null), 'available');
    assert.strictEqual(pageAccess(config, 'reports', 'pro'), 'available');
    assert.strictEqual(pageAccess(config, 'reports', 'free'), 'plan');
    assert.strictEqual(pageAccess(config, 'reports', null), 'plan');
  });

  it('locks a page its owner switched off whatever the plan, and a page it doesn’t have', () => {
    assert.strictEqual(pageAccess(config, 'beta', 'free'), 'inactive');
    assert.strictEqual(pageAccess(config, 'nowhere', 'team'), 'inactive');
  });

  it('locks a sub-page for its own reason first, then for its parent’s', () => {
    assert.strictEqual(pageAccess(config, 'sales', 'pro'), 'available');
    assert.strictEqual(pageAccess(config, 'sales', 'free'), 'plan');
    assert.strictEqual(pageAccess(config, 'forecast', 'pro'), 'plan');
    assert.strictEqual(pageAccess(config, 'forecast', 'team'), 'available');
  });
});
