package io.aegispulse.registry.domain;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class EntityNamesTest {
  @ParameterizedTest(name = "FR_ENT_01 \"{0}\" → \"{1}\"")
  @CsvSource(
      delimiter = '|',
      value = {
        "ACME Holdings, Inc.|acme",
        "Globex Clearing S.A.|globex clearing",
        "Umbrella Pharma AG|umbrella pharma",
        "Initech Securities LLC|initech securities",
        "Stark Analytics plc|stark analytics",
        "  Wayne   Enterprises,   Ltd  |wayne enterprises",
        "Hooli Group Holdings Inc|hooli",
        "Group|group",
        "Holdings Inc|holdings",
        "AT&T Inc.|at t",
        "Société Générale SA|société générale",
        "ＡＣＭＥ Corp|acme",
        "Groupon|groupon",
        "Inc. Magazine Group|inc magazine",
        "NV Energy Holdings|nv energy",
        "!!!|''"
      })
  void FR_ENT_01_normalizationTable(String raw, String expected) {
    assertThat(EntityNames.normalize(raw)).isEqualTo(expected);
  }
}
