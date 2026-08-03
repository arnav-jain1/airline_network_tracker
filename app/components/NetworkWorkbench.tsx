"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type AircraftDayRotation,
  type Flight,
  type RecordedReplayResult,
  type SimulationResult,
  compareRecordedReplay,
  getAircraftDayRotation,
  getActualDelaySeedMinutes,
  getDelaySeverity,
  getRecordedDepartureObservation,
  simulateFlightDelay,
  simulateGroundStop,
} from "../lib/simulation";
import {
  type Airport,
  type NetworkRoute,
  NetworkMap,
} from "./NetworkMap";

type ManifestChunk = {
  date: string;
  carrier: string;
  path: string;
  flightCount: number;
  routeCount: number;
};

type Manifest = {
  schemaVersion: number;
  generatedAt: string;
  dataset: {
    sourceFile: string | null;
    sourceFiles?: string[];
    year: number | null;
    month: number | null;
    startDate?: string | null;
    endDate?: string | null;
  };
  dates: string[];
  carriers: string[];
  availability: Record<string, string[]>;
  chunks: ManifestChunk[];
  totals: { flights: number; routes: number; airports: number };
  metadata: {
    airportCodeMatchRate: number;
    coordinateMatchRate: number;
    rotationLinkCount: number;
  };
};

type AirportPayload = {
  airports: Array<Airport & { latitude: number | null; longitude: number | null }>;
};

type ChunkPayload = {
  date: string;
  carrier: string;
  flightFields?: string[];
  flights: Array<Flight | unknown[]>;
};

type ScenarioMode = "flight" | "ground";
type DelaySource = "planned" | "actual";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function publicPath(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_PATH}${normalizedPath}`;
}

const AIRLINE_NAMES: Record<string, string> = {
  "9E": "Endeavor Air",
  AA: "American Airlines",
  AS: "Alaska Airlines",
  B6: "JetBlue Airways",
  DL: "Delta Air Lines",
  F9: "Frontier Airlines",
  G4: "Allegiant Air",
  HA: "Hawaiian Airlines",
  MQ: "Envoy Air",
  NK: "Spirit Airlines",
  OH: "PSA Airlines",
  OO: "SkyWest Airlines",
  UA: "United Airlines",
  WN: "Southwest Airlines",
  YX: "Republic Airways",
};

function airlineName(code: string) {
  return AIRLINE_NAMES[code] ?? code;
}

function formatDate(date: string, compact = false) {
  if (!date) return "";
  const value = new Date(`${date}T12:00:00`);
  return value.toLocaleDateString("en-US", compact
    ? { month: "short", day: "numeric", year: "numeric" }
    : { weekday: "short", month: "long", day: "numeric", year: "numeric" });
}

function formatDatasetRange(dates: readonly string[]) {
  const first = dates[0];
  const last = dates.at(-1);
  if (!first || !last) return "No dates";
  const firstDate = new Date(`${first}T12:00:00`);
  const lastDate = new Date(`${last}T12:00:00`);
  const firstMonth = firstDate.toLocaleDateString("en-US", { month: "short" });
  const lastMonth = lastDate.toLocaleDateString("en-US", { month: "short" });
  const firstYear = firstDate.getFullYear();
  const lastYear = lastDate.getFullYear();
  if (first.slice(0, 7) === last.slice(0, 7)) return `${firstMonth} ${firstYear}`;
  return firstYear === lastYear
    ? `${firstMonth}–${lastMonth} ${firstYear}`
    : `${firstMonth} ${firstYear}–${lastMonth} ${lastYear}`;
}

function formatTime(minutes: number | null | undefined) {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  const day = Math.floor(minutes / 1440);
  const minuteOfDay = ((minutes % 1440) + 1440) % 1440;
  const hours = Math.floor(minuteOfDay / 60);
  const mins = minuteOfDay % 60;
  const clock = `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  return day > 0 ? `${clock} +${day}` : clock;
}

