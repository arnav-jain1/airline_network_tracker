"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { geoAlbersUsa, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import type {
  GeometryCollection,
  Objects,
  Topology,
} from "topojson-specification";
import statesTopology from "us-atlas/states-10m.json";

export type Airport = {
  code: string;
  id: number;
  name: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
};

export type NetworkRoute = {
  key: string;
  origin: string;
  destination: string;
  flights: number;
  distance: number;
};

type RouteHit = {
  route: NetworkRoute;
  points: [number, number][];
};

type InsetBox = { x: number; y: number; width: number; height: number; label: string };

type NetworkMapProps = {
  airports: Map<string, Airport>;
  routes: NetworkRoute[];
  selectedRouteKey: string | null;
  impactedRouteKeys: Set<string>;
  onSelectRoute: (route: NetworkRoute) => void;
};

type AtlasObjects = Objects & {
  nation: GeometryCollection;
  states: GeometryCollection;
};

const topology = statesTopology as unknown as Topology<AtlasObjects>;
const nation = feature(topology, topology.objects.nation);
const stateLines = mesh(
  topology,
  topology.objects.states,
  (a, b) => a !== b,
);

function distanceToSegment(
  x: number,
  y: number,
  a: [number, number],
  b: [number, number],
) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(x - a[0], y - a[1]);
  const t = Math.max(
    0,
    Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

function routeCurve(
  origin: [number, number],
  destination: [number, number],
) {
  const dx = destination[0] - origin[0];
  const dy = destination[1] - origin[1];
  const length = Math.max(1, Math.hypot(dx, dy));
  // Keeping a consistent curve side relative to each directed origin makes
  // reverse services use separate lanes instead of perfectly overlapping.
  const curve = Math.min(42, Math.max(7, length * 0.105));
  const control: [number, number] = [
    (origin[0] + destination[0]) / 2 - (dy / length) * curve,
    (origin[1] + destination[1]) / 2 + (dx / length) * curve,
  ];
  const points: [number, number][] = [];
  for (let index = 0; index <= 18; index += 1) {
    const t = index / 18;
    const inverse = 1 - t;
    points.push([
      inverse * inverse * origin[0] + 2 * inverse * t * control[0] + t * t * destination[0],
      inverse * inverse * origin[1] + 2 * inverse * t * control[1] + t * t * destination[1],
    ]);
  }
  return points;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function territoryPosition(
  airport: Airport,
  caribbeanBox: InsetBox,
  pacificBox: InsetBox,
  fallbackIndex: number,
): [number, number] {
  if (airport.state === "PR" || airport.state === "VI") {
    const xRatio = clamp((airport.longitude + 67.3) / 2.7, 0, 1);
    const yRatio = clamp((airport.latitude - 17.55) / 1.05, 0, 1);
    return [
      caribbeanBox.x + 12 + xRatio * (caribbeanBox.width - 24),
      caribbeanBox.y + caribbeanBox.height - 10 - yRatio * (caribbeanBox.height - 27),
    ];
  }

  if (airport.code === "GUM" || airport.code === "SPN") {
    const xRatio = clamp((airport.longitude - 144.65) / 1.2, 0, 1);
    const yRatio = clamp((airport.latitude - 13.3) / 2.1, 0, 1);
    return [
      pacificBox.x + 11 + xRatio * (pacificBox.width - 22),
      pacificBox.y + pacificBox.height - 10 - yRatio * (pacificBox.height - 27),
    ];
  }

  return [
    pacificBox.x + 14 + (fallbackIndex % 3) * 18,
    pacificBox.y + pacificBox.height - 14 - Math.floor(fallbackIndex / 3) * 18,
  ];
}

export function NetworkMap({
  airports,
  routes,
  selectedRouteKey,
  impactedRouteKeys,
  onSelectRoute,
}: NetworkMapProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<RouteHit[]>([]);
  const routeStatusId = useId();
  const [size, setSize] = useState({ width: 900, height: 590 });
  const [hoverState, setHoverState] = useState<{
    routes: NetworkRoute[];
    routeKey: string | null;
  }>({ routes, routeKey: null });
  const [pointer, setPointer] = useState({ x: 0, y: 0 });

  // Route arrays change with the selected dataset. Treat an earlier array's
  // hover as cleared immediately so its tooltip cannot survive a data swap.
  const hoveredRouteKey = hoverState.routes === routes ? hoverState.routeKey : null;
  const hoveredRoute = useMemo(
    () => routes.find((route) => route.key === hoveredRouteKey) ?? null,
    [hoveredRouteKey, routes],
  );

  const airportTraffic = useMemo(() => {
    const traffic = new Map<string, number>();
    for (const route of routes) {
      traffic.set(route.origin, (traffic.get(route.origin) ?? 0) + route.flights);
      traffic.set(route.destination, (traffic.get(route.destination) ?? 0) + route.flights);
    }
    return traffic;
  }, [routes]);

  useEffect(() => {
    if (!shellRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(320, Math.floor(entry.contentRect.width));
      const height = Math.max(410, Math.floor(entry.contentRect.height));
      setSize({ width, height });
    });
    observer.observe(shellRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size.width * ratio;
    canvas.height = size.height * ratio;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);

    const projection = geoAlbersUsa().fitExtent(
      [[34, 34], [size.width - 36, size.height - 38]],
      nation,
    );
    const path = geoPath(projection, context);

    context.beginPath();
    path(nation);
    context.fillStyle = "#101a2c";
    context.fill();

    context.beginPath();
    path(stateLines);
    context.strokeStyle = "rgba(164, 188, 218, 0.14)";
    context.lineWidth = 0.75;
    context.stroke();

    const hits: RouteHit[] = [];
    const projectedAirports = new Map<string, [number, number]>();
    const activeAirportCodes = new Set(routes.flatMap((route) => [route.origin, route.destination]));
    const compactInsets = size.width < 620;
    const caribbeanBox: InsetBox = compactInsets
      ? { x: size.width - 171, y: size.height - 112, width: 126, height: 59, label: "CARIBBEAN" }
      : { x: size.width - 212, y: size.height - 132, width: 160, height: 76, label: "CARIBBEAN" };
    const pacificBox: InsetBox = compactInsets
      ? { x: size.width - 108, y: size.height - 182, width: 63, height: 55, label: "PACIFIC" }
      : { x: size.width - 137, y: size.height - 219, width: 85, height: 67, label: "PACIFIC" };
    const territoryAirports: Airport[] = [];
    for (const [code, airport] of airports) {
      const point = projection([airport.longitude, airport.latitude]);
      if (point) {
        projectedAirports.set(code, point as [number, number]);
      } else if (activeAirportCodes.has(code)) {
        territoryAirports.push(airport);
      }
    }

    territoryAirports.sort((a, b) => a.code.localeCompare(b.code));
    if (territoryAirports.length > 0) {
      const usedBoxes = new Set<InsetBox>();
      territoryAirports.forEach((airport, index) => {
        const box = airport.state === "PR" || airport.state === "VI" ? caribbeanBox : pacificBox;
        usedBoxes.add(box);
        projectedAirports.set(
          airport.code,
          territoryPosition(airport, caribbeanBox, pacificBox, index),
        );
      });
      for (const box of usedBoxes) {
        context.fillStyle = "rgba(8, 18, 33, 0.78)";
        context.strokeStyle = "rgba(164, 188, 218, 0.2)";
        context.lineWidth = 0.75;
        context.beginPath();
        context.roundRect(box.x, box.y, box.width, box.height, 7);
        context.fill();
        context.stroke();
        context.fillStyle = "rgba(164, 188, 218, 0.55)";
        context.font = "600 8px monospace";
        context.textAlign = "left";
        context.textBaseline = "top";
        context.fillText(box.label, box.x + 8, box.y + 6);
      }
    }

    const sortedRoutes = [...routes].sort((a, b) => {
      const aImportant = impactedRouteKeys.has(a.key) || a.key === selectedRouteKey;
      const bImportant = impactedRouteKeys.has(b.key) || b.key === selectedRouteKey;
      return Number(aImportant) - Number(bImportant) || a.flights - b.flights;
    });

    for (const route of sortedRoutes) {
      const origin = projectedAirports.get(route.origin);
      const destination = projectedAirports.get(route.destination);
      if (!origin || !destination) continue;
      const points = routeCurve(origin, destination);
      const impacted = impactedRouteKeys.has(route.key);
      const selected = route.key === selectedRouteKey;
      const isHovered = hoveredRouteKey === route.key;

      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      for (let index = 1; index < points.length; index += 1) {
        context.lineTo(points[index][0], points[index][1]);
      }
      context.strokeStyle = impacted
        ? "rgba(255, 88, 82, 0.96)"
        : selected
          ? "rgba(250, 203, 104, 0.98)"
          : isHovered
            ? "rgba(175, 228, 255, 0.96)"
            : "rgba(86, 172, 233, 0.34)";
      context.lineWidth = impacted
        ? 2.45
        : selected || isHovered
          ? 2.1
          : Math.min(1.55, 0.4 + Math.sqrt(route.flights) * 0.16);
      context.stroke();
      hits.push({ route, points });
    }

    const impactedAirports = new Set<string>();
    for (const route of routes) {
      if (impactedRouteKeys.has(route.key)) {
        impactedAirports.add(route.origin);
        impactedAirports.add(route.destination);
      }
    }

    const activeAirports = [...airportTraffic.entries()]
      .filter(([code]) => projectedAirports.has(code))
      .sort((a, b) => a[1] - b[1]);
    const maxTraffic = Math.max(1, ...activeAirports.map(([, count]) => count));
    for (const [code, count] of activeAirports) {
      const point = projectedAirports.get(code)!;
      const radius = 1.6 + Math.sqrt(count / maxTraffic) * 4;
      if (impactedAirports.has(code)) {
        context.beginPath();
        context.arc(point[0], point[1], radius + 4.5, 0, Math.PI * 2);
        context.strokeStyle = "rgba(255, 88, 82, 0.28)";
        context.lineWidth = 2;
        context.stroke();
      }
      context.beginPath();
      context.arc(point[0], point[1], radius, 0, Math.PI * 2);
      context.fillStyle = impactedAirports.has(code) ? "#ff625a" : "#d6eeff";
      context.fill();
      context.strokeStyle = "rgba(5, 13, 26, 0.8)";
      context.lineWidth = 1;
      context.stroke();
    }

    context.font = "600 10px var(--font-geist-mono), monospace";
    context.textAlign = "center";
    context.textBaseline = "bottom";
    const labelCount = size.width < 620 ? 6 : 11;
    for (const [code] of [...activeAirports].sort((a, b) => b[1] - a[1]).slice(0, labelCount)) {
      const point = projectedAirports.get(code)!;
      const metric = context.measureText(code);
      context.fillStyle = "rgba(7, 14, 27, 0.76)";
      context.fillRect(point[0] - metric.width / 2 - 3, point[1] - 20, metric.width + 6, 13);
      context.fillStyle = "rgba(218, 237, 250, 0.92)";
      context.fillText(code, point[0], point[1] - 8);
    }
    hitsRef.current = hits;
  }, [airports, airportTraffic, hoveredRouteKey, impactedRouteKeys, routes, selectedRouteKey, size]);

  function updateHoveredRoute(routeKey: string | null) {
    setHoverState((current) => {
      if (current.routes === routes && current.routeKey === routeKey) return current;
      return { routes, routeKey };
    });
  }

  function locateRoute(x: number, y: number) {
    let best: RouteHit | null = null;
    let bestDistance = 9;
    // Walk from the last painted route to the first so the visible top line
    // wins when routes cross or share part of their geometry.
    for (let hitIndex = hitsRef.current.length - 1; hitIndex >= 0; hitIndex -= 1) {
      const hit = hitsRef.current[hitIndex];
      for (let index = 1; index < hit.points.length; index += 1) {
        const distance = distanceToSegment(x, y, hit.points[index - 1], hit.points[index]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = hit;
        }
      }
    }
    return best;
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setPointer((current) => current.x === x && current.y === y ? current : { x, y });
    updateHoveredRoute(locateRoute(x, y)?.route.key ?? null);
  }

  function handleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = locateRoute(x, y);
    updateHoveredRoute(hit?.route.key ?? null);
    if (hit) onSelectRoute(hit.route);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLCanvasElement>) {
    if (!["ArrowRight", "ArrowLeft", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    const routesByTraffic = [...routes].sort((a, b) => b.flights - a.flights);
    if (event.key === "Enter" || event.key === " ") {
      if (hoveredRoute) onSelectRoute(hoveredRoute);
      return;
    }
    const currentIndex = hoveredRouteKey
      ? routesByTraffic.findIndex((route) => route.key === hoveredRouteKey)
      : -1;
    const nextIndex = event.key === "ArrowRight"
      ? (currentIndex + 1) % routesByTraffic.length
      : (currentIndex - 1 + routesByTraffic.length) % routesByTraffic.length;
    const next = hitsRef.current.find((hit) => hit.route.key === routesByTraffic[nextIndex]?.key);
    if (next) updateHoveredRoute(next.route.key);
  }

  return (
    <div className="network-map" ref={shellRef}>
      <canvas
        ref={canvasRef}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => updateHoveredRoute(null)}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        aria-label="Interactive airline route map. Use the pointer to choose a route, or the arrow keys and Enter."
        aria-describedby={routeStatusId}
      />
      {hoveredRoute && (
        <div
          className="map-tooltip"
          aria-hidden="true"
          style={{
            left: Math.min(pointer.x + 14, size.width - 174),
            top: Math.max(12, pointer.y - 56),
          }}
        >
          <span>{hoveredRoute.origin} → {hoveredRoute.destination}</span>
          <strong>{hoveredRoute.flights} scheduled flight{hoveredRoute.flights === 1 ? "" : "s"}</strong>
        </div>
      )}
      <div
        id={routeStatusId}
        className="map-route-status"
        role="status"
        aria-atomic="true"
      >
        {hoveredRoute
          ? `Current route: ${hoveredRoute.origin} to ${hoveredRoute.destination}, ${hoveredRoute.flights} scheduled ${hoveredRoute.flights === 1 ? "flight" : "flights"}. Press Enter to select.`
          : "No route highlighted. Use the left and right arrow keys to explore routes."}
      </div>
      <div className="map-scale-note">Geographic view · Alaska, Hawaiʻi & territories inset</div>
    </div>
  );
}
