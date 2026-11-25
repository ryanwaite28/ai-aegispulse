package io.aegispulse.cases.domain;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.jspecify.annotations.Nullable;

/**
 * FR-AUD-01 hashing: {@code hash = SHA-256(canonicalJSON(entry without hash) ‖ prevHash)}.
 * Canonical JSON follows RFC 8785 (JCS) for the value space the log uses: object keys sorted by
 * UTF-16 code units, minimal string escaping, no whitespace, and numbers in their shortest exact
 * decimal form ({@link BigDecimal#stripTrailingZeros()}), so a value reads back from JSONB hashes
 * the same. Pure.
 */
public final class AuditHash {
  public static final String GENESIS = "0".repeat(64);

  private AuditHash() {}

  public static String hash(Map<String, @Nullable Object> entryWithoutHash, String prevHash) {
    try {
      MessageDigest sha = MessageDigest.getInstance("SHA-256");
      sha.update(canonical(entryWithoutHash).getBytes(StandardCharsets.UTF_8));
      sha.update(prevHash.getBytes(StandardCharsets.US_ASCII));
      return HexFormat.of().formatHex(sha.digest());
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 unavailable", e);
    }
  }

  public static String canonical(@Nullable Object value) {
    StringBuilder out = new StringBuilder();
    write(value, out);
    return out.toString();
  }

  private static void write(@Nullable Object value, StringBuilder out) {
    switch (value) {
      case null -> out.append("null");
      case Boolean b -> out.append(b);
      case String s -> string(s, out);
      case BigDecimal d -> out.append(number(d));
      case Number n -> out.append(number(new BigDecimal(n.toString())));
      case Map<?, ?> m -> {
        TreeMap<String, @Nullable Object> sorted = new TreeMap<>();
        m.forEach((k, v) -> sorted.put(String.valueOf(k), v));
        out.append('{');
        boolean first = true;
        for (Map.Entry<String, @Nullable Object> e : sorted.entrySet()) {
          if (!first) {
            out.append(',');
          }
          first = false;
          string(e.getKey(), out);
          out.append(':');
          write(e.getValue(), out);
        }
        out.append('}');
      }
      case List<?> l -> {
        out.append('[');
        for (int i = 0; i < l.size(); i++) {
          if (i > 0) {
            out.append(',');
          }
          write(l.get(i), out);
        }
        out.append(']');
      }
      case Object[] a -> write(new ArrayList<>(List.of(a)), out);
      default -> string(value.toString(), out);
    }
  }

  private static String number(BigDecimal d) {
    return d.signum() == 0 ? "0" : d.stripTrailingZeros().toPlainString();
  }

  private static void string(String s, StringBuilder out) {
    out.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\b' -> out.append("\\b");
        case '\f' -> out.append("\\f");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20) {
            out.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
          } else {
            out.append(c);
          }
        }
      }
    }
    out.append('"');
  }
}
