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
}

export interface ReleaseResult {
  versionId: number;
  version: string;
  released: boolean;
  /** Page slugs, then script handles. */
  awaitingReview: string[];
}
