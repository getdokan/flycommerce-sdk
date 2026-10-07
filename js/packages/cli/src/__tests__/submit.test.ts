import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FakeApp, FakePortal, runCli } from './fake-portal.js';

const fixUrl = (page: string) => `https://developers.example.com/apps/12/${page}`;
const done = (key: string, label: string) => ({ key, label, hint: `Hint for ${label}.`, done: true, fixUrl: fixUrl('settings') });

describe('flycommerce app submit', () => {
  let portal: FakePortal;
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let app: FakeApp;
  const posts = () => portal.apiCalls().filter((call) => call.method === 'POST');
  const cli = (argv: string[], prompt?: (question: string) => Promise<string>) =>
    runCli(['app', 'submit', ...argv, '--portal', portal.url], { env, cwd: dir, prompt });

  before(async () => {
    portal = await FakePortal.start();
  });

  after(() => portal.close());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flycommerce-submit-'));
    env = { XDG_CONFIG_HOME: dir, FLYCOMMERCE_TOKEN: portal.token };
    portal.apps.clear();
    portal.requests.length = 0;
    portal.submitAnswer = undefined;
    app = portal.addApp({
      appId: 'order-export',
      name: 'Order Export',
      checklist: [done('listing', 'Name, icon and description'), done('version', 'A released version')],
    });
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ appId: 'order-export' }));
  });

  it('shows the checklist and submits a ready app, with notes for the reviewer', async () => {
    const result = await cli(['--yes', '--notes', '  Test store: demo.example.com  ']);

    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /Review checklist for order-export \(unpublished\)\n {2}✓ Name, icon and description\n {2}✓ A released version\n/
    );
    assert.doesNotMatch(result.stdout, /Hint for|Fix it/);
    assert.deepEqual(
      portal.apiCalls().map((call) => `${call.method} ${call.path}`),
      ['GET /api/cli/v1/apps/order-export/checklist', 'POST /api/cli/v1/apps/order-export/submit']
    );
    assert.deepEqual(posts()[0].body, { reviewNotes: 'Test store: demo.example.com' });
    assert.match(result.stdout, /Submitted order-export for FlyCommerce's review \(pending\)/);
    assert.equal(app.status, 'pending');
  });

  it("lists what's missing, with where to fix it, and submits nothing", async () => {
    app.checklist.push({
      key: 'privacy',
      label: 'Privacy policy',
      hint: 'Link the privacy policy merchants agree to.',
      done: false,
      fixUrl: fixUrl('listing'),
    });

    const result = await cli(['--yes']);

    assert.equal(result.code, 1);
    assert.match(
      result.stdout,
      / {2}✗ Privacy policy\n {6}Link the privacy policy merchants agree to\.\n {6}Fix it: https:\/\/developers\.example\.com\/apps\/12\/listing/
    );
    assert.match(result.stderr, /order-export isn't ready for review yet\. Still to do:\n {2}- Privacy policy/);
    assert.deepEqual(posts(), []);
  });

  it('asks at a terminal, and without one needs --yes', async () => {
    const unattended = await cli([]);
    assert.equal(unattended.code, 1);
    assert.match(unattended.stderr, /pass --yes to submit/);

    const declined = await cli([], async () => 'no');
    assert.equal(declined.code, 1);
    assert.match(declined.stderr, /Cancelled; nothing was submitted/);
    assert.deepEqual(posts(), []);

    const questions: string[] = [];
    const agreed = await cli([], async (question) => (questions.push(question), 'Y'));
    assert.equal(agreed.code, 0, agreed.stderr);
    assert.deepEqual(questions, ["Submit order-export for FlyCommerce's review? (y/N) "]);
    assert.deepEqual(posts()[0].body, {});
  });

  it("names what's outstanding, by the checklist's labels, when the hub finds it incomplete after all", async () => {
    portal.submitAnswer = {
      status: 409,
      body: {
        error: 'checklist_incomplete',
        message: 'Not ready to submit: a released version.',
        outstanding: ['version', 'support-email'],
      },
    };

    const result = await cli(['--yes']);

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /Error: Not ready to submit: a released version\.\n {2}- A released version: https:\/\/developers\.example\.com\/apps\/12\/settings\n {2}- support-email\n/
    );
  });

  it("doesn't submit an app that waits for review or is published, and says why, exiting 0", async () => {
    app.status = 'pending';
    app.submittedAt = '2026-10-01T09:00:00Z';

    const pending = await cli(['--yes']);
    assert.equal(pending.code, 0, pending.stderr);
    assert.match(pending.stdout, /Review checklist for order-export \(pending, submitted 2026-10-01\)/);
    assert.match(pending.stdout, /order-export is already waiting for FlyCommerce's review\./);

    app.status = 'published';
    app.checklist.push({ key: 'privacy', label: 'Privacy policy', hint: 'Link it.', done: false, fixUrl: fixUrl('listing') });
    const published = await cli([]);
    assert.equal(published.code, 0, published.stderr);
    assert.match(
      published.stdout,
      /order-export is published, so there's nothing to submit: changes .* go to review when you release them\./
    );
    assert.deepEqual(posts(), []);
  });

  it("refuses a rejected app, and passes on the hub's word when the status changed meanwhile", async () => {
    app.status = 'rejected';
    const rejected = await cli(['--yes']);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /Error: This app was rejected\. Contact support before resubmitting\./);
    assert.deepEqual(posts(), []);

    app.status = 'unpublished';
    portal.submitAnswer = {
      status: 409,
      body: { error: 'app_rejected', message: 'This app was rejected. Contact support before resubmitting.' },
    };
    const raced = await cli(['--yes']);
    assert.equal(raced.code, 1);
    assert.match(raced.stderr, /Error: This app was rejected\. Contact support before resubmitting\./);

    portal.submitAnswer = { status: 409, body: { error: 'app_rejected' } };
    const bare = await cli(['--yes']);
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /Error: This app was rejected\. Contact support before resubmitting\./);

    portal.submitAnswer = { status: 409, body: { error: 'already_pending', message: 'Order Export is already waiting for review.' } };
    const pending = await cli(['--yes']);
    assert.equal(pending.code, 0, pending.stderr);
    assert.match(pending.stdout, /Order Export is already waiting for review\./);

    portal.submitAnswer = {
      status: 409,
      body: { error: 'nothing_to_submit', message: "Order Export is published. There's nothing to submit." },
    };
    const published = await cli(['--yes']);
    assert.equal(published.code, 0, published.stderr);
    assert.match(published.stdout, /Order Export is published\. There's nothing to submit\./);
  });

  it('keeps review notes within 5000 characters', async () => {
    const result = await cli(['--yes', '--notes', 'x'.repeat(5001)]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--notes is 5001 characters; FlyCommerce takes up to 5000/);
    assert.deepEqual(portal.apiCalls(), []);
  });

  it('tells a deploy token, which reads the checklist but cannot submit, to sign in instead', async () => {
    env.FLYCOMMERCE_TOKEN = portal.deployToken;

    const result = await cli(['--yes']);

    assert.equal(result.code, 1);
    assert.match(result.stdout, /Review checklist for order-export/);
    assert.match(
      result.stderr,
      /Deploy tokens can release but not submit — run flycommerce login, unset FLYCOMMERCE_TOKEN and submit again\./
    );
    assert.equal(posts().length, 1);
    assert.equal(app.status, 'unpublished');
  });

  it("passes on the hub's word when a token is refused before submitting", async () => {
    env.FLYCOMMERCE_TOKEN = portal.deployToken;
    portal.addApp({ appId: 'someone-elses' });
    fs.writeFileSync(path.join(dir, 'app-config.json'), JSON.stringify({ appId: 'someone-elses' }));
    portal.checklistAnswer = {
      status: 403,
      body: { error: 'token_not_allowed', message: 'This deploy token is for another app, not someone-elses.' },
    };

    try {
      const result = await cli(['--yes']);

      assert.equal(result.code, 1);
      assert.match(result.stderr, /Error: This deploy token is for another app, not someone-elses\./);
      assert.doesNotMatch(result.stderr, /can release but not submit/);
      assert.deepEqual(posts(), []);
    } finally {
      portal.checklistAnswer = undefined;
    }
  });

  it("shows the checklist's text as plain text", async () => {
    app.checklist.push({
      key: 'evil',
      label: 'Evil\u001b[2J\u202e',
      hint: '\u001b]8;;https://phish.example\u001b\\click\u001b]8;;\u001b\\',
      done: false,
      fixUrl: 'https://developers.example.com/\u0007fix',
    });

    const result = await cli(['--yes']);
    const text = result.stdout + result.stderr;

    assert.match(text, /✗ Evil\n {6}click\n {6}Fix it: https:\/\/developers\.example\.com\/fix/);
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e]/.test(text), JSON.stringify(text));
  });

  it('describes itself in its help', async () => {
    const help = await cli(['--help']);

    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: flycommerce app submit \[--config <name>\] \[--notes <text>\] \[--yes\]/);
    assert.match((await runCli(['--help'], { env, cwd: dir })).stdout, /app submit {7}Check the review checklist/);
  });
});
