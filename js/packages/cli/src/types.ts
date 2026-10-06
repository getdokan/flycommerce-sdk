/** The developer API's answers. */
export interface AppSummary {
  appId: string;
  name: string;
  status: string;
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
  status: string;
  redirectUrl: string | null;
  versions: AppVersionSummary[];
}

export interface DevConfigResult {
  appUrl: string;
  pages: { label?: string; slug?: string; url?: string; path?: string; children?: DevConfigResult['pages'] }[];
  scripts: { handle?: string; src?: string; load?: string }[];
  installUrl: string;
}

export interface ReleaseResult {
  versionId: number;
  version: string;
  released: boolean;
  awaitingReview?: unknown[];
}
