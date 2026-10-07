/** The hub's limits on a version's details. */
export const LIMITS = { title: 80, changelog: 5000, tags: 5, tag: 30 } as const;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^[a-z0-9]+(?:[ -][a-z0-9]+)*$/;
const HEADER = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^()\r\n]*)\))?(?<bang>!)?:[ \t]+(?<description>\S.*)$/;
const GIT_REVERT = /^Revert ".+"$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:[ \t]*\S/m;
const RELEASABLE = ['feat', 'fix', 'perf', 'refactor', 'revert'];

export type Bump = 'major' | 'minor' | 'patch';
export type Section = 'Breaking changes' | 'Features' | 'Fixes' | 'Other';
const SECTIONS: Section[] = ['Breaking changes', 'Features', 'Fixes', 'Other'];

export interface Commit {
  hash: string;
  subject: string;
  body: string;
}

export interface Entry {
  section: Section;
  scope?: string;
  description: string;
}

export interface Analysis {
  bump?: Bump;
  entries: Entry[];
  skipped: number;
}

export function isVersion(value: string): boolean {
  return SEMVER.test(value);
}

export function parseVersion(value: string): [number, number, number] {
  const match = SEMVER.exec(value);
  if (!match) throw new Error(`Not a version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

export function highestVersion(versions: string[]): string | undefined {
  return versions.filter(isVersion).sort(compareVersions).at(-1);
}

/** Below 1.0.0 a breaking change bumps the minor number, as semver allows. */
export function nextVersion(previous: string | undefined, bump: Bump): string {
  if (previous === undefined) return '1.0.0';
  const [major, minor, patch] = parseVersion(previous);
  if (bump === 'major' && major > 0) return `${major + 1}.0.0`;
  if (bump === 'major' || bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Conventional Commits to a bump and changelog entries, oldest first; chores and the like only with includeAll. */
export function analyze(commits: Commit[], includeAll = false): Analysis {
  const entries: Entry[] = [];
  let bump: Bump | undefined;
  let skipped = 0;
  const raise = (to: Bump) => {
    const order: Bump[] = ['patch', 'minor', 'major'];
    if (bump === undefined || order.indexOf(to) > order.indexOf(bump)) bump = to;
  };

  for (const commit of commits) {
    const subject = commit.subject.trim();
    const header = HEADER.exec(subject)?.groups;
    const type = header?.type.toLowerCase() ?? (GIT_REVERT.test(subject) ? 'revert' : undefined);
    const scope = header?.scope?.trim() || undefined;
    const description = header?.description.trim() ?? subject;
    const breaking = header !== undefined && (header.bang === '!' || BREAKING_FOOTER.test(commit.body));

    let section: Section | undefined;
    if (breaking) section = 'Breaking changes';
    else if (type === 'feat') section = 'Features';
    else if (type === 'fix') section = 'Fixes';
    else if ((type !== undefined && RELEASABLE.includes(type)) || includeAll) section = 'Other';

    if (section === undefined || description === '') {
      skipped++;
      continue;
    }

    entries.push({ section, scope, description });
    raise(section === 'Breaking changes' ? 'major' : section === 'Features' ? 'minor' : 'patch');
  }

  return { bump, entries, skipped };
}

function bullet(entry: Entry): string {
  return entry.scope ? `- **${entry.scope}:** ${entry.description}` : `- ${entry.description}`;
}

function render(entries: Entry[], omitted: number): string {
  const blocks = SECTIONS.flatMap((section) => {
    const lines = entries.filter((entry) => entry.section === section).map(bullet);
    return lines.length === 0 ? [] : [`### ${section}\n\n${lines.join('\n')}`];
  });
  if (omitted > 0) blocks.push(`…and ${omitted} more ${omitted === 1 ? 'change' : 'changes'}.`);
  return blocks.join('\n\n');
}

/** Grouped markdown within the hub's length limit, dropping the last entries when it would run over. */
export function changelogMarkdown(entries: Entry[]): string {
  const ordered = SECTIONS.flatMap((section) => entries.filter((entry) => entry.section === section));

  for (let keep = ordered.length; keep > 0; keep--) {
    const text = render(ordered.slice(0, keep), ordered.length - keep);
    if (text.length <= LIMITS.changelog) return text;
  }
  return render([], ordered.length);
}

export function clampTitle(text: string): string {
  const title = text.replace(/\s+/g, ' ').trim();
  const capitalized = title.charAt(0).toUpperCase() + title.slice(1);
  return capitalized.length <= LIMITS.title ? capitalized : `${capitalized.slice(0, LIMITS.title - 1).trimEnd()}…`;
}

export function titleFor(entries: Entry[]): string | undefined {
  const lead =
    entries.find((entry) => entry.section === 'Breaking changes') ??
    entries.find((entry) => entry.section === 'Features') ??
    entries.find((entry) => entry.section === 'Fixes') ??
    entries[0];
  return lead && clampTitle(lead.description);
}

/** A scope as a hub tag: lower-case letters, numbers and single hyphens, at most 30 characters. */
function scopeTag(scope: string): string {
  return scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, LIMITS.tag)
    .replace(/^-+|-+$/g, '');
}

export function tagsFor(entries: Entry[]): string[] {
  const ordered = SECTIONS.flatMap((section) => entries.filter((entry) => entry.section === section));
  const scopes = ordered.flatMap((entry) => (entry.scope ? entry.scope.split(',').map(scopeTag) : []));
  return [...new Set(scopes.filter((tag) => tag !== ''))].slice(0, LIMITS.tags);
}

/** --tag values as the hub normalizes them, or the problems the hub would report. */
export function checkTags(tags: string[]): { tags: string[]; problems: string[] } {
  const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase().replace(/\s+/g, ' ')).filter((tag) => tag !== ''))];
  const problems = normalized.flatMap((tag) => {
    if (tag.length > LIMITS.tag) return [`"${tag}" is longer than ${LIMITS.tag} characters.`];
    if (!TAG.test(tag)) return [`"${tag}": tags use letters, numbers, spaces and hyphens.`];
    return [];
  });
  if (normalized.length > LIMITS.tags) problems.push(`Up to ${LIMITS.tags} tags; ${normalized.length} were given.`);
  return { tags: normalized, problems };
}
