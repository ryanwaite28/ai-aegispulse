package io.aegispulse.platform.db;

import java.util.regex.Pattern;

/**
 * Schema identifiers are fixed per service (never user input); validated and quoted before use in
 * SQL.
 */
public final class SqlIdentifiers {
  private static final Pattern SCHEMA = Pattern.compile("^[a-z][a-z_]*$");

  private SqlIdentifiers() {}

  public static String table(String schema, String table) {
    if (!SCHEMA.matcher(schema).matches() || !SCHEMA.matcher(table).matches()) {
      throw new IllegalArgumentException("invalid identifier");
    }
    return "\"" + schema + "\"." + table;
  }
}
