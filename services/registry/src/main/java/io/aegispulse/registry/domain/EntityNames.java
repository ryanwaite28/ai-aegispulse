package io.aegispulse.registry.domain;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * FR-ENT-01 name normalization, shared by names, aliases and resolution mentions: NFKC, lower case,
 * dots/apostrophes deleted, every other non-letter/digit run → one space, then trailing legal
 * suffixes stripped repeatedly (at least one token is always kept).
 */
public final class EntityNames {
  static final Set<String> LEGAL_SUFFIXES =
      Set.of("inc", "corp", "llc", "ltd", "plc", "holdings", "group", "sa", "ag", "nv");

  private EntityNames() {}

  public static String normalize(String raw) {
    String lowered = Normalizer.normalize(raw, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
    // Dots and apostrophes are deleted (S.A. → sa, O'Neil → oneil); other symbols become a space
    // (AT&T → at t).
    String spaced = lowered.replaceAll("[.'’]", "").replaceAll("[^\\p{L}\\p{Nd}]+", " ").strip();
    if (spaced.isEmpty()) {
      return "";
    }
    List<String> tokens = new ArrayList<>(Arrays.asList(spaced.split(" ")));
    while (tokens.size() > 1 && LEGAL_SUFFIXES.contains(tokens.getLast())) {
      tokens.removeLast();
    }
    return String.join(" ", tokens);
  }
}
