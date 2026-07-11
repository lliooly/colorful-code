export type V2Boundary = {
  enabled: boolean;
  persistenceOwner: 'none';
};

// Phase -1 owns no 2.0 persistence. This boundary exists solely to prevent
// accidental registration or legacy-store dual writes before Phase 0A.
export function createV2Boundary(enabled: boolean): V2Boundary {
  return { enabled, persistenceOwner: 'none' };
}
