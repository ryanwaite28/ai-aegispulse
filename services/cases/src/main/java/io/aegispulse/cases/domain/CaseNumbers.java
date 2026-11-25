package io.aegispulse.cases.domain;

/** Per-tenant case numbers {@code AP-{yyyy}-{000001}} (FR-CASE-01). */
public final class CaseNumbers {
  private CaseNumbers() {}

  public static String format(int year, int value) {
    if (value < 1 || value > 999_999) {
      throw new IllegalArgumentException("case sequence out of range: " + value);
    }
    return String.format(java.util.Locale.ROOT, "AP-%04d-%06d", year, value);
  }
}
