package io.aegispulse.registry.domain;

import io.aegispulse.platform.errors.DomainException;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/** FR-TEN-04 email: RFC 5322 dot-atom subset, ≤ 320 chars, stored trimmed and lower-case. */
public record EmailAddress(String value) {
  private static final Pattern DOT_ATOM =
      Pattern.compile(
          "^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
              + "@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$");

  public EmailAddress {
    if (value.length() > 320 || value.indexOf('@') > 64 || !DOT_ATOM.matcher(value).matches()) {
      throw new DomainException.Validation(
          "VALIDATION_ERROR",
          "request failed validation",
          List.of(new DomainException.ErrorDetail("email", "must be a valid email address")));
    }
  }

  public static EmailAddress parse(String raw) {
    return new EmailAddress(raw.strip().toLowerCase(Locale.ROOT));
  }

  public String localPart() {
    return value.substring(0, value.indexOf('@'));
  }
}
