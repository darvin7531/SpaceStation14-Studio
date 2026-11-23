/** Changing mode invalidates the previous file selection in either direction. */
export function toggleRsiImportMode(metadataOnly: boolean): { metadataOnly: boolean; file: null } {
  return { metadataOnly, file: null };
}
