/**
 * Pure, deterministic disruption simulation for one loaded airline service day.
 *
 * All times are service-day minutes. Values greater than 1,440 are allowed for
 * projected operations after midnight. The engine never mutates its inputs.
 */

export const MINUTES_PER_DAY = 24 * 60;
export const SEVERE_DELAY_THRESHOLD_MINUTES = 45;

export type DelaySeverity = "none" | "moderate" | "severe";

export interface Flight {
  id: string;
  flightNumber: string;
  tail: string | null;
  origin: string;
  destination: string;
  originId: number;
  destinationId: number;
  scheduledDeparture: number;
  actualDeparture?: number | null;
  scheduledArrival: number;
  actualArrival?: number | null;
  scheduledElapsed: number;
  actualElapsed?: number | null;
  distance: number;
  cancelled: boolean;
  diverted: boolean;
  actualDepartureDelay?: number | null;
  nextFlightId: string | null;
  carrierDelay?: number | null;
  weatherDelay?: number | null;
  nasDelay?: number | null;
  securityDelay?: number | null;
  lateAircraftDelay?: number | null;
  delayCause?: string | null;
}

export type SimulationKind = "flight-delay" | "ground-stop";

export type ImpactCause = "selected-flight" | "ground-stop" | "rotation";

export type PropagationStopReason =
  | "missing-tail"
  | "missing-next-flight"
  | "cancelled"
  | "diverted"
  | "tail-mismatch"
  | "airport-mismatch"
  | "out-of-order"
  | "cycle";

export interface PropagationStop {
  flightId: string;
  nextFlightId?: string;
  reason: PropagationStopReason;
}

export interface FlightImpact {
  flightId: string;
  flightNumber: string;
  tail: string | null;
  origin: string;
  destination: string;
  routeKey: string;
  scheduledDeparture: number;
  scheduledArrival: number;
  projectedDeparture: number;
  projectedArrival: number;
  departureDelayMinutes: number;
  arrivalDelayMinutes: number;
  cause: ImpactCause;
  causedByFlightId: string | null;
  isDirectlyAffected: boolean;
}

export interface SimulationSummary {
  seedFlightCount: number;
  affectedFlightCount: number;
  directlyAffectedFlightCount: number;
  propagatedFlightCount: number;
  affectedRouteCount: number;
  totalDelayMinutes: number;
  maxDelayMinutes: number;
}

export interface SimulationResult {
  kind: SimulationKind;
  /** Serializable lookup keyed by Flight.id. */
  impacts: Record<string, FlightImpact>;
  /** Directed route keys in affected-flight order, formatted ORIGIN-DESTINATION. */
  delayedRouteKeys: string[];
  /** Impacts ordered by scheduled departure, then flight id. */
  affectedFlights: FlightImpact[];
  summary: SimulationSummary;
  /** Diagnostics describing why a tail chain could not continue. */
  stops: PropagationStop[];
}

export type RecordedLegStatus =
  | "delayed"
  | "on-time-or-early"
  | "cancelled"
  | "diverted"
  | "unknown";

export interface RecordedDownstreamLeg {
  flightId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  routeKey: string;
  scheduledDeparture: number;
  modeledDelayMinutes: number;
  modeledStatus: "delayed" | "recovered" | "stopped";
  recordedDepartureDelayMinutes: number | null;
  status: RecordedLegStatus;
}

export interface RecordedDepartureObservation {
  delayMinutes: number | null;
  status: RecordedLegStatus;
}

export interface RecordedReplayResult {
  modeled: SimulationResult;
  downstreamLegs: RecordedDownstreamLeg[];
  recordedDelayedRouteKeys: string[];
  summary: {
    downstreamLegCount: number;
    knownRecordedLegCount: number;
    recordedDelayedLegCount: number;
    recordedDownstreamDelayMinutes: number;
    maxRecordedDelayMinutes: number;
    cancelledCount: number;
    divertedCount: number;
    unknownRecordedLegCount: number;
    modeledDelayedLegCount: number;
    modeledDownstreamDelayMinutes: number;
    recordedDelayedAmongModeledCount: number;
  };
}

export interface AircraftDayRotation {
  /** Every flight reporting the selected aircraft tail, ordered for the day. */
  flights: Flight[];
  /** Selected flight position within flights, or -1 when it is unavailable. */
  selectedIndex: number;
  /** Selected flight plus the valid forward nextFlightId chain. */
  linkedFlightIds: string[];
  tail: string | null;
}

