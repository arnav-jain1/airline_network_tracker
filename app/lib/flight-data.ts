import {
  type Flight,
  linkAdjacentTailFlightsByAirport,
} from "./simulation.ts";

export type FlightChunkPayload = {
  date: string;
  carrier: string;
  flightIdPrefix?: string;
  flightFields?: string[];
  flights: Array<Flight | unknown[]>;
};

const FLIGHT_ID_SUFFIX_PATTERN = /^[0-9a-z]+$/;

function expandFlightId(value: string | null, prefix: string) {
  if (value === null || value.startsWith(prefix)) return value;
  if (!FLIGHT_ID_SUFFIX_PATTERN.test(value)) {
    throw new Error(`Invalid compact flight ID ${value}`);
  }
  return `${prefix}${value}`;
}

/**
 * Expands the compact IDs stored in a carrier-day chunk, then rebuilds the
 * aircraft links used by the simulator. Older unprefixed chunks remain valid.
 */
export function inflateFlightChunk(payload: FlightChunkPayload): Flight[] {
  const flights = payload.flightFields
    ? payload.flights.map((row) => {
        if (!Array.isArray(row)) return row;
        return Object.fromEntries(
          payload.flightFields!.map((field, index) => [field, row[index]]),
        ) as unknown as Flight;
      })
    : payload.flights as Flight[];

  const expectedPrefix = `f${payload.date.replaceAll("-", "")}-`;
  if (payload.flightIdPrefix && payload.flightIdPrefix !== expectedPrefix) {
    throw new Error(
      `Flight ID prefix ${payload.flightIdPrefix} does not match chunk date ${payload.date}`,
    );
  }

  const prefix = payload.flightIdPrefix;
  const expandedFlights = prefix
    ? flights.map((flight) => ({
        ...flight,
        id: expandFlightId(flight.id, prefix),
        nextFlightId: expandFlightId(flight.nextFlightId, prefix),
      }))
    : flights;

  return linkAdjacentTailFlightsByAirport(expandedFlights);
}
