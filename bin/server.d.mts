/** Types for bin/server.mjs (used by tests/unit/dist). Node's http types are kept structural on purpose: the app's
 * tsconfig has no @types/node, and adding it for one test would put Node globals into every browser module. */

export interface SiteFile {
  body: Uint8Array;
  type: string;
  etag: string;
}

/** The parts of IncomingMessage the handler reads. */
export interface RequestLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The parts of ServerResponse the handler writes. */
export interface ResponseLike {
  writeHead(status: number, headers?: Record<string, string | number>): unknown;
  end(body?: Uint8Array): unknown;
}

export interface HandlerOptions {
  files: Map<string, SiteFile>;
  configFile?: string | URL | null;
  allowedHosts?: readonly string[];
  extraConnect?: readonly string[];
}

export interface ServerHandle {
  server: {close(cb?: (err?: Error) => void): unknown};
  url: string;
}

export declare const MIME: Readonly<Record<string, string>>;
export declare const RUNTIME_CONFIG_PATH: string;
export declare function loadSite(where: string | URL): Promise<Map<string, SiteFile>>;
export declare function hostAllowed(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean;
export declare function requestPath(url: string | undefined): string | null;
export declare function createHandler(opts: HandlerOptions): (req: RequestLike, res: ResponseLike) => void;
export declare function startServer(opts: HandlerOptions & {port: number; host: string}): Promise<ServerHandle>;
export declare function browseHost(host: string): string;
export declare function isLoopbackHost(host: string): boolean;