interface PropagationRun {
  impacts: FlightImpact[];
  stop?: PropagationStop;
}

const EPSILON = 1e-9;

/**
 * Shared visual severity rule: positive delays below 45 minutes are moderate;
 * delays of 45 minutes or more are severe. Zero, negative, and invalid values
 * have no delay severity.
 */
export function getDelaySeverity(
  delayMinutes: number | null | undefined,
): DelaySeverity {
  if (
    typeof delayMinutes !== "number"
    || !Number.isFinite(delayMinutes)
    || delayMinutes <= 0
  ) {
    return "none";
  }
  return delayMinutes < SEVERE_DELAY_THRESHOLD_MINUTES
    ? "moderate"
    : "severe";
}

export function getRouteKey(flight: Pick<Flight, "origin" | "destination">): string {
  return `${flight.origin}-${flight.destination}`;
}

/**
 * Returns the non-negative observed departure delay to use for the recorded
 * scenario. Prepared chunks provide a clock-derived delay; raw clock times are
 * retained as a fallback for callers using the wider Flight contract.
 */
export function getActualDelaySeedMinutes(
  flight: Pick<Flight, "actualDepartureDelay" | "actualDeparture" | "scheduledDeparture">,
): number {
  if (isFiniteNumber(flight.actualDepartureDelay)) {
    return Math.max(0, flight.actualDepartureDelay);
  }

  if (!isFiniteNumber(flight.actualDeparture)) {
    return 0;
  }

  let delay = flight.actualDeparture - flight.scheduledDeparture;
  // A late-night scheduled departure followed by a post-midnight actual time.
  if (delay < -MINUTES_PER_DAY / 2) {
    delay += MINUTES_PER_DAY;
  } else if (delay > MINUTES_PER_DAY / 2) {
    delay -= MINUTES_PER_DAY;
  }

  return Math.max(0, delay);
}

/**
 * Normalizes a flight's recorded departure into the status shared by replay
 * summaries and the full aircraft-day timeline.
 */
export function getRecordedDepartureObservation(
  flight: Pick<
    Flight,
    | "actualDepartureDelay"
    | "actualDeparture"
    | "scheduledDeparture"
    | "cancelled"
    | "diverted"
  >,
): RecordedDepartureObservation {
  const delayMinutes = isFiniteNumber(flight.actualDepartureDelay)
    ? flight.actualDepartureDelay
    : isFiniteNumber(flight.actualDeparture)
      ? getActualDelaySeedMinutes(flight)
      : null;
  const status: RecordedLegStatus = flight.cancelled
    ? "cancelled"
    : flight.diverted
      ? "diverted"
      : delayMinutes == null
        ? "unknown"
        : delayMinutes > EPSILON
          ? "delayed"
          : "on-time-or-early";

  return { delayMinutes, status };
}

/**
 * Returns the selected aircraft's complete carrier-day schedule while keeping
 * the model's valid linked rotation separate from same-tail context after a
 * broken airport/timing link.
 */
export function getAircraftDayRotation(
  flights: readonly Flight[],
  selectedId: string,
): AircraftDayRotation {
  const flightById = indexFlights(flights);
  const selected = flightById.get(selectedId);
  if (!selected) {
    return { flights: [], selectedIndex: -1, linkedFlightIds: [], tail: null };
  }

  const aircraftFlights = selected.tail
    ? flights
        .filter((flight) => flight.tail === selected.tail)
        .sort(compareFlights)
    : [selected];
  const linkedFlightIds = [
    selected.id,
    ...traceLinkedDownstreamFlights(flightById, selected).map((flight) => flight.id),
  ];

  return {
    flights: aircraftFlights,
    selectedIndex: aircraftFlights.findIndex((flight) => flight.id === selected.id),
    linkedFlightIds,
    tail: selected.tail,
  };
}

/**
 * Simulates a departure delay on one flight and propagates it down that
 * aircraft's nextFlightId chain.
 *
 * A delayed flight flies its scheduled block time. Its next flight cannot
 * depart before delayed arrival + minTurnMinutes. Scheduled ground time above
 * that minimum is therefore recovery buffer. Propagation stops if a leg is
 * cancelled/diverted, a tail is missing, the explicit rotation is missing or
 * cyclic, airports/tails do not connect, or the next departure is out of order.
 */
