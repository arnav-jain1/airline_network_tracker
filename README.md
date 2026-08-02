# Turnline

Turnline turns a BTS on-time reporting export into an interactive domestic airline network. Pick a service date and operating carrier, select a route and exact departure, then simulate a custom or recorded departure delay. The map marks affected routes in red as delay propagates through the aircraft's later legs. An airport ground-stop mode holds departures inside a selected local-time window and propagates those aircraft delays too.

## Data

The source files live in the ignored `work/` directory. Run:

```bash
npm run data:prepare
```

This streams the large BTS CSV, joins DOT airport IDs to codes and public airport coordinates, validates same-day tail rotations, and writes compact date/carrier chunks under `public/data/`. See `DATA_NOTES.md` for the exact schema, join rules, diagnostics, and assumptions.

The included May 2026 output contains 611,735 flights across 31 dates and 13 operating carriers. No source flight rows were omitted during preparation.

## Model scope

- Delay propagation follows `TAIL_NUM` within the selected airline and service day.
- A 35-minute minimum turn is assumed; extra scheduled ground time absorbs delay.
- Recorded scenarios use the positive departure delay derived from `DEP_TIME` versus `CRS_DEP_TIME`.
- Ground stops hold departures from the selected airport during a same-day time window.
- Cancellations, diversions, missing tails, broken rotations, and the end of the service day stop propagation.
- Crew, gates, passenger connections, maintenance, aircraft swaps, and cross-day rotations are not modeled because the export does not contain those relationships.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
npm test
```

`npm test` builds the deployable site and checks both the disruption engine and compact-data contract.
