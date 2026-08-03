"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { geoAlbersUsa, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import type {
  GeometryCollection,
  Objects,
  Topology,
} from "topojson-specification";
import statesTopology from "us-atlas/states-10m.json";
import {
  type DelaySeverity,
  getDelaySeverity,
} from "../lib/simulation";

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

type ViewTransform = {
  scale: number;
  x: number;
  y: number;
};

type AirportMarker = {
  airport: Airport;
  traffic: number;
  x: number;
  y: number;
  size: number;
  showLabel: boolean;
  delayMinutes: number;
  delaySeverity: DelaySeverity;
  selected: boolean;
  focused: boolean;
  leaderLength: number;
  leaderAngle: number;
};

type NetworkMapProps = {
  airports: Map<string, Airport>;
  routes: NetworkRoute[];
  selectedRouteKey: string | null;
  selectedAirportCode: string | null;
  modeledRouteDelays: ReadonlyMap<string, number>;
  recordedRouteDelays: ReadonlyMap<string, number>;
  selectionMode: "route" | "airport";
  onSelectRoute: (route: NetworkRoute) => void;
  onSelectAirport: (airport: Airport) => void;
};

type AtlasObjects = Objects & {
  nation: GeometryCollection;
  states: GeometryCollection;
};

const topology = statesTopology as unknown as Topology<AtlasObjects>;
const nation = feature(topology, topology.objects.nation);
const states = feature(topology, topology.objects.states);
if (states.type !== "FeatureCollection") {
  throw new Error("Expected the US atlas states to be a feature collection.");
}
const alaska = states.features.find((state) => String(state.id) === "02");
const statesWithoutAlaska = {
  ...states,
  features: states.features.filter((state) => state !== alaska),
};
const stateLines = mesh(
  topology,
  topology.objects.states,
  (a, b) => a !== b,
);

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

function delayColor(severity: DelaySeverity, alpha = 0.98) {
  return severity === "severe"
    ? `rgba(196, 59, 53, ${alpha})`
    : `rgba(135, 87, 0, ${alpha})`;
}

function severityRank(severity: DelaySeverity) {
  return severity === "severe" ? 2 : severity === "moderate" ? 1 : 0;
}

function clampView(
  view: ViewTransform,
  size: { width: number; height: number },
): ViewTransform {
  const scale = clamp(view.scale, MIN_ZOOM, MAX_ZOOM);
  if (scale <= MIN_ZOOM) {
    return { scale: MIN_ZOOM, x: 0, y: 0 };
  }
  return {
    scale,
    x: clamp(view.x, size.width * (1 - scale), 0),
    y: clamp(view.y, size.height * (1 - scale), 0),
  };
}

function screenPoint(
  point: [number, number],
  view: ViewTransform,
): [number, number] {
  return [
    point[0] * view.scale + view.x,
    point[1] * view.scale + view.y,
  ];
}

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