export function simulateFlightDelay(
  flights: readonly Flight[],
  selectedId: string,
  seedDelayMinutes: number,
  minTurnMinutes = 35,
): SimulationResult {
  assertNonNegativeFinite(seedDelayMinutes, "seedDelayMinutes");
  assertNonNegativeFinite(minTurnMinutes, "minTurnMinutes");

  const flightById = indexFlights(flights);
  const selected = flightById.get(selectedId);
  if (!selected || seedDelayMinutes <= EPSILON) {
    return buildResult("flight-delay", [], 0, []);
  }

  if (selected.cancelled) {
    return buildResult("flight-delay", [], 0, [
      { flightId: selected.id, reason: "cancelled" },
    ]);
  }
  if (selected.diverted) {
    return buildResult("flight-delay", [], 0, [
      { flightId: selected.id, reason: "diverted" },
    ]);
  }

  const run = propagateFromSeed(
    flightById,
    selected,
    seedDelayMinutes,
    minTurnMinutes,
    "selected-flight",
  );

  return buildResult(
    "flight-delay",
    run.impacts,
    run.impacts.length > 0 ? 1 : 0,
    run.stop ? [run.stop] : [],
  );
}

/** Uses the selected flight's observed BTS departure delay as the seed. */
export function simulateActualFlightDelay(
  flights: readonly Flight[],
  selectedId: string,
  minTurnMinutes = 35,
): SimulationResult {
  const selected = flights.find((flight) => flight.id === selectedId);
  const actualDelay = selected ? getActualDelaySeedMinutes(selected) : 0;
  return simulateFlightDelay(flights, selectedId, actualDelay, minTurnMinutes);
}

/**
 * Replays the selected flight's recorded departure delay, then follows every
 * valid later leg assigned to the same reported aircraft. The modeled delay
 * can recover before this observed chain ends, which lets the UI compare the
 * hypothetical ripple with what later departures actually recorded.
 *
 * Recorded delay on a later leg is an operational outcome, not causal proof
 * that the selected flight created it.
 */
export function compareRecordedReplay(
  flights: readonly Flight[],
  selectedId: string,
  minTurnMinutes = 35,
): RecordedReplayResult {
  const modeled = simulateActualFlightDelay(flights, selectedId, minTurnMinutes);
  const flightById = indexFlights(flights);
  const selected = flightById.get(selectedId);
  const downstreamLegs: RecordedDownstreamLeg[] = [];
  const recordedRouteSet = new Set<string>();
  const modeledStoppedFlightIds = new Set(
    modeled.stops
      .map((stop) => stop.nextFlightId)
      .filter((flightId): flightId is string => Boolean(flightId)),
  );

  if (selected && !selected.cancelled && !selected.diverted) {
    for (const next of traceLinkedDownstreamFlights(flightById, selected)) {
      const { delayMinutes: recordedDelay, status } =
        getRecordedDepartureObservation(next);
      const routeKey = getRouteKey(next);
      const modeledDelayMinutes = modeled.impacts[next.id]?.departureDelayMinutes ?? 0;

      downstreamLegs.push({
        flightId: next.id,
        flightNumber: next.flightNumber,
        origin: next.origin,
        destination: next.destination,
        routeKey,
        scheduledDeparture: next.scheduledDeparture,
        modeledDelayMinutes,
        modeledStatus: modeledStoppedFlightIds.has(next.id)
          ? "stopped"
          : modeledDelayMinutes > EPSILON
            ? "delayed"
            : "recovered",
        recordedDepartureDelayMinutes: recordedDelay,
        status,
      });

      if (!next.cancelled && recordedDelay != null && recordedDelay > EPSILON) {
        recordedRouteSet.add(routeKey);
      }
    }
  }

  let knownRecordedLegCount = 0;
  let recordedDelayedLegCount = 0;
  let recordedDownstreamDelayMinutes = 0;
  let maxRecordedDelayMinutes = 0;
  let cancelledCount = 0;
  let divertedCount = 0;
  let unknownRecordedLegCount = 0;
  let modeledDelayedLegCount = 0;
  let modeledDownstreamDelayMinutes = 0;
  let recordedDelayedAmongModeledCount = 0;

  for (const leg of downstreamLegs) {
    if (leg.modeledStatus === "delayed") {
      modeledDelayedLegCount += 1;
      modeledDownstreamDelayMinutes += leg.modeledDelayMinutes;
    }
    if (leg.status === "cancelled") {
      cancelledCount += 1;
    }
    if (leg.status === "diverted") {
      divertedCount += 1;
    }
    if (
      leg.recordedDepartureDelayMinutes == null
      && leg.status !== "cancelled"
    ) {
      unknownRecordedLegCount += 1;
    }

    if (leg.recordedDepartureDelayMinutes != null && leg.status !== "cancelled") {
      knownRecordedLegCount += 1;
      if (leg.recordedDepartureDelayMinutes > EPSILON) {
        recordedDelayedLegCount += 1;
        const positiveDelay = leg.recordedDepartureDelayMinutes;
        recordedDownstreamDelayMinutes += positiveDelay;
        maxRecordedDelayMinutes = Math.max(maxRecordedDelayMinutes, positiveDelay);
        if (leg.modeledStatus === "delayed") {
          recordedDelayedAmongModeledCount += 1;
        }
      }
    }
  }

  return {
    modeled,
    downstreamLegs,
    recordedDelayedRouteKeys: [...recordedRouteSet],
    summary: {
      downstreamLegCount: downstreamLegs.length,
      knownRecordedLegCount,
      recordedDelayedLegCount,
      recordedDownstreamDelayMinutes,
      maxRecordedDelayMinutes,
      cancelledCount,
      divertedCount,
      unknownRecordedLegCount,
      modeledDelayedLegCount,
      modeledDownstreamDelayMinutes,
      recordedDelayedAmongModeledCount,
    },
  };
}

