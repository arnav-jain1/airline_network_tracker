# Flight data preparation notes

Run `npm run data:prepare` to regenerate the browser-ready files in `public/data` from the lookup files plus every `T_ONTIME_REPORTING*.csv` export in `work`. Monthly exports can remain separate; the preparation step combines their dates into one manifest.

## Source joins

- One or more `T_ONTIME_REPORTING*.csv` files supply the dated flight records. They contain DOT airport IDs, but not three-letter airport codes. Use the same selected columns for every export. Preparation rejects files with overlapping service dates so duplicate flights cannot silently enter the rotation model.
- `L_AIRPORT_ID.csv` maps each numeric DOT airport ID to a BTS airport description.
- `L_AIRPORT.csv` maps BTS descriptions to three-character airport codes. Descriptions are matched case-insensitively first. The supplied files use old names for several active DOT IDs, so unmatched descriptions fall back to candidates in the same BTS city/state and are ranked deterministically by shared airport-name words and current scheduled-service metadata. A final normalized airport-name match handles the supplied `Cabarrus, NC` versus `Concord, NC` city-label change for Concord Regional (`JQF`).
- `airports.csv` adds latitude and longitude by IATA code, with FAA local/GPS-code fallbacks for domestic airports that do not publish an IATA code (such as `JQF`). BTS descriptions remain the source of the displayed airport name, city, and state so the name and DOT ID refer to the same BTS entity.

## Selected BTS columns

The preparation step requires these 16 columns from each on-time export:

`YEAR`, `MONTH`, `DAY_OF_MONTH`, `FL_DATE`, `OP_UNIQUE_CARRIER`, `TAIL_NUM`, `OP_CARRIER_FL_NUM`, `ORIGIN_AIRPORT_ID`, `DEST_AIRPORT_ID`, `CRS_DEP_TIME`, `DEP_TIME`, `CRS_ARR_TIME`, `CANCELLED`, `DIVERTED`, `CRS_ELAPSED_TIME`, and `DISTANCE`.

`OP_CARRIER` is accepted as an optional fallback carrier field but is not required when `OP_UNIQUE_CARRIER` is present, as in the January export.

The May source header also contains 13 columns that are not retained: `DAY_OF_WEEK`, `OP_CARRIER_AIRLINE_ID`, `ORIGIN_AIRPORT_SEQ_ID`, `ORIGIN_CITY_MARKET_ID`, `DEST_AIRPORT_SEQ_ID`, `DEST_CITY_MARKET_ID`, `ARR_TIME`, `ACTUAL_ELAPSED_TIME`, `CARRIER_DELAY`, `WEATHER_DELAY`, `NAS_DELAY`, `SECURITY_DELAY`, and `LATE_AIRCRAFT_DELAY`. The smaller January through April exports include `ARR_TIME` and `ACTUAL_ELAPSED_TIME`; those remain unused.

Only airports used by an included flight are emitted to `public/data/airports.json`. A flight is omitted if it lacks any of `CRS_DEP_TIME`, `CRS_ARR_TIME`, or `CRS_ELAPSED_TIME`, or if either DOT airport ID cannot be resolved to a three-character code. Exact omission counts and metadata diagnostics are written to `public/data/diagnostics.json` on every run.

The current January through May build includes 2,880,795 of 2,880,796 source rows. The single omission is SkyWest flight 5035 from Denver to Austin on March 13, whose `CRS_ELAPSED_TIME` is blank. Its other values are left untouched in the ignored source export.

The supplied `L_AIRPORT_ID.csv` row for active DOT airport ID `16869` has a blank description. It is explicitly mapped to `XWA` (Williston Basin International); the 2026 records, Denver distance, current `L_AIRPORT.csv`, and coordinate metadata are consistent with that identification. The override is isolated at the top of the preparation script and counted in diagnostics.

## Output contract

`manifest.json` lists the dates, carriers, date/carrier availability, and every chunk path. Each `days/YYYY-MM-DD/CARRIER.json` chunk has this shape:

```json
{
  "date": "2026-05-01",
  "carrier": "AA",
  "flightIdPrefix": "f20260501-",
  "flightFields": [
    "id", "flightNumber", "tail", "origin", "destination",
    "originId", "destinationId", "scheduledDeparture", "scheduledArrival",
    "scheduledElapsed", "distance", "cancelled", "diverted",
    "actualDepartureDelay", "nextFlightId"
  ],
  "flights": []
}
```

Each chunk carries a `flightFields` schema and encodes `flights` as positional arrays in that exact order, avoiding repeated property names in hundreds of thousands of records. The schema is `id`, `flightNumber`, `tail`, `origin`, `destination`, `originId`, `destinationId`, `scheduledDeparture`, `scheduledArrival`, `scheduledElapsed`, `distance`, `cancelled`, `diverted`, `actualDepartureDelay`, and `nextFlightId`. The carrier and `flightIdPrefix` are each defined once at chunk level. Stored `id` and `nextFlightId` values contain only their base-36 row suffix; the client prepends `flightIdPrefix` while loading the chunk. The resulting stable full ID combines the service date with the file-local source-row number in base 36. It remains unique across non-overlapping monthly exports and an existing month's IDs do not change when another export is added. Flight numbers remain strings; cancellation and diversion flags are booleans.

Clock times are integer minutes after local midnight. BTS `2400` is preserved as `1440`; clients should render it as midnight. Arrival and departure clocks are airport-local and should not be compared across different airports without time-zone information. Elapsed time and departure delay are in minutes; distance is in statute miles.

`actualDepartureDelay` is derived from the scheduled and actual departure clocks because this export has no `DEP_DELAY` column. A clock difference crossing midnight is normalized to the nearest day, then negative (early) values are clamped to zero. It is `null` when actual departure is unavailable. Consequently, the source cannot distinguish an exceptionally rare delay longer than 12 hours from a clock/date ambiguity.

Recorded-delay replay follows the selected flight's `nextFlightId` chain after the modeled delay has recovered and compares each later modeled departure delay with that leg's `actualDepartureDelay`. Those later values can reflect weather, ATC, crew, gate, maintenance, passenger, or other disruptions; they are a same-tail historical comparison, not causal attribution to the selected flight.

Flights are grouped by tail number within one carrier/day and sorted by scheduled departure. `nextFlightId` is set for adjacent legs whenever the current destination equals the next origin. A different airport leaves the pair unlinked. Cancellations and diversions stop simulation through that chain, and no cross-day rotation link is inferred.

Routes are derived client-side from the flight arrays and are not duplicated in chunk files. Each manifest chunk entry retains `routeCount`; manifest route totals are date/carrier route instances, not globally unique airport pairs.
