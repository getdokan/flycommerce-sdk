import { readConfigFile } from './config-file.js';
import { CliError, Context, confirmed } from './context.js';
import { ApiError, PortalApi } from './portal.js';
import { Checklist, ChecklistItem, SubmitResult } from './types.js';

const NOTES_LIMIT = 5000;

export interface SubmitOptions {
  config?: string;
  notes?: string;
  yes?: boolean;
}

function itemLines(item: ChecklistItem): string[] {
  const lines = [`  ${item.done ? '✓' : '✗'} ${item.label}`];
  if (!item.done && item.hint) lines.push(`      ${item.hint}`);
  if (!item.done && item.fixUrl) lines.push(`      Fix it: ${item.fixUrl}`);
  return lines;
}

/** The hub names what's outstanding by key; the checklist has their labels. */
function outstandingLines(details: Record<string, unknown>, items: ChecklistItem[]): string[] {
  const outstanding = Array.isArray(details.outstanding) ? details.outstanding : [];
  return outstanding.map((key) => {
    const item = items.find((candidate) => candidate.key === key);
    if (!item) return String(key);
    return item.fixUrl ? `${item.label}: ${item.fixUrl}` : item.label;
  });
}

const nothingToSubmit = (appId: string) =>
  `${appId} is published, so there's nothing to submit: changes to its pages, scripts, install redirect or permissions go to review when you release them.`;
const alreadyPending = (appId: string) => `${appId} is already waiting for FlyCommerce's review.`;
const rejected = 'This app was rejected. Contact support before resubmitting.';

export async function submit(ctx: Context, portal: string, options: SubmitOptions): Promise<void> {
  const notes = options.notes?.trim();
  if (options.notes !== undefined && !notes) throw new CliError('--notes is empty: write what the reviewer should know, or leave it out.');
  if (notes && notes.length > NOTES_LIMIT)
    throw new CliError(`--notes is ${notes.length} characters; FlyCommerce takes up to ${NOTES_LIMIT}.`);

  const { appId } = readConfigFile(ctx, options.config);
  const api = PortalApi.signedIn(portal, ctx);
  const appPath = `apps/${encodeURIComponent(appId)}`;
  const checklist = await api.get<Checklist>(`${appPath}/checklist`);
  const since = checklist.status === 'pending' && checklist.submittedAt ? `, submitted ${checklist.submittedAt.slice(0, 10)}` : '';

  ctx.stdout([`Review checklist for ${appId} (${checklist.status}${since})`, ...checklist.items.flatMap(itemLines)].join('\n'));

  // The hub refuses these before it looks at the checklist; no point asking.
  if (checklist.status === 'pending') return ctx.stdout(alreadyPending(appId));
  if (checklist.status === 'published') return ctx.stdout(nothingToSubmit(appId));
  if (checklist.status === 'rejected') throw new CliError(rejected);

  if (!checklist.ready) {
    const missing = checklist.items.filter((item) => !item.done).map((item) => item.label);
    throw new CliError(`${appId} isn't ready for review yet. Still to do:`, missing);
  }

  await confirm(ctx, options, `Submit ${appId} for FlyCommerce's review? (y/N) `);

  let result: SubmitResult;

  try {
    result = await api.post<SubmitResult>(`${appPath}/submit`, notes ? { reviewNotes: notes } : {});
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const hub = (fallback: string) => (typeof error.details.message === 'string' ? error.message : fallback);

    switch (error.code) {
      case 'token_not_allowed':
        throw new CliError(
          `Deploy tokens can release but not submit — run flycommerce login${api.usesEnvToken ? ', unset FLYCOMMERCE_TOKEN' : ''} and submit again.`
        );
      case 'checklist_incomplete':
        throw new CliError(hub(`${appId} isn't ready for review yet.`), outstandingLines(error.details, checklist.items));
      case 'app_rejected':
        throw new CliError(hub(rejected));
      case 'already_pending':
        return ctx.stdout(hub(alreadyPending(appId)));
      case 'nothing_to_submit':
        return ctx.stdout(hub(nothingToSubmit(appId)));
    }
    throw error;
  }

  ctx.stdout(`Submitted ${appId} for FlyCommerce's review (${result.status}). Run flycommerce app submit again to see where it stands.`);
}

async function confirm(ctx: Context, options: SubmitOptions, question: string): Promise<void> {
  if (options.yes) return;
  if (!ctx.prompt) throw new CliError('Nobody is at a terminal to confirm this: pass --yes to submit.');

  if (!(await confirmed(ctx.prompt, question))) throw new CliError('Cancelled; nothing was submitted.');
}
