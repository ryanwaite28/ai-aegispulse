package io.aegispulse.registry.service;

import com.password4j.Argon2Function;
import com.password4j.Password;
import com.password4j.types.Argon2;
import org.springframework.stereotype.Component;

/** Argon2id with FR-TEN-04 parameters (m = 64 MiB, t = 3, p = 1), PHC string output. */
@Component
public class PasswordHasher {
  static final int MEMORY_KIB = 65_536;
  static final int ITERATIONS = 3;
  static final int PARALLELISM = 1;
  static final int TAG_BYTES = 32;
  static final int SALT_BYTES = 16;
  private static final Argon2Function ARGON2ID =
      Argon2Function.getInstance(MEMORY_KIB, ITERATIONS, PARALLELISM, TAG_BYTES, Argon2.ID, 19);

  public String hash(String password) {
    return Password.hash(password).addRandomSalt(SALT_BYTES).with(ARGON2ID).getResult();
  }

  public boolean verify(String password, String phc) {
    return Password.check(password, phc).with(Argon2Function.getInstanceFromHash(phc));
  }
}