function timeInputValue(minutes: number) {
  const value = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function parseTimeInput(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function routeFromKey(key: string) {
  const [origin, destination] = key.split("-");
  return { origin, destination };
}

function plural(value: number, singular: string, pluralForm = `${singular}s`) {
  return `${value.toLocaleString()} ${value === 1 ? singular : pluralForm}`;
}

function delaySeverityClass(delayMinutes: number | null | undefined) {
  return `delay-${getDelaySeverity(delayMinutes)}`;
}

function addMaximumRouteDelay(
  routeDelays: Map<string, number>,
  routeKey: string,
  delayMinutes: number | null | undefined,
) {
  if (typeof delayMinutes !== "number" || !Number.isFinite(delayMinutes) || delayMinutes <= 0) {
    return;
  }
  routeDelays.set(routeKey, Math.max(routeDelays.get(routeKey) ?? 0, delayMinutes));
}

function inflateFlights(payload: ChunkPayload): Flight[] {
  if (!payload.flightFields) return payload.flights as Flight[];
  return payload.flights.map((row) => {
    if (!Array.isArray(row)) return row;
    return Object.fromEntries(
      payload.flightFields!.map((field, index) => [field, row[index]]),
    ) as unknown as Flight;
  });
}

export function NetworkWorkbench() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [airportPayload, setAirportPayload] = useState<AirportPayload | null>(null);
  const [date, setDate] = useState("");
  const [carrier, setCarrier] = useState("");
  const [flights, setFlights] = useState<Flight[]>([]);
  const [isChunkLoading, setIsChunkLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chunkError, setChunkError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [scenarioMode, setScenarioMode] = useState<ScenarioMode>("flight");
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null);
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null);
  const [delayMinutes, setDelayMinutes] = useState(60);
  const [delaySource, setDelaySource] = useState<DelaySource>("planned");
  const [groundAirport, setGroundAirport] = useState("");
  const [groundStart, setGroundStart] = useState(9 * 60);
  const [groundEnd, setGroundEnd] = useState(10 * 60 + 30);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch(publicPath("/data/manifest.json"), { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error("The BTS data index could not be loaded.");
        return response.json() as Promise<Manifest>;
      }),
      fetch(publicPath("/data/airports.json"), { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error("The airport map could not be loaded.");
        return response.json() as Promise<AirportPayload>;
      }),
    ])
      .then(([nextManifest, nextAirports]) => {
        setManifest(nextManifest);
        setAirportPayload(nextAirports);
        const preferredDate = nextManifest.dates[Math.floor(nextManifest.dates.length / 2)]
          ?? nextManifest.dates[0];
        const available = nextManifest.availability[preferredDate] ?? nextManifest.carriers;
        const preferredCarrier = available.includes("AA") ? "AA" : available[0];
        setIsChunkLoading(true);
        setDate(preferredDate);
        setCarrier(preferredCarrier);
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "The network data could not be loaded.");
      });
    return () => controller.abort();
  }, []);

  const availableCarriers = useMemo(() => {
    if (!manifest || !date) return [];
    return manifest.availability[date] ?? manifest.carriers;
  }, [date, manifest]);

  useEffect(() => {
    if (!manifest || !date || !carrier || !availableCarriers.includes(carrier)) return;
    const controller = new AbortController();
    const chunk = manifest.chunks.find((item) => item.date === date && item.carrier === carrier);
    const path = chunk?.path ?? `/data/days/${date}/${carrier}.json`;
    fetch(publicPath(path), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`No flights are available for ${carrier} on ${date}.`);
        return response.json() as Promise<ChunkPayload>;
      })
      .then((payload) => {
        setFlights(inflateFlights(payload));
        setSelectedRouteKey(null);
        setSelectedFlightId(null);
        setDelayMinutes(60);
        setDelaySource("planned");
        setChunkError(null);
        setError(null);
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setFlights([]);
        setChunkError(cause instanceof Error ? cause.message : "This service day could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsChunkLoading(false);
      });
    return () => controller.abort();
  }, [availableCarriers, carrier, date, manifest, retryToken]);

  const airports = useMemo(() => {
    const result = new Map<string, Airport>();
    for (const airport of airportPayload?.airports ?? []) {
      if (typeof airport.latitude !== "number" || typeof airport.longitude !== "number") continue;
      result.set(airport.code, airport as Airport);
    }
    return result;
  }, [airportPayload]);

  const routes = useMemo(() => {
    const aggregate = new Map<string, { flights: number; distance: number }>();
    for (const flight of flights) {
      const key = `${flight.origin}-${flight.destination}`;
      const current = aggregate.get(key) ?? { flights: 0, distance: 0 };
      current.flights += 1;
      current.distance += flight.distance || 0;
      aggregate.set(key, current);
    }
    return [...aggregate.entries()]
      .map(([key, value]): NetworkRoute => {
        const { origin, destination } = routeFromKey(key);
        return {
          key,
          origin,
          destination,
          flights: value.flights,
          distance: Math.round(value.distance / Math.max(1, value.flights)),
        };
      })
      .sort((a, b) => b.flights - a.flights || a.key.localeCompare(b.key));
  }, [flights]);

  const routeFlights = useMemo(() => {
    if (!selectedRouteKey) return [];
    const { origin, destination } = routeFromKey(selectedRouteKey);
    return flights
      .filter((flight) => flight.origin === origin && flight.destination === destination)
      .sort((a, b) => a.scheduledDeparture - b.scheduledDeparture || a.id.localeCompare(b.id));
  }, [flights, selectedRouteKey]);

  const selectedFlight = useMemo(() => {
    const explicit = routeFlights.find(
      (flight) => flight.id === selectedFlightId && !flight.cancelled && !flight.diverted,
    );
    return explicit ?? routeFlights.find((flight) => !flight.cancelled && !flight.diverted) ?? null;
  }, [routeFlights, selectedFlightId]);

  const selectedAircraftRotation = useMemo(
    () => selectedFlight
      ? getAircraftDayRotation(flights, selectedFlight.id)
      : null,
    [flights, selectedFlight],
  );

  const airportTraffic = useMemo(() => {
    const counts = new Map<string, number>();
    for (const flight of flights) {
      counts.set(flight.origin, (counts.get(flight.origin) ?? 0) + 1);
      counts.set(flight.destination, (counts.get(flight.destination) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [flights]);

  const effectiveGroundAirport = airportTraffic.some(([code]) => code === groundAirport)
    ? groundAirport
    : (airportTraffic[0]?.[0] ?? "");

  const groundWindowValid = groundEnd > groundStart;
  const recordedReplay = useMemo<RecordedReplayResult | null>(() => {
    if (
      scenarioMode !== "flight"
      || delaySource !== "actual"
      || !selectedFlight
    ) {
      return null;
    }
    return compareRecordedReplay(flights, selectedFlight.id, 35);
  }, [delaySource, flights, scenarioMode, selectedFlight]);

  const simulation = useMemo<SimulationResult | null>(() => {
    if (scenarioMode === "flight") {
      if (!selectedFlight || delayMinutes <= 0) return null;
      if (delaySource === "actual") return recordedReplay?.modeled ?? null;
      return simulateFlightDelay(flights, selectedFlight.id, delayMinutes, 35);
    }
    if (!effectiveGroundAirport || !groundWindowValid) return null;
    return simulateGroundStop(flights, effectiveGroundAirport, groundStart, groundEnd, 35);
  }, [delayMinutes, delaySource, effectiveGroundAirport, flights, groundEnd, groundStart, groundWindowValid, recordedReplay, scenarioMode, selectedFlight]);

  const modeledRouteDelays = useMemo(() => {
    const result = new Map<string, number>();
    for (const impact of simulation?.affectedFlights ?? []) {
      addMaximumRouteDelay(result, impact.routeKey, impact.departureDelayMinutes);
    }
    return result;
  }, [simulation]);
  const recordedRouteDelays = useMemo(() => {
    const result = new Map<string, number>();
    for (const leg of recordedReplay?.downstreamLegs ?? []) {
      if (leg.status === "cancelled") continue;
      addMaximumRouteDelay(result, leg.routeKey, leg.recordedDepartureDelayMinutes);
    }
    return result;
  }, [recordedReplay]);
  const activeAirportCount = useMemo(
    () => new Set(flights.flatMap((flight) => [flight.origin, flight.destination])).size,
    [flights],
  );
  const tailCount = useMemo(
    () => new Set(flights.map((flight) => flight.tail).filter(Boolean)).size,
    [flights],
  );
  const observedDelay = selectedFlight ? getActualDelaySeedMinutes(selectedFlight) : 0;
  const datasetRange = manifest ? formatDatasetRange(manifest.dates) : "";

  function selectRoute(route: NetworkRoute) {
    setScenarioMode("flight");
    setSelectedRouteKey(route.key);
    setSelectedFlightId(null);
    setDelayMinutes(60);
    setDelaySource("planned");
  }

  function resetForChunkLoad() {
    setFlights([]);
    setSelectedRouteKey(null);
    setSelectedFlightId(null);
    setDelayMinutes(60);
    setDelaySource("planned");
    setChunkError(null);
    setIsChunkLoading(true);
  }

  function changeDate(nextDate: string) {
    const nextCarriers = manifest?.availability[nextDate] ?? [];
    const nextCarrier = nextCarriers.includes(carrier) ? carrier : nextCarriers[0];
    resetForChunkLoad();
    setDate(nextDate);
    setCarrier(nextCarrier ?? "");
  }

  function changeCarrier(nextCarrier: string) {
    resetForChunkLoad();
    setCarrier(nextCarrier);
  }

  function retryChunk() {
    resetForChunkLoad();
    setRetryToken((value) => value + 1);
  }

  function selectExactFlight(id: string) {
    setSelectedFlightId(id);
    setDelayMinutes(60);
    setDelaySource("planned");
  }

  function chooseManualDelay(value: number) {
    setDelayMinutes(value);
    setDelaySource("planned");
  }

  function replayActualDelay() {
    setDelayMinutes(observedDelay);
    setDelaySource("actual");
  }

  if (error && !manifest) {
    return (
      <main className="error-screen">
        <div className="error-card">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <strong>Aircraft Delay Visualizer could not open the dataset</strong>
          <span>{error}</span>
          <button type="button" onClick={() => window.location.reload()}>Try again</button>
        </div>
      </main>
    );
  }

  if (!manifest || !airportPayload || !date || !carrier) {
    return (
      <main className="loading-screen">
        <div className="loading-card" role="status">
          <div className="loading-orbit" aria-hidden="true" />
          <strong>Building the service-day network</strong>
          <span>Indexing routes, aircraft rotations, and airport positions.</span>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div className="brand-copy">
            <strong>Aircraft Delay Visualizer</strong>
            <span>Network disruption simulator</span>
          </div>
        </div>

        <div className="dataset-controls" aria-label="Network selection">
          <div className="control-field">
            <label htmlFor="network-date">Service date</label>
            <select id="network-date" value={date} onChange={(event) => changeDate(event.target.value)}>
              {manifest.dates.map((option) => (
                <option key={option} value={option}>{formatDate(option, true)}</option>
              ))}
            </select>
          </div>
          <div className="control-field">
            <label htmlFor="network-carrier">Operating airline</label>
            <select id="network-carrier" value={carrier} onChange={(event) => changeCarrier(event.target.value)}>
              {availableCarriers.map((option) => (
                <option key={option} value={option}>{option} · {airlineName(option)}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="source-badge">BTS on-time · {datasetRange}</div>
      </header>

      <main className="workspace">
        <section className={`map-stage${isChunkLoading ? " is-loading" : ""}`} aria-busy={isChunkLoading}>
          <div className="map-heading">
            <div>
              <p className="eyebrow">{carrier} · {formatDate(date)}</p>
              <h1>Domestic network</h1>
              <p>
                {scenarioMode === "flight"
                  ? "Zoom into the network, select a route, then choose a specific departure to see where the aircraft carries a delay next."
                  : "Zoom until the airport you need appears, then select it to place the ground stop. Major stations appear from farther out."}
              </p>
            </div>
            <div className="map-legend" aria-label="Map legend">
              <span className="legend-item"><i className="legend-line" />Scheduled</span>
              <span className="legend-item"><i className="legend-line selected" />Selected</span>
              <span className="legend-item"><i className="legend-line delay-moderate" />Delay &lt;45m</span>
              <span className="legend-item"><i className="legend-line delay-severe" />Delay 45m+</span>
              {recordedReplay && <span className="legend-item"><i className="legend-line recorded" />Recorded = dashed</span>}
              {scenarioMode === "ground" && <span className="legend-item"><i className="legend-airport" />Airport</span>}
            </div>
          </div>

          {isChunkLoading ? (
            <div className="network-map network-state" role="status">
              <div className="loading-orbit" aria-hidden="true" />
              <strong>Loading {airlineName(carrier)} · {formatDate(date, true)}</strong>
              <span>Preparing the service-day network.</span>
            </div>
          ) : chunkError ? (
            <div className="network-map network-state" role="alert">
              <strong>That service day could not be opened</strong>
              <span>{chunkError}</span>
              <button type="button" onClick={retryChunk}>Try again</button>
            </div>
          ) : (
            <NetworkMap
              key={`${date}-${carrier}`}
              airports={airports}
              routes={routes}
              selectedRouteKey={selectedRouteKey}
              selectedAirportCode={scenarioMode === "ground" ? effectiveGroundAirport : null}
              modeledRouteDelays={modeledRouteDelays}
              recordedRouteDelays={recordedRouteDelays}
              selectionMode={scenarioMode === "ground" ? "airport" : "route"}
              onSelectRoute={selectRoute}
              onSelectAirport={(airport) => {
                setScenarioMode("ground");
                setGroundAirport(airport.code);
              }}
            />
          )}

          <div className="network-metrics" aria-live="polite">
            <div className="metric"><span>Scheduled flights</span><strong>{flights.length.toLocaleString()}</strong></div>
            <div className="metric"><span>Active airports</span><strong>{activeAirportCount}</strong></div>
            <div className="metric"><span>Aircraft tails</span><strong>{tailCount.toLocaleString()}</strong></div>
            <div className="metric"><span>{recordedReplay ? "Modeled impact" : "Scenario impact"}</span><strong className={simulation?.summary.affectedFlightCount ? `impact-value ${delaySeverityClass(simulation.summary.maxDelayMinutes)}` : ""}>{simulation ? plural(simulation.summary.affectedFlightCount, "flight") : "None"}</strong></div>
          </div>
        </section>

        <aside className="scenario-panel" aria-label="Disruption scenario">
          <div className="scenario-panel-inner">
            <div className="scenario-head">
              <h2>Disruption lab</h2>
              <p>Adjust one operational constraint. The network updates instantly.</p>
              <div className="scenario-tabs" aria-label="Scenario type">
                <button
                  type="button"
                  aria-pressed={scenarioMode === "flight"}
                  className={scenarioMode === "flight" ? "active" : ""}
                  onClick={() => setScenarioMode("flight")}
                >Flight delay</button>
                <button
                  type="button"
                  aria-pressed={scenarioMode === "ground"}
                  className={scenarioMode === "ground" ? "active" : ""}
                  onClick={() => setScenarioMode("ground")}
                >Ground stop</button>
              </div>
            </div>

            <div className="scenario-scroll">
              {scenarioMode === "flight" ? (
                <FlightDelayPanel
                  routes={routes}
                  selectedRouteKey={selectedRouteKey}
                  routeFlights={routeFlights}
                  selectedFlight={selectedFlight}
                  delayMinutes={delayMinutes}
                  delaySource={delaySource}
                  observedDelay={observedDelay}
                  simulation={simulation}
                  recordedReplay={recordedReplay}
                  aircraftRotation={selectedAircraftRotation}
                  onSelectRoute={selectRoute}
                  onClearRoute={() => setSelectedRouteKey(null)}
                  onSelectFlight={selectExactFlight}
                  onDelayChange={chooseManualDelay}
                  onReplayActual={replayActualDelay}
                />
              ) : (
                <GroundStopPanel
                  airportTraffic={airportTraffic}
                  airports={airports}
                  groundAirport={effectiveGroundAirport}
                  groundStart={groundStart}
                  groundEnd={groundEnd}
                  groundWindowValid={groundWindowValid}
                  simulation={simulation}
                  onAirportChange={setGroundAirport}
                  onStartChange={setGroundStart}
                  onEndChange={setGroundEnd}
                />
              )}

              <section className="panel-section">
                <div className="section-label">Model scope</div>
                <p className="method-note">
                  Propagation follows the reported aircraft tail with a 35-minute minimum turn. It stops at cancellations, diversions, broken rotations, or the end of the selected service day. Crew, gate, passenger-connection, and aircraft-swap effects are not included.
                </p>
              </section>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

type FlightDelayPanelProps = {
  routes: NetworkRoute[];
  selectedRouteKey: string | null;
  routeFlights: Flight[];
  selectedFlight: Flight | null;
  delayMinutes: number;
  delaySource: DelaySource;
  observedDelay: number;
  simulation: SimulationResult | null;
  recordedReplay: RecordedReplayResult | null;
  aircraftRotation: AircraftDayRotation | null;
  onSelectRoute: (route: NetworkRoute) => void;
  onClearRoute: () => void;
  onSelectFlight: (id: string) => void;
  onDelayChange: (minutes: number) => void;
  onReplayActual: () => void;
};

function FlightDelayPanel({
  routes,
  selectedRouteKey,
  routeFlights,
  selectedFlight,
  delayMinutes,
  delaySource,
  observedDelay,
  simulation,
  recordedReplay,
  aircraftRotation,
  onSelectRoute,
  onClearRoute,
  onSelectFlight,
  onDelayChange,
  onReplayActual,
}: FlightDelayPanelProps) {
  const selectedRoute = selectedRouteKey ? routeFromKey(selectedRouteKey) : null;
  const delaySliderMaximum = Math.max(
    360,
    Math.ceil(delayMinutes / 60) * 60,
  );
  const selectedDelayClass = delaySeverityClass(delayMinutes);
  const observedDelayClass = delaySeverityClass(observedDelay);
  return (
    <>
      <section className="panel-section">
        <div className="section-label"><span>1 · Choose route</span><span>{routes.length} routes</span></div>
        {selectedRoute ? (
          <div className="route-selection">
            <div className="route-selection-main">
              <div className="route-codes">
                <span>{selectedRoute.origin}</span><span className="route-arrow">→</span><span>{selectedRoute.destination}</span>
              </div>
              <small>{plural(routeFlights.length, "departure")} on this service day</small>
            </div>
            <button type="button" className="clear-button" onClick={onClearRoute}>Change</button>
          </div>
        ) : (
          <>
            <div className="route-prompt">
              <strong>Pick a line on the map</strong>
              <p>Routes with multiple flights will let you choose the exact scheduled departure.</p>
            </div>
            <div className="popular-routes" aria-label="Busiest routes">
              {routes.slice(0, 5).map((route) => (
                <button key={route.key} type="button" className="route-shortcut" onClick={() => onSelectRoute(route)}>
                  <span>{route.origin} → {route.destination}</span>
                  <small>{plural(route.flights, "flight")}</small>
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      {selectedRoute && (
        <section className="panel-section">
          <div className="section-label"><span>2 · Exact departure</span><span>Local time</span></div>
          <div className="flight-list">
            {routeFlights.map((flight) => {
              const unavailable = flight.cancelled || flight.diverted;
              const observed = getActualDelaySeedMinutes(flight);
              return (
                <button
                  key={flight.id}
                  type="button"
                  className={`flight-option${selectedFlight?.id === flight.id ? " selected" : ""}`}
                  aria-pressed={selectedFlight?.id === flight.id}
                  disabled={unavailable}
                  onClick={() => onSelectFlight(flight.id)}
                >
                  <span className="flight-time">{formatTime(flight.scheduledDeparture)}</span>
                  <span className="flight-meta">
                    <strong>Flight {flight.flightNumber}</strong>
                    <span>{flight.tail || "Tail unavailable"} · {Math.round(flight.distance).toLocaleString()} mi</span>
                  </span>
                  <span className={`flight-status ${delaySeverityClass(observed)}`}>
                    {flight.cancelled ? "CANCELLED" : flight.diverted ? "DIVERTED" : observed > 0 ? `+${Math.round(observed)}m` : "ON TIME"}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {selectedFlight && (
        <section className="panel-section">
          <div className="section-label"><span>3 · Introduce delay</span><span>{delaySource === "actual" ? "Recorded" : "Custom"}</span></div>
          <div className={`delay-control ${selectedDelayClass}`}>
            <div className="delay-readout"><strong>+{delayMinutes}m</strong><span>departure delay</span></div>
            <input
              type="range"
              min="0"
              max={delaySliderMaximum}
              step="5"
              value={delayMinutes}
              aria-label="Departure delay in minutes"
              onChange={(event) => onDelayChange(Number(event.target.value))}
            />
            <div className="range-labels">
              <span>0m</span>
              <span>{Math.round(delaySliderMaximum / 3)}m</span>
              <span>{Math.round((delaySliderMaximum * 2) / 3)}m</span>
              <span>{Math.round(delaySliderMaximum / 60)}h</span>
            </div>
            <div className="quick-delays">
              {[30, 60, 90, 120].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={delaySource === "planned" && delayMinutes === value}
                  className={`${delaySeverityClass(value)}${delaySource === "planned" && delayMinutes === value ? " active" : ""}`}
                  onClick={() => onDelayChange(value)}
                >+{value}m</button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className={`actual-delay-button ${observedDelayClass}${delaySource === "actual" ? " active" : ""}`}
            aria-pressed={delaySource === "actual"}
            disabled={observedDelay <= 0}
            onClick={onReplayActual}
          >
            {observedDelay > 0 ? `Replay recorded delay · +${Math.round(observedDelay)} minutes` : "No recorded departure delay for this flight"}
          </button>
        </section>
      )}

      {selectedFlight && (
        <ImpactPanel
          simulation={simulation}
          recordedReplay={recordedReplay}
          aircraftRotation={aircraftRotation}
          selectedFlight={selectedFlight}
          delaySource={delaySource}
          emptyMessage={delayMinutes === 0 ? "Set a delay above zero to run the rotation." : "This delay is recovered before the next aircraft leg."}
        />
      )}
    </>
  );
}

type GroundStopPanelProps = {
  airportTraffic: [string, number][];
  airports: Map<string, Airport>;
  groundAirport: string;
  groundStart: number;
  groundEnd: number;
  groundWindowValid: boolean;
  simulation: SimulationResult | null;
  onAirportChange: (code: string) => void;
  onStartChange: (minutes: number) => void;
  onEndChange: (minutes: number) => void;
};

function GroundStopPanel({
  airportTraffic,
  airports,
  groundAirport,
  groundStart,
  groundEnd,
  groundWindowValid,
  simulation,
  onAirportChange,
  onStartChange,
  onEndChange,
}: GroundStopPanelProps) {
  const airport = airports.get(groundAirport);
  return (
    <>
      <section className="panel-section">
        <div className="section-label"><span>Ground stop setup</span><span>Local time</span></div>
        <div className="field-grid">
          <div className="form-field full">
            <label htmlFor="stop-airport">Airport</label>
            <select id="stop-airport" value={groundAirport} onChange={(event) => onAirportChange(event.target.value)}>
              {airportTraffic.map(([code, count]) => (
                <option key={code} value={code}>{code} · {airports.get(code)?.city || airports.get(code)?.name || "Airport"} ({count})</option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="stop-start">Start</label>
            <input id="stop-start" type="time" value={timeInputValue(groundStart)} onChange={(event) => onStartChange(parseTimeInput(event.target.value))} />
          </div>
          <div className="form-field">
            <label htmlFor="stop-end">Release</label>
            <input id="stop-end" type="time" value={timeInputValue(groundEnd)} onChange={(event) => onEndChange(parseTimeInput(event.target.value))} />
          </div>
        </div>
        <p className="ground-stop-note">
          Flights scheduled to depart {groundAirport || "the airport"} during this window are held until release. Their aircraft delays then continue through later legs.
        </p>
        {!groundWindowValid && <p className="method-note" style={{ marginTop: 9, color: "var(--red-soft)" }}>Release must be later than the start on the selected date.</p>}
        {airport && <p className="method-note" style={{ marginTop: 9 }}>{airport.name} · {airport.city}{airport.state ? `, ${airport.state}` : ""}</p>}
      </section>

      <ImpactPanel simulation={simulation} emptyMessage={groundWindowValid ? "No scheduled departures fall inside this ground-stop window." : "Choose a valid same-day window to run the ground stop."} />
    </>
  );
}

function recordedFlightLabel(flight: Flight) {
  const observation = getRecordedDepartureObservation(flight);
  if (observation.status === "cancelled") return "Cancelled";
  const timing = observation.delayMinutes == null
    ? "Unknown"
    : observation.delayMinutes > 0
      ? `+${Math.round(observation.delayMinutes)}m`
      : "On time / early";
  return observation.status === "diverted" ? `${timing} · diverted` : timing;
}

function stopReasonLabel(reason: SimulationResult["stops"][number]["reason"]) {
  switch (reason) {
    case "cancelled": return "a cancellation";
    case "diverted": return "a diversion";
    case "airport-mismatch": return "a broken airport sequence";
    case "out-of-order": return "an invalid timing sequence";
    case "tail-mismatch": return "an aircraft change";
    case "missing-tail": return "a missing aircraft tail";
    case "missing-next-flight": return "a missing next flight";
    case "cycle": return "an invalid rotation loop";
  }
}

function AircraftDayTimeline({
  rotation,
  selectedFlight,
  simulation,
  showRecorded,
}: {
  rotation: AircraftDayRotation;
  selectedFlight: Flight;
  simulation: SimulationResult | null;
  showRecorded: boolean;
}) {
  const linkedFlightIds = new Set(rotation.linkedFlightIds);
  const stoppedFlightIds = new Set(
    simulation?.stops
      .map((stop) => stop.nextFlightId)
      .filter((flightId): flightId is string => Boolean(flightId)) ?? [],
  );
  const recoveryFlight = simulation
    && simulation.summary.affectedFlightCount > 0
    && simulation.stops.length === 0
    ? rotation.flights.find((flight, index) =>
        index > rotation.selectedIndex
        && linkedFlightIds.has(flight.id)
        && !simulation.impacts[flight.id]) ?? null
    : null;
  const firstStop = simulation?.stops[0] ?? null;
  const stopFlightId = firstStop?.nextFlightId ?? firstStop?.flightId;
  const stopFlight = rotation.flights.find((flight) => flight.id === stopFlightId);
  const outcome = recoveryFlight
    ? `Back on schedule at ${formatTime(recoveryFlight.scheduledDeparture)} · Flight ${recoveryFlight.flightNumber}.`
    : simulation?.summary.affectedFlightCount
      ? firstStop
        ? `No modeled recovery: propagation stops${stopFlight ? ` at ${formatTime(stopFlight.scheduledDeparture)} · Flight ${stopFlight.flightNumber}` : ""} because of ${stopReasonLabel(firstStop.reason)}.`
        : "No recovery appears before this linked service-day rotation ends."
      : "No delay is currently introduced.";

  return (
    <section className="aircraft-day" aria-labelledby="aircraft-day-heading">
      <div className="aircraft-day-heading">
        <h3 id="aircraft-day-heading">Aircraft day · {rotation.tail ?? "Tail unavailable"}</h3>
        <span>{plural(rotation.flights.length, "flight")}</span>
      </div>
      <ol className={`rotation-list aircraft-day-list${showRecorded ? " with-recorded" : ""}`}>
        {rotation.flights.map((flight, index) => {
          const beforeScenario = index < rotation.selectedIndex;
          const isSelected = flight.id === selectedFlight.id;
          const isLinked = linkedFlightIds.has(flight.id);
          const impact = simulation?.impacts[flight.id] ?? null;
          const isRecovery = flight.id === recoveryFlight?.id;
          const modelStopped = stoppedFlightIds.has(flight.id);
          const modelLabel = beforeScenario
            ? "Before scenario"
            : impact
              ? isSelected
                ? `+${Math.round(impact.departureDelayMinutes)}m · starts here`
                : `+${Math.round(impact.departureDelayMinutes)}m`
              : modelStopped
                ? "Model stops"
                : !isLinked
                  ? "Not linked to selected flight"
                  : isRecovery
                    ? "Recovered here"
                    : isSelected
                      ? "Selected · no added delay"
                      : "No modeled delay";
          const modelClass = impact
            ? delaySeverityClass(impact.departureDelayMinutes)
            : modelStopped
              ? "model-stopped"
              : isRecovery
                ? "recovered"
                : "";
          const recordedObservation = getRecordedDepartureObservation(flight);
          const recordedClass = `${recordedObservation.status} ${delaySeverityClass(recordedObservation.delayMinutes)}`;
          const rowClass = [
            "rotation-row",
            "aircraft-day-row",
            isSelected ? "scenario-start" : "",
            isRecovery ? "recovery-point" : "",
            impact ? delaySeverityClass(impact.departureDelayMinutes) : "",
          ].filter(Boolean).join(" ");

          return (
            <li
              aria-current={isSelected ? "step" : undefined}
              className={rowClass}
              key={flight.id}
            >
              <span className="rotation-index">{index + 1}</span>
              <span className="rotation-flight">
                <strong>{flight.origin} → {flight.destination} · Flight {flight.flightNumber}</strong>
                <span>{formatTime(flight.scheduledDeparture)} · leg {index + 1} of {rotation.flights.length}</span>
              </span>
              {showRecorded ? (
                <span className="replay-delay-pair">
                  <span>
                    <small>Model</small>
                    <strong className={modelClass}>{modelLabel}</strong>
                  </span>
                  <span>
                    <small>Recorded</small>
                    <strong className={recordedClass}>{recordedFlightLabel(flight)}</strong>
                  </span>
                </span>
              ) : (
                <span className={`rotation-delay aircraft-day-status ${modelClass}`}>{modelLabel}</span>
              )}
            </li>
          );
        })}
      </ol>
      <div
        aria-live="polite"
        className={`rotation-outcome${recoveryFlight ? " recovered" : ""}`}
        role="status"
      >
        {outcome}
      </div>
      <p className="method-note aircraft-day-note">
        {rotation.tail
          ? "Every flight shown has the same reported aircraft tail that day. The model carries delay only through flights whose airports and times form a continuous sequence. Later flights that cannot be reliably connected remain visible, but their delay is not modeled."
          : "This flight has no reported aircraft tail, so other legs from its aircraft day cannot be identified."}
      </p>
    </section>
  );
}

function ImpactPanel({
  simulation,
  recordedReplay = null,
  aircraftRotation = null,
  selectedFlight = null,
  delaySource = "planned",
  emptyMessage,
}: {
  simulation: SimulationResult | null;
  recordedReplay?: RecordedReplayResult | null;
  aircraftRotation?: AircraftDayRotation | null;
  selectedFlight?: Flight | null;
  delaySource?: DelaySource;
  emptyMessage: string;
}) {
  const summary = simulation?.summary;
  const replaySummary = recordedReplay?.summary;
  const replayExceptions = replaySummary
    ? replaySummary.cancelledCount + replaySummary.divertedCount
    : 0;
  const simulationDelayClass = delaySeverityClass(summary?.maxDelayMinutes);
  const maximumModeledReplayDelay = recordedReplay
    ? recordedReplay.downstreamLegs.reduce(
        (maximum, leg) => Math.max(
          maximum,
          leg.modeledStatus === "delayed" ? leg.modeledDelayMinutes : 0,
        ),
        0,
      )
    : 0;
  const showAircraftDay = Boolean(aircraftRotation && selectedFlight);
  return (
    <section className="panel-section">
      <div className="section-label">
        <span>Network effect</span>
        <span>{recordedReplay ? "Replay vs record" : summary?.affectedFlightCount ? "Live" : "No ripple"}</span>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {recordedReplay && replaySummary
          ? `The model carries delay to ${replaySummary.modeledDelayedLegCount} later flights. ${replaySummary.downstreamLegCount === 0
              ? "No later same-aircraft flight is linked."
              : replaySummary.knownRecordedLegCount === 0
                ? "Later same-aircraft flights are linked, but none has a comparable recorded departure time."
                : `In the record, ${replaySummary.recordedDelayedLegCount} of ${replaySummary.knownRecordedLegCount} later same-aircraft departures left late, with ${Math.round(replaySummary.recordedDownstreamDelayMinutes)} recorded delay minutes.`}`
          : summary?.affectedFlightCount
          ? `${summary.affectedFlightCount} flights affected, ${summary.propagatedFlightCount} propagated, ${Math.round(summary.totalDelayMinutes)} total delay minutes.`
          : emptyMessage}
      </p>
      {simulation && summary?.affectedFlightCount ? (
        <>
          <div className={`impact-summary ${simulationDelayClass}`}>
            <div className="impact-card"><strong>{summary.affectedFlightCount}</strong><span>Flights</span></div>
            <div className="impact-card"><strong>{summary.propagatedFlightCount}</strong><span>Propagated</span></div>
            <div className="impact-card"><strong>{Math.round(summary.totalDelayMinutes)}</strong><span>Total min</span></div>
          </div>

          {recordedReplay && replaySummary ? (
            <>
              <div className="replay-comparison">
                <div className={`replay-side modeled ${delaySeverityClass(maximumModeledReplayDelay)}`}>
                  <span>Modeled later ripple</span>
                  <strong>{plural(replaySummary.modeledDelayedLegCount, "flight")}</strong>
                  <small>{Math.round(replaySummary.modeledDownstreamDelayMinutes).toLocaleString()} carried delay min</small>
                </div>
                <div className={`replay-side recorded ${delaySeverityClass(replaySummary.maxRecordedDelayMinutes)}`}>
                  <span>Recorded same-tail outcome</span>
                  <strong>
                    {replaySummary.downstreamLegCount === 0
                      ? "No later linked flight"
                      : replaySummary.knownRecordedLegCount
                      ? `${replaySummary.recordedDelayedLegCount} of ${replaySummary.knownRecordedLegCount} left late`
                      : "No recorded departure time"}
                  </strong>
                  <small>
                    {Math.round(replaySummary.recordedDownstreamDelayMinutes).toLocaleString()} recorded delay min
                    {replayExceptions ? ` · ${replayExceptions} cancelled/diverted` : ""}
                    {replaySummary.unknownRecordedLegCount ? ` · ${replaySummary.unknownRecordedLegCount} unknown` : ""}
                  </small>
                </div>
              </div>
              <p className="method-note replay-disclaimer">
                The comparison cards and map use later linked departures. The aircraft-day rows also show earlier same-tail flights and context after any broken link. Recorded delays may have other causes; the BTS record does not prove the selected flight caused them.
                {" "}Late means any positive recorded departure delay; zero includes on-time and early departures.
              </p>
            </>
          ) : (
            !showAircraftDay ? <>
              <div className="rotation-list" style={{ marginTop: 17 }}>
                {simulation.affectedFlights.slice(0, 18).map((impact, index) => (
                  <div className={`rotation-row ${delaySeverityClass(impact.departureDelayMinutes)}`} key={impact.flightId}>
                    <span className="rotation-index">{index + 1}</span>
                    <span className="rotation-flight">
                      <strong>{impact.origin} → {impact.destination} · Flight {impact.flightNumber}</strong>
                      <span>{formatTime(impact.scheduledDeparture)} · {impact.cause === "rotation" ? "aircraft rotation" : impact.cause === "ground-stop" ? "held at airport" : "selected flight"}</span>
                    </span>
                    <span className="rotation-delay">+{Math.round(impact.departureDelayMinutes)}m</span>
                  </div>
                ))}
              </div>
              {simulation.affectedFlights.length > 18 && (
                <p className="method-note">Plus {simulation.affectedFlights.length - 18} more affected flights. Map routes are yellow below 45 minutes and red at 45 minutes or more.</p>
              )}
            </> : null
          )}
        </>
      ) : (
        <div className="empty-impact">{emptyMessage}</div>
      )}
      {aircraftRotation && selectedFlight && (
        <AircraftDayTimeline
          rotation={aircraftRotation}
          selectedFlight={selectedFlight}
          simulation={simulation}
          showRecorded={delaySource === "actual"}
        />
      )}
    </section>
  );
}