function pluralFlights(value: number) {
  return `${value.toLocaleString()} scheduled movement${value === 1 ? "" : "s"}`;
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
  selectedAirportCode,
  modeledRouteDelays,
  recordedRouteDelays,
  selectionMode,
  onSelectRoute,
  onSelectAirport,
}: NetworkMapProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hitsRef = useRef<RouteHit[]>([]);
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef({
    centerX: 0,
    centerY: 0,
    distance: 0,
    movement: 0,
  });
  const suppressClickRef = useRef(false);
  const viewRef = useRef<ViewTransform>({ scale: MIN_ZOOM, x: 0, y: 0 });
  const viewFrameRef = useRef<number | null>(null);
  const routeStatusId = useId();
  const mapCanvasId = useId();
  const [size, setSize] = useState({ width: 900, height: 590 });
  const [view, setView] = useState<ViewTransform>({
    scale: MIN_ZOOM,
    x: 0,
    y: 0,
  });
  const [isDragging, setIsDragging] = useState(false);
  const [visibleAirportMarkers, setVisibleAirportMarkers] = useState<AirportMarker[]>([]);
  const [focusedAirportCode, setFocusedAirportCode] = useState<string | null>(null);
  const [hoverState, setHoverState] = useState<{
    routes: NetworkRoute[];
    routeKey: string | null;
  }>({ routes, routeKey: null });
  const [pointer, setPointer] = useState({ x: 0, y: 0 });

  const commitView = useCallback((next: ViewTransform) => {
    viewRef.current = next;
    if (viewFrameRef.current != null) return;
    viewFrameRef.current = window.requestAnimationFrame(() => {
      viewFrameRef.current = null;
      setView(viewRef.current);
    });
  }, []);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => () => {
    if (viewFrameRef.current != null) {
      window.cancelAnimationFrame(viewFrameRef.current);
    }
  }, []);

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
      if ((document.activeElement as Element | null)?.closest(".airport-marker")) {
        canvasRef.current?.focus({ preventScroll: true });
      }
      const width = Math.max(320, Math.floor(entry.contentRect.width));
      const height = Math.max(410, Math.floor(entry.contentRect.height));
      const nextSize = { width, height };
      setSize(nextSize);
      setView((current) => {
        const next = clampView(current, nextSize);
        viewRef.current = next;
        return next;
      });
    });
    observer.observe(shellRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const handleWheel = (event: WheelEvent) => {
      if ((event.target as Element | null)?.closest(".map-controls")) return;
      const current = viewRef.current;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? size.height
          : 1;
      const nextScale = clamp(
        current.scale * Math.exp(-event.deltaY * unit * 0.0015),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      if (Math.abs(nextScale - current.scale) < 0.001) return;

      event.preventDefault();
      if ((document.activeElement as Element | null)?.closest(".airport-marker")) {
        canvasRef.current?.focus({ preventScroll: true });
      }
      setHoverState((currentHover) => currentHover.routeKey === null
        ? currentHover
        : { ...currentHover, routeKey: null });
      const rect = shell.getBoundingClientRect();
      const anchorX = event.clientX - rect.left;
      const anchorY = event.clientY - rect.top;
      const ratio = nextScale / current.scale;
      const next = clampView({
        scale: nextScale,
        x: anchorX - (anchorX - current.x) * ratio,
        y: anchorY - (anchorY - current.y) * ratio,
      }, size);
      commitView(next);
    };

    shell.addEventListener("wheel", handleWheel, { passive: false });
    return () => shell.removeEventListener("wheel", handleWheel);
  }, [commitView, size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(size.width * ratio);
    const pixelHeight = Math.round(size.height * ratio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.save();
    context.translate(view.x, view.y);
    context.scale(view.scale, view.scale);

    const projection = geoAlbersUsa().fitExtent(
      [[34, 34], [size.width - 36, size.height - 38]],
      nation,
    );
    const path = geoPath(projection, context);
    const compactInsets = size.width < 620;
    const alaskaOffsetY = compactInsets ? -18 : -24;

    context.beginPath();
    path(statesWithoutAlaska);
    context.fillStyle = "#f8fafc";
    context.fill();

    if (alaska) {
      context.save();
      context.translate(0, alaskaOffsetY);
      context.beginPath();
      path(alaska);
      context.fill();
      context.restore();
    }

    context.beginPath();
    path(stateLines);
    context.strokeStyle = "rgba(48, 72, 94, 0.68)";
    context.lineWidth = 0.75 / view.scale;
    context.stroke();

    const hits: RouteHit[] = [];
    const projectedAirports = new Map<string, [number, number]>();
    const activeAirportCodes = new Set(routes.flatMap((route) => [route.origin, route.destination]));
    const caribbeanBox: InsetBox = compactInsets
      ? { x: size.width - 171, y: size.height - 88, width: 126, height: 59, label: "CARIBBEAN" }
      : { x: size.width - 212, y: size.height - 108, width: 160, height: 76, label: "CARIBBEAN" };
    const pacificBox: InsetBox = compactInsets
      ? { x: size.width - 108, y: size.height - 182, width: 63, height: 55, label: "PACIFIC" }
      : { x: size.width - 137, y: size.height - 219, width: 85, height: 67, label: "PACIFIC" };
    const territoryAirports: Airport[] = [];
    for (const [code, airport] of airports) {
      const point = projection([airport.longitude, airport.latitude]);
      if (point) {
        projectedAirports.set(code, [
          point[0],
          point[1] + (airport.state === "AK" ? alaskaOffsetY : 0),
        ]);
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
        context.fillStyle = "rgba(255, 255, 255, 0.9)";
        context.strokeStyle = "rgba(54, 78, 101, 0.36)";
        context.lineWidth = 0.75 / view.scale;
        context.beginPath();
        context.roundRect(box.x, box.y, box.width, box.height, 7);
        context.fill();
        context.stroke();
        context.fillStyle = "rgba(43, 64, 84, 0.78)";
        context.font = `600 ${8 / view.scale}px monospace`;
        context.textAlign = "left";
        context.textBaseline = "top";
        context.fillText(
          box.label,
          box.x + 8 / view.scale,
          box.y + 6 / view.scale,
        );
      }
    }

    const sortedRoutes = [...routes].sort((a, b) => {
      const aImportant = (modeledRouteDelays.get(a.key) ?? 0) > 0 || (recordedRouteDelays.get(a.key) ?? 0) > 0 || a.key === selectedRouteKey;
      const bImportant = (modeledRouteDelays.get(b.key) ?? 0) > 0 || (recordedRouteDelays.get(b.key) ?? 0) > 0 || b.key === selectedRouteKey;
      return Number(aImportant) - Number(bImportant) || a.flights - b.flights;
    });

    for (const route of sortedRoutes) {
      const origin = projectedAirports.get(route.origin);
      const destination = projectedAirports.get(route.destination);
      if (!origin || !destination) continue;
      const points = routeCurve(origin, destination);
      const modeledSeverity = getDelaySeverity(modeledRouteDelays.get(route.key));
      const recordedSeverity = getDelaySeverity(recordedRouteDelays.get(route.key));
      const modeled = modeledSeverity !== "none";
      const recorded = recordedSeverity !== "none";
      const selected = route.key === selectedRouteKey;
      const isHovered = hoveredRouteKey === route.key;

      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      for (let index = 1; index < points.length; index += 1) {
        context.lineTo(points[index][0], points[index][1]);
      }
      context.strokeStyle = modeled
        ? delayColor(modeledSeverity)
        : selected
          ? "rgba(135, 87, 0, 0.98)"
          : isHovered
            ? "rgba(0, 78, 122, 0.98)"
            : "rgba(0, 82, 132, 0.68)";
      context.lineWidth = (modeled
        ? 2.45
        : selected || isHovered
          ? 2.1
          : Math.min(1.55, 0.4 + Math.sqrt(route.flights) * 0.16)) / view.scale;
      context.stroke();
      if (recorded) {
        context.save();
        context.setLineDash([5.5 / view.scale, 4 / view.scale]);
        context.strokeStyle = delayColor(recordedSeverity);
        context.lineWidth = 1.75 / view.scale;
        context.stroke();
        context.restore();
      }
      hits.push({ route, points: points.map((point) => screenPoint(point, view)) });
    }

    const airportDelayMinutes = new Map<string, number>();
    for (const route of routes) {
      const routeDelay = Math.max(
        modeledRouteDelays.get(route.key) ?? 0,
        recordedRouteDelays.get(route.key) ?? 0,
      );
      if (routeDelay <= 0) continue;
      airportDelayMinutes.set(
        route.origin,
        Math.max(airportDelayMinutes.get(route.origin) ?? 0, routeDelay),
      );
      airportDelayMinutes.set(
        route.destination,
        Math.max(airportDelayMinutes.get(route.destination) ?? 0, routeDelay),
      );
    }

    const activeAirports = [...airportTraffic.entries()]
      .filter(([code]) => projectedAirports.has(code))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const maxTraffic = Math.max(1, ...activeAirports.map(([, count]) => count));
    const markerCandidates: AirportMarker[] = [];

    activeAirports.forEach(([code, count]) => {
      const airport = airports.get(code);
      const point = projectedAirports.get(code);
      if (!airport || !point) return;
      const delayMinutes = airportDelayMinutes.get(code) ?? 0;
      const delaySeverity = getDelaySeverity(delayMinutes);
      const delayed = delaySeverity !== "none";
      const selected = code === selectedAirportCode;
      const focused = code === focusedAirportCode;
      const importance = Math.sqrt(count / maxTraffic);
      const revealAt = MIN_ZOOM + (1 - importance) * 3.6;
      const labelAt = Math.min(MAX_ZOOM, revealAt + 0.25);
      if (!delayed && !selected && !focused && view.scale + 0.001 < revealAt) return;

      const [x, y] = screenPoint(point, view);
      if (x < -90 || x > size.width + 90 || y < -90 || y > size.height + 90) {
        return;
      }
      markerCandidates.push({
        airport,
        traffic: count,
        x,
        y,
        size: 5 + importance * 7,
        showLabel: delayed || selected || focused || view.scale + 0.001 >= labelAt,
        delayMinutes,
        delaySeverity,
        selected,
        focused,
        leaderLength: 0,
        leaderAngle: 0,
      });
    });

    markerCandidates.sort((a, b) =>
      Number(b.selected) - Number(a.selected)
      || severityRank(b.delaySeverity) - severityRank(a.delaySeverity)
      || b.traffic - a.traffic
      || a.airport.code.localeCompare(b.airport.code));
    const markers: AirportMarker[] = [];
    for (const candidate of markerCandidates) {
      const centerIsAvailable = (x: number, y: number) => {
        const outsideViewport = x < 23 || x > size.width - 23 || y < 23 || y > size.height - 23;
        const intersectsControls = x > size.width - 183 && y < 80;
        const overlapsMarker = markers.some((marker) =>
          Math.hypot(marker.x - x, marker.y - y) < 46);
        return !outsideViewport && !intersectsControls && !overlapsMarker;
      };

      let markerX = candidate.x;
      let markerY = candidate.y;
      if (!centerIsAvailable(markerX, markerY)) {
        const codeSeed = [...candidate.airport.code]
          .reduce((sum, character) => sum + character.charCodeAt(0), 0);
        let placed = false;
        for (let ring = 0; ring < 4 && !placed; ring += 1) {
          const radius = 48 + ring * 22;
          const positions = 8 + ring * 4;
          for (let step = 0; step < positions; step += 1) {
            const angle = ((codeSeed * 47) % 360) * Math.PI / 180
              + (step / positions) * Math.PI * 2;
            const nextX = candidate.x + Math.cos(angle) * radius;
            const nextY = candidate.y + Math.sin(angle) * radius;
            if (!centerIsAvailable(nextX, nextY)) continue;
            markerX = nextX;
            markerY = nextY;
            placed = true;
            break;
          }
        }
        if (!placed) continue;
      }

      const leaderLength = Math.hypot(candidate.x - markerX, candidate.y - markerY);
      markers.push({
        ...candidate,
        x: markerX,
        y: markerY,
        showLabel: candidate.showLabel || leaderLength > 1,
        leaderLength,
        leaderAngle: Math.atan2(
          candidate.y - markerY,
          candidate.x - markerX,
        ) * 180 / Math.PI,
      });
    }

    context.restore();
    hitsRef.current = hits;
    setVisibleAirportMarkers(markers);
  }, [airports, airportTraffic, focusedAirportCode, hoveredRouteKey, modeledRouteDelays, recordedRouteDelays, routes, selectedAirportCode, selectedRouteKey, size, view]);

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

  function updateView(
    updater: (current: ViewTransform) => ViewTransform,
  ) {
    if ((document.activeElement as Element | null)?.closest(".airport-marker")) {
      canvasRef.current?.focus({ preventScroll: true });
    }
    updateHoveredRoute(null);
    commitView(clampView(updater(viewRef.current), size));
  }

  function zoomAt(x: number, y: number, requestedScale: number) {
    updateView((current) => {
      const nextScale = clamp(requestedScale, MIN_ZOOM, MAX_ZOOM);
      const ratio = nextScale / current.scale;
      return {
        scale: nextScale,
        x: x - (x - current.x) * ratio,
        y: y - (y - current.y) * ratio,
      };
    });
  }

  function panBy(x: number, y: number) {
    updateView((current) => ({
      ...current,
      x: current.x + x,
      y: current.y + y,
    }));
  }

  function pointerPosition(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function gestureSnapshot() {
    const points = [...activePointersRef.current.values()];
    const centerX = points.reduce((sum, point) => sum + point.x, 0) / Math.max(1, points.length);
    const centerY = points.reduce((sum, point) => sum + point.y, 0) / Math.max(1, points.length);
    const distance = points.length >= 2
      ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
      : 0;
    return { centerX, centerY, distance };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if ((event.target as Element | null)?.closest(".map-controls")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = pointerPosition(event);
    activePointersRef.current.set(event.pointerId, point);
    const snapshot = gestureSnapshot();
    gestureRef.current = {
      ...snapshot,
      movement: activePointersRef.current.size === 1
        ? 0
        : gestureRef.current.movement,
    };
    if (activePointersRef.current.size === 1) {
      suppressClickRef.current = false;
    }
    setIsDragging(true);
    updateHoveredRoute(null);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const { x, y } = pointerPosition(event);
    if (activePointersRef.current.has(event.pointerId)) {
      activePointersRef.current.set(event.pointerId, { x, y });
      const snapshot = gestureSnapshot();
      const previous = gestureRef.current;
      const movement = Math.hypot(
        snapshot.centerX - previous.centerX,
        snapshot.centerY - previous.centerY,
      ) + Math.abs(snapshot.distance - previous.distance);

      if (
        activePointersRef.current.size >= 2
        && previous.distance > 0
        && snapshot.distance > 0
      ) {
        updateView((current) => {
          const nextScale = clamp(
            current.scale * (snapshot.distance / previous.distance),
            MIN_ZOOM,
            MAX_ZOOM,
          );
          const baseX = (previous.centerX - current.x) / current.scale;
          const baseY = (previous.centerY - current.y) / current.scale;
          return {
            scale: nextScale,
            x: snapshot.centerX - baseX * nextScale,
            y: snapshot.centerY - baseY * nextScale,
          };
        });
      } else {
        panBy(
          snapshot.centerX - previous.centerX,
          snapshot.centerY - previous.centerY,
        );
      }

      gestureRef.current = {
        ...snapshot,
        movement: previous.movement + movement,
      };
      if (gestureRef.current.movement > 4) {
        suppressClickRef.current = true;
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }
      updateHoveredRoute(null);
      return;
    }

    setPointer((current) => current.x === x && current.y === y ? current : { x, y });
    const overOverlay = (event.target as Element | null)?.closest(".airport-marker, .map-controls");
    updateHoveredRoute(overOverlay ? null : locateRoute(x, y)?.route.key ?? null);
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    activePointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (activePointersRef.current.size === 0) {
      setIsDragging(false);
      if (suppressClickRef.current) {
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      return;
    }
    const snapshot = gestureSnapshot();
    gestureRef.current = {
      ...snapshot,
      movement: gestureRef.current.movement,
    };
  }

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    if ((event.target as Element | null)?.closest(".map-controls, .airport-marker")) {
      return;
    }
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = locateRoute(x, y);
    updateHoveredRoute(hit?.route.key ?? null);
    if (hit) onSelectRoute(hit.route);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLCanvasElement>) {
    if (["+", "=", "-", "_", "0"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "0") {
        updateView(() => ({ scale: MIN_ZOOM, x: 0, y: 0 }));
      } else {
        zoomAt(
          size.width / 2,
          size.height / 2,
          viewRef.current.scale * (event.key === "+" || event.key === "=" ? 1.35 : 1 / 1.35),
        );
      }
      return;
    }
    if (event.shiftKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const distance = 72;
      panBy(
        event.key === "ArrowLeft" ? distance : event.key === "ArrowRight" ? -distance : 0,
        event.key === "ArrowUp" ? distance : event.key === "ArrowDown" ? -distance : 0,
      );
      return;
    }
    if (selectionMode === "airport") return;
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
    <div
      className={`network-map${isDragging ? " is-dragging" : ""}`}
      ref={shellRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerLeave={() => {
        if (activePointersRef.current.size === 0) updateHoveredRoute(null);
      }}
      onClick={handleClick}
    >
      <canvas
        id={mapCanvasId}
        ref={canvasRef}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        aria-label={selectionMode === "airport"
          ? "Interactive airline map. Scroll, pinch, or use the controls to zoom. Drag or use Shift plus arrow keys to pan, then choose a revealed airport marker for the ground stop."
          : "Interactive airline route map. Scroll, pinch, or use the controls to zoom; drag or use Shift plus arrow keys to pan; then choose a route. Use the arrow keys and Enter to select routes."}
        aria-describedby={routeStatusId}
      />
      <div className="airport-marker-layer">
        {visibleAirportMarkers.map((marker) => {
          const markerClass = [
            "airport-marker",
            marker.showLabel ? "show-label" : "",
            marker.delaySeverity !== "none" ? `delay-${marker.delaySeverity}` : "",
            marker.selected ? "selected" : "",
            marker.leaderLength > 1 ? "displaced" : "",
            selectionMode === "airport" ? "selectable" : "",
          ].filter(Boolean).join(" ");
          const markerStyle = {
            left: marker.x,
            top: marker.y,
            "--airport-size": `${marker.size}px`,
            "--leader-length": `${marker.leaderLength}px`,
            "--leader-angle": `${marker.leaderAngle}deg`,
          } as CSSProperties;
          const delayDetail = marker.delaySeverity === "none"
            ? ""
            : `, maximum displayed route delay ${Math.round(marker.delayMinutes)} minutes`;
          const detail = `${marker.airport.code} — ${marker.airport.name}, ${marker.traffic} scheduled carrier-day movements${delayDetail}`;

          return selectionMode === "airport" ? (
            <button
              type="button"
              key={marker.airport.code}
              className={markerClass}
              style={markerStyle}
              aria-label={`${detail}. Select for ground stop.`}
              aria-pressed={marker.selected}
              onFocus={() => setFocusedAirportCode(marker.airport.code)}
              onBlur={() => setFocusedAirportCode((current) =>
                current === marker.airport.code ? null : current)}
              onClick={(event) => {
                event.stopPropagation();
                if (suppressClickRef.current) return;
                onSelectAirport(marker.airport);
              }}
            >
              <span className="airport-dot" aria-hidden="true" />
              <span className="airport-code" aria-hidden="true">{marker.airport.code}</span>
              <span className="airport-hover-card" aria-hidden="true">
                <strong>{marker.airport.code} · {marker.airport.city || marker.airport.name}</strong>
                <small>{pluralFlights(marker.traffic)} · select ground stop</small>
              </span>
            </button>
          ) : (
            <span
              key={marker.airport.code}
              className={markerClass}
              style={markerStyle}
              aria-hidden="true"
            >
              <span className="airport-dot" />
              <span className="airport-code">{marker.airport.code}</span>
            </span>
          );
        })}
      </div>
      <div className="map-controls" role="group" aria-label="Map zoom controls">
        <div className="map-zoom-row">
          <button
            type="button"
            aria-label="Zoom out"
            aria-controls={mapCanvasId}
            disabled={view.scale <= MIN_ZOOM + 0.01}
            onClick={() => zoomAt(size.width / 2, size.height / 2, view.scale / 1.45)}
          >−</button>
          <button
            type="button"
            className="map-zoom-reset"
            aria-label={`Reset map zoom, currently ${Math.round(view.scale * 100)} percent`}
            aria-controls={mapCanvasId}
            disabled={view.scale <= MIN_ZOOM + 0.01}
            onClick={() => updateView(() => ({ scale: MIN_ZOOM, x: 0, y: 0 }))}
          >{Math.round(view.scale * 100)}%</button>
          <button
            type="button"
            aria-label="Zoom in"
            aria-controls={mapCanvasId}
            disabled={view.scale >= MAX_ZOOM - 0.01}
            onClick={() => zoomAt(size.width / 2, size.height / 2, view.scale * 1.45)}
          >+</button>
        </div>
      </div>
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
        {selectionMode === "airport"
          ? "Zoom until the airport you need appears. Use Tab to reach a revealed airport and Enter to select it for the ground stop."
          : hoveredRoute
          ? `Current route: ${hoveredRoute.origin} to ${hoveredRoute.destination}, ${hoveredRoute.flights} scheduled ${hoveredRoute.flights === 1 ? "flight" : "flights"}. Press Enter to select.`
          : "No route highlighted. Use the left and right arrow keys to explore routes."}
      </div>
      <div className="map-scale-note">Scroll or pinch to zoom · drag or use Shift + arrows to pan · smaller airports appear closer in</div>
    </div>
  );
}
