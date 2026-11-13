// The web subset of @cp0x/shared (chains + format). Owner: catalog. `@cp0x/shared` resolves here (vite alias + tsconfig paths),
// so files copied verbatim from the wallet keep their imports. api.ts / cp0x.ts / positions.ts are cp0x-api shapes: not copied.
export * from "./chains";
export * from "./format";
