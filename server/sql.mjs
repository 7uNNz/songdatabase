// Translate the fixed SQL statements used by this app; values stay parameterized.
export function postgresSQL(sql) {
  let result = '', quoted = false, index = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      if (quoted && sql[i + 1] === "'") { result += "''"; i++; continue; }
      quoted = !quoted;
    }
    result += c === '?' && !quoted ? '$' + (++index) : c;
  }
  return result.replace(/FROM json_each\((\$\d+)\)/g,
    'FROM jsonb_array_elements_text($1::jsonb) AS selected_ids(value)');
}
