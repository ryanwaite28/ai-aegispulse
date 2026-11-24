package io.aegispulse.registry.domain;

import io.aegispulse.platform.errors.DomainException;
import java.util.ArrayList;
import java.util.List;
import me.gosimple.nbvcxz.Nbvcxz;
import me.gosimple.nbvcxz.resources.ConfigurationBuilder;
import me.gosimple.nbvcxz.resources.Dictionary;
import me.gosimple.nbvcxz.resources.DictionaryBuilder;

/**
 * FR-TEN-04 password policy: 14–256 characters and a zxcvbn-equivalent (nbvcxz) score ≥ 3, with the
 * user's own identifiers penalized like zxcvbn {@code user_inputs}. Never echoes the password.
 */
public final class PasswordPolicy {
  public static final int MIN_LENGTH = 14;
  public static final int MAX_LENGTH = 256;
  public static final int MIN_SCORE = 3;

  private PasswordPolicy() {}

  /** Throws 422 AUTH_PASSWORD_POLICY when the password fails the policy. */
  public static void check(String password, List<String> userInputs) {
    int length = password.codePointCount(0, password.length());
    if (length < MIN_LENGTH || length > MAX_LENGTH) {
      throw violation("must be " + MIN_LENGTH + "-" + MAX_LENGTH + " characters");
    }
    if (score(password, userInputs) < MIN_SCORE) {
      throw violation("is too easy to guess (strength score below " + MIN_SCORE + ")");
    }
  }

  static int score(String password, List<String> userInputs) {
    DictionaryBuilder words = new DictionaryBuilder().setDictionaryName("user").setExclusion(true);
    for (String input : userInputs) {
      if (!input.isBlank()) {
        words.addWord(input.toLowerCase(java.util.Locale.ROOT), 0);
      }
    }
    List<Dictionary> dictionaries = new ArrayList<>(ConfigurationBuilder.getDefaultDictionaries());
    dictionaries.add(words.createDictionary());
    Nbvcxz nbvcxz =
        new Nbvcxz(new ConfigurationBuilder().setDictionaries(dictionaries).createConfiguration());
    return nbvcxz.estimate(password).getBasicScore();
  }

  private static DomainException violation(String issue) {
    return new DomainException.Validation(
        "AUTH_PASSWORD_POLICY",
        "password does not meet the policy",
        List.of(new DomainException.ErrorDetail("password", issue)));
  }
}