/**
 * Simplified ground-stop rule:
 * - Every non-cancelled/non-diverted flight scheduled to depart airportCode in
 *   [startMinutes, endMinutes) is held until the end of the window.
 * - That departure delay then propagates through the same tail-rotation rule as
 *   simulateFlightDelay.
 * - When endMinutes < startMinutes the interval crosses midnight. A departure
 *   at/after start is held to next day's end; one before end is held to that
 *   day's end. Equal start/end is an empty interval.
 *
 * Multiple holds combine by taking the strongest applicable delay at each leg;
 * delays are constraints, so they do not add together.
 */
export function simulateGroundStop(
  flights: readonly Flight[],
  airportCode: string,
  startMinutes: number,
  endMinutes: number,
  minTurnMinutes = 35,
): SimulationResult {
  assertMinuteOfDay(startMinutes, "startMinutes");
  assertMinuteOfDay(endMinutes, "endMinutes");
  assertNonNegativeFinite(minTurnMinutes, "minTurnMinutes");

  const normalizedAirport = airportCode.trim().toUpperCase();
  if (!normalizedAirport || startMinutes === endMinutes) {
    return buildResult("ground-stop", [], 0, []);
  }

  const flightById = indexFlights(flights);
  const seeds = flights
    .map((flight) => ({
      flight,
      delay: groundStopDelay(flight, normalizedAirport, startMinutes, endMinutes),
    }))
    .filter(({ flight, delay }) => !flight.cancelled && !flight.diverted && delay > EPSILON)
    .sort((a, b) => compareFlights(a.flight, b.flight));

  const directSeedIds = new Set(seeds.map(({ flight }) => flight.id));
  const mergedImpacts = new Map<string, FlightImpact>();
  const stops: PropagationStop[] = [];

  for (const { flight, delay } of seeds) {
    const run = propagateFromSeed(
      flightById,
      flight,
      delay,
      minTurnMinutes,
      "ground-stop",
    );

    for (const impact of run.impacts) {
      const existing = mergedImpacts.get(impact.flightId);
      if (!existing || impact.departureDelayMinutes > existing.departureDelayMinutes + EPSILON) {
        mergedImpacts.set(impact.flightId, impact);
      }
    }

    if (run.stop) {
      stops.push(run.stop);
    }
  }

  const impacts = [...mergedImpacts.values()].map((impact) => ({
    ...impact,
    isDirectlyAffected: directSeedIds.has(impact.flightId),
  }));

  return buildResult(
    "ground-stop",
    impacts,
    directSeedIds.size,
    deduplicateStops(stops),
  );
}

