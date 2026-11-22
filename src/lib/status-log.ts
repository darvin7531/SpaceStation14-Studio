export interface StatusRecord {
  id: number;
  at: string;
  message: string;
  kind: 'info' | 'warning' | 'error';
}

export function appendStatusRecord(
  previous: readonly StatusRecord[],
  incoming: StatusRecord,
  limit = 80,
): StatusRecord[] {
  if (!Number.isSafeInteger(incoming.id) || incoming.id < 0 || limit <= 0) return [...previous];
  return [incoming, ...previous].slice(0, Math.min(80, Math.floor(limit)));
}
