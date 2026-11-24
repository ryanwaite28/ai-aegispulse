package io.aegispulse.fixture.bad.service;

import org.springframework.http.HttpStatus;

/** Fixture: a service that leaks a transport type (must fail the ArchUnit rule). */
public class LeakyService {
  public HttpStatus status() {
    return HttpStatus.OK;
  }
}
