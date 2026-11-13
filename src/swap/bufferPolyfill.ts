/**
 * globalThis.Buffer for @ton/core and @ton/crypto, which use it without an
 * import (providers.md §2.2). Imported first by the Omniston chunk so that
 * chunk does not depend on src/polyfills.ts having run.
 */
import {Buffer} from "buffer";

const g = globalThis as {Buffer?: typeof Buffer};
g.Buffer ??= Buffer;

export {};
