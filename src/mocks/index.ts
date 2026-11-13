// Fixtures and demo ports (D15). Owner: contracts/integrator. Used by App.tsx in demo mode, by the contracts-phase
// stubs, and by any module's tests that need realistic data.
export * from "./fixtures";
export {
  demoActivityPort,
  demoCatalogPort,
  demoExecutePort,
  demoPorts,
  demoSwapPort,
  demoWalletsPort,
  resetDemoState,
} from "./demoPorts";
