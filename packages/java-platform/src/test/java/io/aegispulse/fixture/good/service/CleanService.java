package io.aegispulse.fixture.good.service;

import io.aegispulse.fixture.good.db.CleanRepository;

/** Fixture: transport-free service calling a repository. */
public class CleanService {
  private final CleanRepository repository = new CleanRepository();

  public int count() {
    return repository.count();
  }
}
