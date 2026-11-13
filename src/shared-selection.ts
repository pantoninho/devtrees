/**
 * Moved: shared-service selection is src/selection.ts, shared drift
 * src/shared-drift.ts. Re-exported here until the remaining importers move.
 */

export {
  hasNamespacedShared,
  isAlwaysOnShared,
  selectSharedServices,
  sharedServicesOf,
} from "./selection.js";
export * from "./shared-drift.js";
