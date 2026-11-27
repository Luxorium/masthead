// Versions of `conversation.json`. 0.1.x files have no `format` and are format 1: the same shape, so
// moving to format 2 only stamps the version. Later formats add their steps here, one per version.

export const FORMAT = 2;

export interface Migrated<T> {
  value: T;
  /** The format the file was in; lower than FORMAT means it must be backed up before it is rewritten. */
  from: number;
}

/** Brings a parsed conversation file up to FORMAT, or returns null for a file newer than this version can read. */
export function migrateConversation<T extends { format?: number }>(raw: T): Migrated<T & { format: number }> | null {
  const from = typeof raw.format === 'number' ? raw.format : 1;
  if (from > FORMAT) return null;
  let value: T & { format: number } = { ...raw, format: from };
  if (value.format === 1) value = { ...value, format: 2 };
  return { value, from };
}
