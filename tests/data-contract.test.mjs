import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

import {
  compareRecordedReplay,
  simulateFlightDelay,
} from "../app/lib/simulation.ts";
import { inflateFlightChunk } from "../app/lib/flight-data.ts";

const publicRoot = new URL("../public/", import.meta.url);
const dataRoot = new URL("../public/data/", import.meta.url);
const expectedFields = [
  "id",
  "flightNumber",
  "tail",
  "origin",
  "destination",
  "originId",
  "destinationId",
  "scheduledDeparture",
  "scheduledArrival",
  "scheduledElapsed",
  "distance",
  "cancelled",
  "diverted",
  "actualDepartureDelay",
  "nextFlightId",
];

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

test("manifest indexes every compact day/carrier chunk", async () => {
  const [manifest, diagnostics] = await Promise.all([
    readJson(new URL("manifest.json", dataRoot)),
    readJson(new URL("diagnostics.json", dataRoot)),
  ]);

  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.dates.length, 151);
  assert.deepEqual(manifest.dates, [...new Set(manifest.dates)].sort());
  const expectedDates = Array.from({ length: 151 }, (_, offset) =>
    new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10));
  assert.deepEqual(manifest.dates, expectedDates);
  for (const includedDate of [
    "2026-01-01", "2026-01-31",
    "2026-02-01", "2026-02-28",
    "2026-03-01", "2026-03-31",
    "2026-04-01", "2026-04-30",
    "2026-05-01", "2026-05-31",
  ]) {
    assert.ok(manifest.dates.includes(includedDate), `Missing included date ${includedDate}`);
  }
  assert.deepEqual(
    [...manifest.dataset.sourceFiles].sort(),
    [
      "T_ONTIME_REPORTING.csv",
      "T_ONTIME_REPORTING_2026_01.csv",
      "T_ONTIME_REPORTING_2026_02.csv",
      "T_ONTIME_REPORTING_2026_03.csv",
      "T_ONTIME_REPORTING_2026_04.csv",
    ].sort(),
  );
  assert.equal(manifest.dataset.startDate ?? manifest.dates[0], manifest.dates[0]);
  assert.equal(
    manifest.dataset.endDate ?? manifest.dates.at(-1),
    manifest.dates.at(-1),
  );
  assert.ok(manifest.carriers.length >= 10);
  assert.ok(manifest.totals.flights > 2_800_000);
  assert.equal(
    manifest.chunks.reduce((sum, chunk) => sum + chunk.flightCount, 0),
    manifest.totals.flights,
  );
  assert.equal(manifest.metadata.airportCodeMatchRate, 1);
  assert.equal(manifest.metadata.coordinateMatchRate, 1);
  assert.equal(diagnostics.includedFlights, manifest.totals.flights);
  assert.equal(diagnostics.sourceRows, diagnostics.includedFlights + 1);
  assert.equal(diagnostics.skippedMissingScheduledFields, 1);

  await Promise.all(
    manifest.chunks.map((chunk) => {
      assert.match(chunk.path, /^\/data\/days\/\d{4}-\d{2}-\d{2}\/[A-Z0-9]+\.json$/);
      return access(new URL(`.${chunk.path}`, publicRoot));
    }),
  );

  const outputFiles = [
    new URL("manifest.json", dataRoot),
    new URL("airports.json", dataRoot),
    new URL("diagnostics.json", dataRoot),
    ...manifest.chunks.map((chunk) => new URL(`.${chunk.path}`, publicRoot)),
  ];
  const outputBytes = (await Promise.all(outputFiles.map((file) => stat(file))))
    .reduce((sum, file) => sum + file.size, 0);
  assert.ok(
    outputBytes < 256 * 1024 * 1024,
    `Prepared data is ${(outputBytes / 1024 / 1024).toFixed(2)} MiB and exceeds the host limit`,
  );
});

test("flight chunk inflation supports compact and legacy IDs", () => {
  const compact = inflateFlightChunk({
    date: "2026-05-01",
    carrier: "AA",
    flightIdPrefix: "f20260501-",
    flights: [
      {
        id: "16", flightNumber: "1", tail: "N1", origin: "DFW", destination: "ORD",
        originId: 1, destinationId: 2, scheduledDeparture: 60, scheduledArrival: 180,
        scheduledElapsed: 120, distance: 800, cancelled: false, diverted: false,
        nextFlightId: "17",
      },
      {
        id: "17", flightNumber: "2", tail: "N1", origin: "ORD", destination: "DFW",
        originId: 2, destinationId: 1, scheduledDeparture: 240, scheduledArrival: 360,
        scheduledElapsed: 120, distance: 800, cancelled: false, diverted: false,
        nextFlightId: null,
      },
    ],
  });
  assert.deepEqual(compact.map((flight) => flight.id), ["f20260501-16", "f20260501-17"]);
  assert.equal(compact[0].nextFlightId, "f20260501-17");

  const legacy = inflateFlightChunk({
    date: "2026-05-01",
    carrier: "AA",
    flights: compact,
  });
  assert.deepEqual(legacy.map((flight) => flight.id), ["f20260501-16", "f20260501-17"]);
  assert.throws(
    () => inflateFlightChunk({
      date: "2026-05-01",
      carrier: "AA",
      flightIdPrefix: "f20260430-",
      flights: [],
    }),
    /does not match chunk date/,
  );
});