function propagateFromSeed(
  flightById: ReadonlyMap<string, Flight>,
  seed: Flight,
  seedDelayMinutes: number,
  minTurnMinutes: number,
  seedCause: Exclude<ImpactCause, "rotation">,
): PropagationRun {
  const impacts: FlightImpact[] = [];
  const visited = new Set<string>();
  let current = seed;
  let currentDelay = seedDelayMinutes;
  let cause: ImpactCause = seedCause;
  let causedByFlightId: string | null = null;

  while (currentDelay > EPSILON) {
    if (visited.has(current.id)) {
      return {
        impacts,
        stop: { flightId: current.id, reason: "cycle" },
      };
    }
    visited.add(current.id);

    if (current.cancelled) {
      return {
        impacts,
        stop: { flightId: current.id, reason: "cancelled" },
      };
    }
    if (current.diverted) {
      return {
        impacts,
        stop: { flightId: current.id, reason: "diverted" },
      };
    }

    impacts.push(createImpact(current, currentDelay, cause, causedByFlightId));

    if (!current.tail) {
      return {
        impacts,
        stop: { flightId: current.id, reason: "missing-tail" },
      };
    }

    if (!current.nextFlightId) {
      return { impacts };
    }

    const next = flightById.get(current.nextFlightId);
    if (!next) {
      return {
        impacts,
        stop: {
          flightId: current.id,
          nextFlightId: current.nextFlightId,
          reason: "missing-next-flight",
        },
      };
    }

    if (visited.has(next.id)) {
      return {
        impacts,
        stop: { flightId: current.id, nextFlightId: next.id, reason: "cycle" },
      };
    }
    if (next.cancelled) {
      return {
        impacts,
        stop: { flightId: current.id, nextFlightId: next.id, reason: "cancelled" },
      };
    }
    if (next.diverted) {
      return {
        impacts,
        stop: { flightId: current.id, nextFlightId: next.id, reason: "diverted" },
      };
    }
    if (!next.tail || next.tail !== current.tail) {
      return {
        impacts,
        stop: { flightId: current.id, nextFlightId: next.id, reason: "tail-mismatch" },
      };
    }
    if (next.origin !== current.destination) {
      return {
        impacts,
        stop: { flightId: current.id, nextFlightId: next.id, reason: "airport-mismatch" },
      };
    }
    if (next.scheduledDeparture + EPSILON < current.scheduledDeparture) {
      return {
        impacts,
        stop: { flightId: current.id, nextFlightId: next.id, reason: "out-of-order" },
      };
    }

    // Arrival and the next departure are both expressed in the destination
    // airport's local clock, so this comparison remains valid across time
    // zones. Using departure + elapsed here would mix the origin clock with
    // the destination clock and overstate recovery on eastbound flights.
    const projectedArrival = scheduledArrivalMinutes(current) + currentDelay;
    const nextDelay = Math.max(
      0,
      projectedArrival + minTurnMinutes - next.scheduledDeparture,
    );

    if (nextDelay <= EPSILON) {
      return { impacts };
    }

    causedByFlightId = current.id;
    current = next;
    currentDelay = nextDelay;
    cause = "rotation";
  }

  return { impacts };
}

function createImpact(
  flight: Flight,
  delayMinutes: number,
  cause: ImpactCause,
  causedByFlightId: string | null,
): FlightImpact {
  const scheduledArrival = scheduledArrivalMinutes(flight);
  return {
    flightId: flight.id,
    flightNumber: flight.flightNumber,
    tail: flight.tail,
    origin: flight.origin,
    destination: flight.destination,
    routeKey: getRouteKey(flight),
    scheduledDeparture: flight.scheduledDeparture,
    scheduledArrival,
    projectedDeparture: flight.scheduledDeparture + delayMinutes,
    projectedArrival: scheduledArrival + delayMinutes,
    departureDelayMinutes: delayMinutes,
    arrivalDelayMinutes: delayMinutes,
    cause,
    causedByFlightId,
    isDirectlyAffected: cause !== "rotation",
  };
}

