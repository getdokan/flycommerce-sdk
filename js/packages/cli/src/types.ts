/** The developer API's answers. */
export type AppStatus = 'unpublished' | 'published' | 'pending' | 'rejected';

export interface AppSummary {
  appId: string;
  name: string;
  status: AppStatus;
  published: boolean;
}

export interface AppVersionSummary {
  versionId: number;
  version: string;
  title: string;
  releasedAt: string | null;
}

export interface AppDetails {
  appId: string;
  name: string;
  status: AppStatus;
  redirectUrl: string | null;
  versions: AppVersionSummary[];
}

export interface DevConfigResult {
  appUrl: string;
  pages: { label: string; slug: string; url: string; children?: DevConfigResult['pages'] }[];
  scripts: { handle: string; src: string; load: string }[];
  installUrl: string;
  /** The redirect URL the hub now holds for the app, or null when the config sets none. */
  redirectUrl?: string | null;
  /** The push added permissions the existing installs don't have. */
  reinstallRequired?: boolean;
  message?: string;
}

export interface ReleaseResult {
  versionId: number;
  version: string;
  released: boolean;
  /** Page slugs, then script handles, then install.redirectUrl when the redirect changed. */
  awaitingReview: string[];
  /** false when the app itself awaits review; read with status, whichever the hub sends. */
  live?: boolean;
  status?: AppStatus;
}

export interface ChecklistItem {
  key: string;
  label: string;
  hint: string;
  done: boolean;
  fixUrl: string;
}

export interface Checklist {
  status: AppStatus;
  ready: boolean;
  submittedAt: string | null;
  items: ChecklistItem[];
}

export interface SubmitResult {
  status: AppStatus;
  submittedAt: string | null;
}

export interface CreatedApp {
  appId: string;
  name: string;
  status: AppStatus;
  /** Shown once: only its hash is kept. */
  secret: string;
}

export interface AppStatusDetails {
  appId: string;
  name: string;
  status: AppStatus;
  published: boolean;
  liveVersion: { versionId: number; version: string; releasedAt: string | null } | null;
  waitingVersion: { versionId: number; version: string } | null;
  awaitingReview: string[];
  checklist: { ready: boolean; outstanding: string[] };
  /** stores is null for a published app: merchants' stores are theirs to disclose. */
  installs: { active: number; stores: { host: string | null; installedAt: string | null }[] | null };
  devPushedAt: string | null;
  urls: { portal: string; versions: string; publishing: string; installUrl: string };
}

export interface DeployToken {
  id: number;
  name: string;
  createdAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface CreatedDeployToken {
  /** Shown once. */
  token: string;
  name: string;
  expiresAt: string | null;
}

/** The platform an app's server talks to, from the portal the CLI is signed in to. */
export interface PlatformEnvironment {
  hubApiUrl: string;
  jwksUrl: string;
  allowedIssuers: string[];
  /** Space-separated, as FRAME_ANCESTORS takes it. */
  frameAncestors: string;
  portalUrl: string;
}
