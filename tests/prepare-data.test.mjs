import assert from "node:assert/strict";
import test from "node:test";

import {
  claimServiceDate,
  compareSourcePaths,
  createFieldIndexes,
  createStableFlightId,
  summarizeDatasetPeriod,
} from "../scripts/prepare-data-helpers.mjs";

test("source headers accept OP_CARRIER as an optional fallback", () => {
  const headers = ["YEAR", "OP_UNIQUE_CARRIER"];
  assert.deepEqual(
    createFieldIndexes(
      headers,
      ["YEAR", "OP_UNIQUE_CARRIER"],
      ["OP_CARRIER"],
      "Jan.csv",
    ),
    { YEAR: 0, OP_UNIQUE_CARRIER: 1 },
  );
  assert.throws(
    () => createFieldIndexes(headers, ["YEAR", "TAIL_NUM"], [], "Jan.csv"),
    /Jan\.csv is missing required field TAIL_NUM/,
  );
});

test("additional source files do not change an existing month's flight IDs", () => {
  const mayId = createStableFlightId("2026-05-01", 42);
  const files = [
    "T_ONTIME_REPORTING.csv",
    "T_ONTIME_REPORTING_2026_06.csv",
  ].sort(compareSourcePaths);

  assert.deepEqual(files, [
    "T_ONTIME_REPORTING.csv",
    "T_ONTIME_REPORTING_2026_06.csv",
  ]);
  assert.equal(createStableFlightId("2026-05-01", 42), mayId);
  assert.notEqual(createStableFlightId("2026-06-01", 42), mayId);
});

test("overlapping service dates in separate exports are rejected", () => {
  const owners = new Map();
  claimServiceDate(owners, "2026-05-01", "work/T_ONTIME_REPORTING_MAY.csv");
  claimServiceDate(owners, "2026-05-01", "work/T_ONTIME_REPORTING_MAY.csv");

  assert.throws(
    () => claimServiceDate(
      owners,
      "2026-05-01",
      "work/T_ONTIME_REPORTING_COPY.csv",
    ),
    /Overlapping service date 2026-05-01.*T_ONTIME_REPORTING_MAY\.csv.*T_ONTIME_REPORTING_COPY\.csv/,
  );
});

test("dataset month metadata is only set for one unique year-month", () => {
  assert.deepEqual(
    summarizeDatasetPeriod(["2026-05-01", "2026-05-31"]),
    { year: 2026, month: 5, startDate: "2026-05-01", endDate: "2026-05-31" },
  );
  assert.deepEqual(
    summarizeDatasetPeriod(["2025-05-01", "2026-05-01"]),
    { year: null, month: null, startDate: "2025-05-01", endDate: "2026-05-01" },
  );
});
