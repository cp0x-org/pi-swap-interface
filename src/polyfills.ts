// Globals some provider dependencies expect at import time (Omniston/TON code
// reads Buffer). Imported first in main.tsx, before any provider module.
import {Buffer} from "buffer";

const g = globalThis as typeof globalThis & {Buffer?: typeof Buffer};
g.Buffer ??= Buffer;
