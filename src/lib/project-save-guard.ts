// Ignore completion from a workspace instance that has since been replaced.
export async function completeProjectSave<T>(
  save: Promise<T>, current: () => boolean, apply: (result: T) => void, cleanup: () => Promise<void>,
): Promise<boolean> {
  const result = await save;
  if (!current()) return false;
  apply(result);
  await cleanup();
  return current();
}
