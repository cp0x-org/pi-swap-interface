/** Types for verify-car.mjs, so its unit test (tests/unit/dist/verifyCar.test.ts) type-checks. */
export declare function cidText(bytes: Uint8Array): string;
export declare function verifyCar(car: Uint8Array, cid: string, manifest: Map<string, string>): {files: number; blocks: number};
export declare function readManifest(text: string): Map<string, string>;
