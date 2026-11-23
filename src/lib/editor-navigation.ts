/** Reveal a navigation target and put keyboard input at its cursor. */
export function revealEditorLine(editor: {
  revealLineInCenter(line: number): void;
  setPosition(position: { lineNumber: number; column: number }): void;
  focus(): void;
}, line: number, focus = true): void {
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: 1 });
  if (focus) editor.focus();
}

/** Apply each navigation token once, including while its state is being cleared. */
export function consumeEditorJump(
  editor: Parameters<typeof revealEditorLine>[0],
  jump: { line?: number; token?: number; shouldFocus: () => boolean; consume: (token: number) => void },
  consumed: { current: number },
): void {
  if (!jump.line || !jump.token || jump.token === consumed.current) return;
  consumed.current = jump.token;
  revealEditorLine(editor, jump.line, jump.shouldFocus());
  jump.consume(jump.token);
}

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
