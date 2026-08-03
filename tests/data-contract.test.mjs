import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  compareRecordedReplay,
  linkAdjacentTailFlightsByAirport,
  simulateFlightDelay,
} from "../app/lib/simulation.ts";

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

function inflateChunk(chunk) {
  return chunk.flights.map((row) =>
    Object.fromEntries(chunk.flightFields.map((field, index) => [field, row[index]])),
  );
}

test("manifest indexes every compact day/carrier chunk", async () => {
  const manifest = await readJson(new URL("manifest.json", dataRoot));

  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.dates.length >= 1);
  assert.deepEqual(manifest.dates, [...new Set(manifest.dates)].sort());
  assert.equal(manifest.dataset.startDate ?? manifest.dates[0], manifest.dates[0]);
  assert.equal(
    manifest.dataset.endDate ?? manifest.dates.at(-1),
    manifest.dates.at(-1),
  );
  assert.ok(manifest.carriers.length >= 10);
  assert.ok(manifest.totals.flights > 500_000);
  assert.equal(
    manifest.chunks.reduce((sum, chunk) => sum + chunk.flightCount, 0),
    manifest.totals.flights,
  );
  assert.equal(manifest.metadata.airportCodeMatchRate, 1);
  assert.equal(manifest.metadata.coordinateMatchRate, 1);

  await Promise.all(
    manifest.chunks.map((chunk) => {
      assert.match(chunk.path, /^\/data\/days\/\d{4}-\d{2}-\d{2}\/[A-Z0-9]+\.json$/);
      return access(new URL(`.${chunk.path}`, publicRoot));
    }),
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

  const flights = linkAdjacentTailFlightsByAirport(inflateChunk(chunk));
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
