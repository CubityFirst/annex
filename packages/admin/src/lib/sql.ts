// SQLite LIKE treats % and _ as wildcards inside the *bound value* too, so a
// search for a literal "50%" would match "50 anything". Escape the wildcard
// characters (and the escape character itself) in user-supplied search text,
// and pair the bound value with LIKE_ESCAPE_CLAUSE in the SQL.
export const LIKE_ESCAPE_CLAUSE = "ESCAPE '\\'";

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
