package io.aegispulse.fixture.good.db;

import org.springframework.jdbc.core.simple.JdbcClient;

/** Fixture: JDBC confined to ..db... */
public class CleanRepository {
  public int count() {
    return JdbcClient.class.getSimpleName().length();
  }
}