test("a representative chunk inflates into valid rotations and simulations", async () => {
  const manifest = await readJson(new URL("manifest.json", dataRoot));
  const representative = manifest.chunks
    .filter((chunk) => chunk.flightCount > 2_000)
    .sort((a, b) => b.flightCount - a.flightCount)[0] ?? manifest.chunks[0];
  assert.ok(representative, "Expected at least one carrier-day chunk");
  const [chunk, airportPayload] = await Promise.all([
    readJson(new URL(`.${representative.path}`, publicRoot)),
    readJson(new URL("airports.json", dataRoot)),
  ]);

  assert.deepEqual(chunk.flightFields, expectedFields);
  assert.ok(chunk.flights.length > 2_000);
  assert.ok(chunk.flights.every((row) => row.length === expectedFields.length));
  assert.equal(chunk.flightIdPrefix, `f${chunk.date.replaceAll("-", "")}-`);
  assert.ok(chunk.flights.every((row) => !String(row[0]).startsWith(chunk.flightIdPrefix)));

  const flights = inflateFlightChunk(chunk);
  assert.ok(flights.every((flight) => flight.id.startsWith(chunk.flightIdPrefix)));
  const byId = new Map(flights.map((flight) => [flight.id, flight]));
  const airports = new Map(airportPayload.airports.map((airport) => [airport.code, airport]));
  const linked = flights.filter((flight) => flight.nextFlightId);

  const flightsByTail = new Map();
  for (const flight of flights) {
    if (!flight.tail) continue;
    const rotation = flightsByTail.get(flight.tail) ?? [];
    rotation.push(flight);
    flightsByTail.set(flight.tail, rotation);
  }
  for (const rotation of flightsByTail.values()) {
    rotation.sort((left, right) =>
      left.scheduledDeparture - right.scheduledDeparture || left.id.localeCompare(right.id));
    for (let index = 0; index < rotation.length - 1; index += 1) {
      const current = rotation[index];
      const next = rotation[index + 1];
      assert.equal(
        current.nextFlightId,
        current.destination === next.origin ? next.id : null,
        `Unexpected airport link from ${current.id} to ${next.id}`,
      );
    }
  }

  assert.ok(linked.length > 1_000);
  for (const flight of linked.slice(0, 250)) {
    const next = byId.get(flight.nextFlightId);
    assert.ok(next, `Missing next flight ${flight.nextFlightId}`);
    assert.equal(flight.tail, next.tail);
    assert.equal(flight.destination, next.origin);
  }

  assert.ok(
    airportPayload.airports.every(
      (airport) => Number.isFinite(airport.latitude) && Number.isFinite(airport.longitude),
    ),
  );
  for (const flight of flights.slice(0, 500)) {
    const origin = airports.get(flight.origin);
    const destination = airports.get(flight.destination);
    assert.ok(Number.isFinite(origin?.latitude) && Number.isFinite(origin?.longitude));
    assert.ok(Number.isFinite(destination?.latitude) && Number.isFinite(destination?.longitude));
  }

  const seed = linked.find((flight) => flight.actualDepartureDelay >= 30) ?? linked[0];
  const result = simulateFlightDelay(flights, seed.id, Math.max(60, seed.actualDepartureDelay ?? 0));
  assert.ok(result.summary.affectedFlightCount >= 1);
  assert.equal(result.affectedFlights[0].flightId, seed.id);
  assert.ok(result.delayedRouteKeys.includes(`${seed.origin}-${seed.destination}`));

  const replaySeed = linked.find((flight) => {
    const next = byId.get(flight.nextFlightId);
    return (
      flight.actualDepartureDelay >= 30
      && !flight.cancelled
      && !flight.diverted
      && next
      && !next.cancelled
      && !next.diverted
      && Number.isFinite(next.actualDepartureDelay)
    );
  });
  assert.ok(replaySeed, "Expected a recorded-delay seed with a known later departure");
  const replay = compareRecordedReplay(flights, replaySeed.id);
  const recordedNext = byId.get(replaySeed.nextFlightId);
  assert.equal(replay.modeled.affectedFlights[0].flightId, replaySeed.id);
  assert.equal(replay.downstreamLegs[0].flightId, replaySeed.nextFlightId);
  assert.equal(
    replay.downstreamLegs[0].recordedDepartureDelayMinutes,
    recordedNext.actualDepartureDelay,
  );
});
