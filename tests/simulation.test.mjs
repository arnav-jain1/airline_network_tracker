import assert from "node:assert/strict";
import test from "node:test";

import {
  compareRecordedReplay,
  getActualDelaySeedMinutes,
  simulateFlightDelay,
  simulateGroundStop,
} from "../app/lib/simulation.ts";

function flight(overrides) {
  return {
    id: "f1",
    flightNumber: "101",
    tail: "N101AA",
    origin: "AUS",
    destination: "DFW",
    originId: 1,
    destinationId: 2,
    scheduledDeparture: 60,
    actualDeparture: null,
    scheduledArrival: 180,
    actualArrival: null,
    scheduledElapsed: 120,
    actualElapsed: null,
    distance: 190,
    cancelled: false,
    diverted: false,
    actualDepartureDelay: null,
    nextFlightId: null,
    ...overrides,
  };
}

test("flight delay propagates through a tail rotation and uses ground time as recovery", () => {
  const flights = [
    flight({ id: "f1", nextFlightId: "f2" }),
    flight({
      id: "f2",
      origin: "DFW",
      destination: "DEN",
      scheduledDeparture: 220,
      scheduledArrival: 280,
      scheduledElapsed: 60,
      nextFlightId: "f3",
    }),
    flight({
      id: "f3",
      origin: "DEN",
      destination: "SEA",
      scheduledDeparture: 330,
      scheduledArrival: 450,
      scheduledElapsed: 120,
    }),
  ];

  const result = simulateFlightDelay(flights, "f1", 60, 35);

  assert.deepEqual(
    result.affectedFlights.map(({ flightId, departureDelayMinutes }) => [
      flightId,
      departureDelayMinutes,
    ]),
    [
      ["f1", 60],
      ["f2", 55],
      ["f3", 40],
    ],
  );
  assert.deepEqual(result.delayedRouteKeys, ["AUS-DFW", "DFW-DEN", "DEN-SEA"]);
  assert.equal(result.summary.totalDelayMinutes, 155);
  assert.equal(result.summary.propagatedFlightCount, 2);
});

test("broken airport continuity stops propagation", () => {
  const flights = [
    flight({ id: "f1", nextFlightId: "f2" }),
    flight({ id: "f2", origin: "IAH", scheduledDeparture: 200 }),
  ];

  const result = simulateFlightDelay(flights, "f1", 45);

  assert.deepEqual(result.affectedFlights.map((impact) => impact.flightId), ["f1"]);
  assert.equal(result.stops[0]?.reason, "airport-mismatch");
});

test("ground stop holds departures in a normal half-open window and propagates", () => {
  const flights = [
    flight({
      id: "f1",
      scheduledDeparture: 100,
      scheduledArrival: 160,
      scheduledElapsed: 60,
      nextFlightId: "f2",
    }),
    flight({
      id: "f2",
      origin: "DFW",
      destination: "DEN",
      scheduledDeparture: 190,
      scheduledElapsed: 60,
    }),
    flight({ id: "outside", scheduledDeparture: 180 }),
  ];

  const result = simulateGroundStop(flights, "aus", 90, 180, 35);

  assert.equal(result.impacts.f1.departureDelayMinutes, 80);
  assert.equal(result.impacts.f2.departureDelayMinutes, 85);
  assert.equal(result.impacts.outside, undefined);
  assert.equal(result.summary.seedFlightCount, 1);
});

test("ground stop handles a window crossing midnight", () => {
  const flights = [
    flight({ id: "late", scheduledDeparture: 23 * 60 + 30 }),
    flight({ id: "early", scheduledDeparture: 60 }),
    flight({ id: "middle", scheduledDeparture: 12 * 60 }),
  ];

  const result = simulateGroundStop(flights, "AUS", 23 * 60, 2 * 60);

  assert.equal(result.impacts.late.departureDelayMinutes, 150);
  assert.equal(result.impacts.early.departureDelayMinutes, 60);
  assert.equal(result.impacts.middle, undefined);
});

test("actual-delay seed prefers BTS delay and handles a midnight clock fallback", () => {
  assert.equal(
    getActualDelaySeedMinutes(
      flight({ actualDepartureDelay: 27, actualDeparture: 200, scheduledDeparture: 100 }),
    ),
    27,
  );
  assert.equal(
    getActualDelaySeedMinutes(
      flight({ actualDepartureDelay: null, scheduledDeparture: 23 * 60 + 50, actualDeparture: 20 }),
    ),
    30,
  );
  assert.equal(
    getActualDelaySeedMinutes(
      flight({ actualDepartureDelay: null, scheduledDeparture: 20, actualDeparture: 23 * 60 + 40 }),
    ),
    0,
  );
});

