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
