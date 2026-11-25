package io.aegispulse.cases.domain;

import org.jspecify.annotations.Nullable;

/** FR-AUD-03 result: {@code firstBrokenSeq} is set only when {@code valid} is false. */
public record ChainVerification(boolean valid, long checked, @Nullable Long firstBrokenSeq) {
  public static ChainVerification ok(long checked) {
    return new ChainVerification(true, checked, null);
  }
}
