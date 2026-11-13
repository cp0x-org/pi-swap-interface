/** Types for bin/cli.mjs (used by tests/unit/dist). */

export interface CliOptions {
  port: number;
  host: string;
  configFile: string | null;
  allowedHosts: string[];
  dir: string;
  openBrowser: boolean;
  version: boolean;
  help: boolean;
}

export declare function parseCliArgs(argv?: string[]): CliOptions;
export declare function main(argv?: string[]): Promise<void>;
