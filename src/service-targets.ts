/**
 * Moved: named-service targets are src/selection.ts (`selectNamedServices`).
 * Re-exported here until the remaining importers move.
 */

export {
  declaredServices,
  expandNamespaces,
  notBootedNamespaces,
  orderedTargets,
  sharedAmong,
  unbootedServices,
  unknownService,
  type DeclaredService,
  type NamespaceExpansion,
} from "./selection.js";
