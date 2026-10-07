/** Everything a command touches outside itself, so tests can run the CLI in-process. */
export interface Context {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  openUrl(url: string): void;
  /** Asks the person at the terminal; absent when there is nobody to ask. */
  prompt?: (question: string) => Promise<string>;
  /** Aborted on Ctrl+C: stops `app dev` and a waiting `login`. */
  signal?: AbortSignal;
  loginTimeoutMs?: number;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = []
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** A y/N question at the terminal; only y or yes agrees. */
export async function confirmed(prompt: NonNullable<Context['prompt']>, question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await prompt(question)).trim());
}
