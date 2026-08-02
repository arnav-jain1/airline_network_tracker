# Flight data preparation notes

Run `npm run data:prepare` to regenerate the browser-ready files in `public/data` from the four CSV files in `work`.

## Source joins

- `T_ONTIME_REPORTING.csv` supplies the dated flight records. It contains DOT airport IDs, but not three-letter airport codes.
- `L_AIRPORT_ID.csv` maps each numeric DOT airport ID to a BTS airport description.
- `L_AIRPORT.csv` maps BTS descriptions to three-character airport codes. Descriptions are matched case-insensitively first. The supplied files use old names for several active DOT IDs, so unmatched descriptions fall back to candidates in the same BTS city/state and are ranked deterministically by shared airport-name words and current scheduled-service metadata. A final normalized airport-name match handles the supplied `Cabarrus, NC` versus `Concord, NC` city-label change for Concord Regional (`JQF`).
- `airports.csv` adds latitude and longitude by IATA code, with FAA local/GPS-code fallbacks for domestic airports that do not publish an IATA code (such as `JQF`). BTS descriptions remain the source of the displayed airport name, city, and state so the name and DOT ID refer to the same BTS entity.

Only airports used by an included flight are emitted to `public/data/airports.json`. A flight is omitted if it lacks any of `CRS_DEP_TIME`, `CRS_ARR_TIME`, or `CRS_ELAPSED_TIME`, or if either DOT airport ID cannot be resolved to a three-character code. Exact omission counts and metadata diagnostics are written to `public/data/diagnostics.json` on every run.

The supplied `L_AIRPORT_ID.csv` row for active DOT airport ID `16869` has a blank description. It is explicitly mapped to `XWA` (Williston Basin International); the 2026 records, Denver distance, current `L_AIRPORT.csv`, and coordinate metadata are consistent with that identification. The override is isolated at the top of the preparation script and counted in diagnostics.

## Output contract

`manifest.json` lists the dates, carriers, date/carrier availability, and every chunk path. Each `days/YYYY-MM-DD/CARRIER.json` chunk has this shape:

```json
{
  "date": "2026-05-01",
  "carrier": "AA",
  "flightFields": [
    "id", "flightNumber", "tail", "origin", "destination",
    "originId", "destinationId", "scheduledDeparture", "scheduledArrival",
    "scheduledElapsed", "distance", "cancelled", "diverted",
    "actualDepartureDelay", "nextFlightId"
  ],
  "flights": []
}
```

Each chunk carries a `flightFields` schema and encodes `flights` as positional arrays in that exact order, avoiding repeated property names in hundreds of thousands of records. The schema is `id`, `flightNumber`, `tail`, `origin`, `destination`, `originId`, `destinationId`, `scheduledDeparture`, `scheduledArrival`, `scheduledElapsed`, `distance`, `cancelled`, `diverted`, `actualDepartureDelay`, and `nextFlightId`. The carrier is defined once at chunk level. The stable compact ID is `f` plus the source data-row number in base 36. Flight numbers remain strings; cancellation and diversion flags are booleans.

Clock times are integer minutes after local midnight. BTS `2400` is preserved as `1440`; clients should render it as midnight. Arrival and departure clocks are airport-local and should not be compared across different airports without time-zone information. Elapsed time and departure delay are in minutes; distance is in statute miles.

`actualDepartureDelay` is derived from the scheduled and actual departure clocks because this export has no `DEP_DELAY` column. A clock difference crossing midnight is normalized to the nearest day, then negative (early) values are clamped to zero. It is `null` when actual departure is unavailable. Consequently, the source cannot distinguish an exceptionally rare delay longer than 12 hours from a clock/date ambiguity.

Flights are grouped by tail number within one carrier/day and sorted by scheduled departure. `nextFlightId` is set only for adjacent legs when the current destination equals the next origin and the next scheduled departure is later than the current scheduled arrival in that shared airport-local clock. If the arrival clock is earlier than the originating departure clock, it is treated as an overnight arrival by adding 1,440 minutes. No cross-day rotation link is inferred.

Routes are derived client-side from the flight arrays and are not duplicated in chunk files. Each manifest chunk entry retains `routeCount`; manifest route totals are date/carrier route instances, not globally unique airport pairs.