function groundStopDelay(
  flight: Flight,
  airportCode: string,
  startMinutes: number,
  endMinutes: number,
): number {
  if (flight.origin.toUpperCase() !== airportCode || !isFiniteNumber(flight.scheduledDeparture)) {
    return 0;
  }

  const departure = flight.scheduledDeparture;
  const day = Math.floor(departure / MINUTES_PER_DAY);
  const minuteOfDay = positiveModulo(departure, MINUTES_PER_DAY);

  if (endMinutes > startMinutes) {
    if (minuteOfDay < startMinutes || minuteOfDay >= endMinutes) {
      return 0;
    }
    return day * MINUTES_PER_DAY + endMinutes - departure;
  }

  if (minuteOfDay >= startMinutes) {
    return (day + 1) * MINUTES_PER_DAY + endMinutes - departure;
  }
  if (minuteOfDay < endMinutes) {
    return day * MINUTES_PER_DAY + endMinutes - departure;
  }
  return 0;
}

function buildResult(
  kind: SimulationKind,
  rawImpacts: readonly FlightImpact[],
  seedFlightCount: number,
  stops: PropagationStop[],
): SimulationResult {
  const affectedFlights = [...rawImpacts].sort(compareImpacts);
  const impacts: Record<string, FlightImpact> = {};
  const delayedRouteKeys: string[] = [];
  const routeSet = new Set<string>();
  let directlyAffectedFlightCount = 0;
  let totalDelayMinutes = 0;
  let maxDelayMinutes = 0;

  for (const impact of affectedFlights) {
    impacts[impact.flightId] = impact;
    totalDelayMinutes += impact.departureDelayMinutes;
    maxDelayMinutes = Math.max(maxDelayMinutes, impact.departureDelayMinutes);
    if (impact.isDirectlyAffected) {
      directlyAffectedFlightCount += 1;
    }
    if (!routeSet.has(impact.routeKey)) {
      routeSet.add(impact.routeKey);
      delayedRouteKeys.push(impact.routeKey);
    }
  }

  return {
    kind,
    impacts,
    delayedRouteKeys,
    affectedFlights,
    summary: {
      seedFlightCount,
      affectedFlightCount: affectedFlights.length,
      directlyAffectedFlightCount,
      propagatedFlightCount: affectedFlights.length - directlyAffectedFlightCount,
      affectedRouteCount: delayedRouteKeys.length,
      totalDelayMinutes,
      maxDelayMinutes,
    },
    stops,
  };
}

function scheduledArrivalMinutes(flight: Flight): number {
  if (isFiniteNumber(flight.scheduledArrival)) {
    let arrival = flight.scheduledArrival;
    if (arrival < flight.scheduledDeparture) {
      arrival += MINUTES_PER_DAY;
    }
    return arrival;
  }

  return flight.scheduledDeparture + Math.max(0, flight.scheduledElapsed || 0);
}

function indexFlights(flights: readonly Flight[]): Map<string, Flight> {
  const byId = new Map<string, Flight>();
  for (const flight of flights) {
    if (!byId.has(flight.id)) {
      byId.set(flight.id, flight);
    }
  }
  return byId;
}

function traceLinkedDownstreamFlights(
  flightById: ReadonlyMap<string, Flight>,
  selected: Flight,
): Flight[] {
  if (selected.cancelled || selected.diverted) return [];

  const downstream: Flight[] = [];
  const visited = new Set<string>([selected.id]);
  let current = selected;

  while (current.nextFlightId) {
    const next = flightById.get(current.nextFlightId);
    if (
      !next
      || visited.has(next.id)
      || !current.tail
      || !next.tail
      || next.tail !== current.tail
      || next.origin !== current.destination
      || next.scheduledDeparture + EPSILON < current.scheduledDeparture
    ) {
      break;
    }

    downstream.push(next);
    visited.add(next.id);
    if (next.cancelled || next.diverted) break;
    current = next;
  }

  return downstream;
}

function compareFlights(a: Flight, b: Flight): number {
  return a.scheduledDeparture - b.scheduledDeparture || a.id.localeCompare(b.id);
}

function compareImpacts(a: FlightImpact, b: FlightImpact): number {
  return a.scheduledDeparture - b.scheduledDeparture || a.flightId.localeCompare(b.flightId);
}

function deduplicateStops(stops: readonly PropagationStop[]): PropagationStop[] {
  const seen = new Set<string>();
  return stops.filter((stop) => {
    const key = `${stop.flightId}|${stop.nextFlightId ?? ""}|${stop.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number greater than or equal to zero.`);
  }
}

function assertMinuteOfDay(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value >= MINUTES_PER_DAY) {
    throw new RangeError(`${name} must be a finite minute from 0 through 1439.`);
  }
}
