/** Return a complete SS14-style identifier under a 1-based editor column. */
export function identifierAtColumn(line: string, column: number): string | null {
  if (!Number.isInteger(column) || column < 1 || column > line.length + 1) return null;
  const allowed = (char: string | undefined) => char !== undefined && /[A-Za-z0-9_-]/.test(char);
  let cursor = column - 1;
  if (!allowed(line[cursor]) && allowed(line[cursor - 1])) cursor--;
  if (!allowed(line[cursor])) return null;
  let start = cursor;
  let end = cursor + 1;
  while (start > 0 && allowed(line[start - 1])) start--;
  while (end < line.length && allowed(line[end])) end++;
  const identifier = line.slice(start, end);
  return /^[A-Za-z_][A-Za-z0-9_-]{1,127}$/.test(identifier) ? identifier : null;
}
