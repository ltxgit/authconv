export type BuildVersionInput = {
  packageVersion: string;
  buildSha?: string;
};

export function resolveBuildVersion(input: BuildVersionInput): string;
export function buildDisplayVersion(root: string, env?: NodeJS.ProcessEnv): Promise<string>;