test("recorded replay compares the modeled ripple with every later same-tail departure", () => {
  const flights = [
    flight({
      id: "f1",
      actualDepartureDelay: 60,
      nextFlightId: "f2",
    }),
    flight({
      id: "f2",
      origin: "DFW",
      destination: "DEN",
      scheduledDeparture: 220,
      scheduledArrival: 280,
      actualDepartureDelay: 42,
      nextFlightId: "f3",
    }),
    flight({
      id: "f3",
      origin: "DEN",
      destination: "SEA",
      scheduledDeparture: 400,
      scheduledArrival: 520,
      actualDepartureDelay: 0,
    }),
  ];

  const result = compareRecordedReplay(flights, "f1", 35);

  assert.equal(result.modeled.impacts.f2.departureDelayMinutes, 55);
  assert.equal(result.modeled.impacts.f3, undefined);
  assert.deepEqual(
    result.downstreamLegs.map((leg) => [
      leg.flightId,
      leg.modeledDelayMinutes,
      leg.modeledStatus,
      leg.recordedDepartureDelayMinutes,
      leg.status,
    ]),
    [
      ["f2", 55, "delayed", 42, "delayed"],
      ["f3", 0, "recovered", 0, "on-time-or-early"],
    ],
  );
  assert.equal(result.summary.modeledDelayedLegCount, 1);
  assert.equal(result.summary.recordedDelayedLegCount, 1);
  assert.equal(result.summary.knownRecordedLegCount, 2);
  assert.equal(result.summary.recordedDownstreamDelayMinutes, 42);
  assert.deepEqual(result.recordedDelayedRouteKeys, ["DFW-DEN"]);
});

test("recorded replay includes and stops at a cancelled later leg", () => {
  const flights = [
    flight({ id: "f1", actualDepartureDelay: 25, nextFlightId: "f2" }),
    flight({
      id: "f2",
      origin: "DFW",
      destination: "DEN",
      scheduledDeparture: 220,
      cancelled: true,
      actualDepartureDelay: null,
      nextFlightId: "f3",
    }),
    flight({
      id: "f3",
      origin: "DEN",
      destination: "SEA",
      scheduledDeparture: 400,
      actualDepartureDelay: 18,
    }),
  ];

  const result = compareRecordedReplay(flights, "f1", 35);

  assert.deepEqual(result.downstreamLegs.map((leg) => leg.flightId), ["f2"]);
  assert.equal(result.downstreamLegs[0].status, "cancelled");
  assert.equal(result.downstreamLegs[0].modeledStatus, "stopped");
  assert.equal(result.summary.cancelledCount, 1);
  assert.equal(result.summary.knownRecordedLegCount, 0);
  assert.deepEqual(result.recordedDelayedRouteKeys, []);
});

test("recorded replay counts a diverted leg's known departure delay before stopping", () => {
  const flights = [
    flight({ id: "f1", actualDepartureDelay: 40, nextFlightId: "f2" }),
    flight({
      id: "f2",
      origin: "DFW",
      destination: "DEN",
      scheduledDeparture: 220,
      diverted: true,
      actualDepartureDelay: 23,
      nextFlightId: "f3",
    }),
    flight({
      id: "f3",
      origin: "DEN",
      destination: "SEA",
      scheduledDeparture: 400,
      actualDepartureDelay: 18,
    }),
  ];

  const result = compareRecordedReplay(flights, "f1", 35);

  assert.deepEqual(result.downstreamLegs.map((leg) => leg.flightId), ["f2"]);
  assert.equal(result.downstreamLegs[0].status, "diverted");
  assert.equal(result.downstreamLegs[0].modeledStatus, "stopped");
  assert.equal(result.summary.divertedCount, 1);
  assert.equal(result.summary.knownRecordedLegCount, 1);
  assert.equal(result.summary.recordedDelayedLegCount, 1);
  assert.equal(result.summary.recordedDownstreamDelayMinutes, 23);
});

test("recorded replay reports recovery, not a model stop, for a later cancellation beyond the ripple", () => {
  const flights = [
    flight({
      id: "f1",
      actualDepartureDelay: 10,
      nextFlightId: "f2",
    }),
    flight({
      id: "f2",
      origin: "DFW",
      destination: "DEN",
      scheduledDeparture: 300,
      scheduledArrival: 360,
      actualDepartureDelay: 0,
      nextFlightId: "f3",
    }),
    flight({
      id: "f3",
      origin: "DEN",
      destination: "SEA",
      scheduledDeparture: 420,
      cancelled: true,
      actualDepartureDelay: null,
    }),
  ];

  const result = compareRecordedReplay(flights, "f1", 35);

  assert.equal(result.modeled.stops.length, 0);
  assert.equal(result.downstreamLegs[0].modeledStatus, "recovered");
  assert.equal(result.downstreamLegs[1].modeledStatus, "recovered");
  assert.equal(result.downstreamLegs[1].status, "cancelled");
});

test("recorded replay does not traverse onward from an invalid selected seed", () => {
  for (const invalid of [
    { cancelled: true, diverted: false },
    { cancelled: false, diverted: true },
  ]) {
    const flights = [
      flight({
        id: "f1",
        actualDepartureDelay: null,
        nextFlightId: "f2",
        ...invalid,
      }),
      flight({
        id: "f2",
        origin: "DFW",
        destination: "DEN",
        scheduledDeparture: 220,
        actualDepartureDelay: 18,
      }),
    ];

    const result = compareRecordedReplay(flights, "f1", 35);
    assert.equal(result.downstreamLegs.length, 0);
  }
});

test("recorded replay counts an unknown linked observation separately", () => {
  const flights = [
    flight({ id: "f1", actualDepartureDelay: 30, nextFlightId: "f2" }),
    flight({
      id: "f2",
      origin: "DFW",
      destination: "DEN",
      scheduledDeparture: 220,
      actualDepartureDelay: null,
    }),
  ];

  const result = compareRecordedReplay(flights, "f1", 35);

  assert.equal(result.summary.downstreamLegCount, 1);
  assert.equal(result.summary.knownRecordedLegCount, 0);
  assert.equal(result.summary.unknownRecordedLegCount, 1);
});
