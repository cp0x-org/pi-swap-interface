/** Types for bin/headers.mjs, so TypeScript tests and vite.config.ts can import the header source of truth. */

export declare const CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]>;
export declare const LOCAL_CONNECT_SOURCES: readonly string[];
export declare function contentSecurityPolicy(opts?: {extraConnect?: readonly string[]; meta?: boolean}): string;
export declare const PERMISSIONS_POLICY: string;
export declare function securityHeaders(opts?: {extraConnect?: readonly string[]}): Record<string, string>;
export declare const IMMUTABLE_CACHE: string;
export declare const REVALIDATE_CACHE: string;
export declare function cacheControlFor(path: string): string;
