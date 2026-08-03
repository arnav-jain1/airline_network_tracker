import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  claimServiceDate,
  compareSourcePaths,
  createStableFlightId,
  summarizeDatasetPeriod,
} from "./prepare-data-helpers.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const workDir = join(projectRoot, "work");
const outputDir = join(projectRoot, "public", "data");
const airportIdFile = join(workDir, "L_AIRPORT_ID.csv");
const airportCodeFile = join(workDir, "L_AIRPORT.csv");
const airportMetadataFile = join(workDir, "airports.csv");

// The supplied L_AIRPORT_ID file has a blank Description for this active 2026
// DOT airport ID. The route/distance records and both other lookup files identify
// it as Williston Basin International (XWA).
const AIRPORT_ID_OVERRIDES = new Map([[16869, "XWA"]]);

const SOURCE_FIELDS = [
  "YEAR",
  "MONTH",
  "DAY_OF_MONTH",
  "FL_DATE",
  "OP_UNIQUE_CARRIER",
  "OP_CARRIER",
  "TAIL_NUM",
  "OP_CARRIER_FL_NUM",
  "ORIGIN_AIRPORT_ID",
  "DEST_AIRPORT_ID",
  "CRS_DEP_TIME",
  "DEP_TIME",
  "CRS_ARR_TIME",
  "CANCELLED",
  "DIVERTED",
  "CRS_ELAPSED_TIME",
  "DISTANCE",
];

const FLIGHT_FIELDS = [
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

/**
 * Parse one logical CSV record. The BTS lookup values contain quoted commas and
 * escaped double quotes, so String#split(',') is not sufficient.
 *
 * These source files do not contain quoted physical newlines; records are read
 * one line at a time to keep memory bounded.
 */
function parseCsvRecord(line, lineNumber, filePath) {
  const values = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === "," && !inQuotes) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }

  if (inQuotes) {
    throw new Error(
      `Unclosed quoted CSV field in ${basename(filePath)} at line ${lineNumber}`,
    );
  }

  values.push(value);
  return values;
}

async function forEachCsvRow(filePath, requiredFields, onRow) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let headers = null;
  let fieldIndexes = null;
  let lineNumber = 0;
  let dataRowNumber = 0;

  for await (const rawLine of lines) {
    lineNumber += 1;
    if (rawLine.length === 0) continue;

    const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    const values = parseCsvRecord(line, lineNumber, filePath);

    if (headers === null) {
      headers = values.map((header) => header.trim());
      fieldIndexes = Object.fromEntries(
        requiredFields.map((field) => {
          const index = headers.indexOf(field);
          if (index === -1) {
            throw new Error(`${basename(filePath)} is missing required field ${field}`);
          }
          return [field, index];
        }),
      );
      continue;
    }

    if (values.length !== headers.length) {
      throw new Error(
        `${basename(filePath)} line ${lineNumber} has ${values.length} fields; expected ${headers.length}`,
      );
    }

    dataRowNumber += 1;
    await onRow(values, fieldIndexes, dataRowNumber);
  }

  if (headers === null) {
    throw new Error(`${basename(filePath)} is empty`);
  }

  return dataRowNumber;
}

function nullableString(value) {
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function finiteNumber(value) {
  const normalized = value.trim();
  if (normalized === "") return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function finiteInteger(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.trunc(number);
}

function flag(value) {
  return finiteNumber(value) === 1;
}

function roundRate(numerator, denominator) {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

function parseDate(values, indexes) {
  const year = finiteInteger(values[indexes.YEAR]);
  const month = finiteInteger(values[indexes.MONTH]);
  const day = finiteInteger(values[indexes.DAY_OF_MONTH]);

  if (year !== null && month !== null && day !== null) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const sourceDate = values[indexes.FL_DATE].trim();
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(sourceDate);
  if (!match) return null;
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function parseHhmm(value) {
  const normalized = value.trim();
  if (normalized === "") return { value: null, invalid: false, used2400: false };

  const numeric = Number(normalized);
  if (!Number.isInteger(numeric) || numeric < 0) {
    return { value: null, invalid: true, used2400: false };
  }

  const hours = Math.floor(numeric / 100);
  const minutes = numeric % 100;
  if (hours === 24 && minutes === 0) {
    return { value: 1440, invalid: false, used2400: true };
  }
  if (hours > 23 || minutes > 59) {
    return { value: null, invalid: true, used2400: false };
  }

  return { value: hours * 60 + minutes, invalid: false, used2400: false };
}

function positiveClockDelay(scheduledDeparture, actualDeparture) {
  if (scheduledDeparture === null || actualDeparture === null) return null;

  let difference = actualDeparture - scheduledDeparture;
  if (difference < -720) difference += 1440;
  if (difference > 720) difference -= 1440;
  return Math.max(0, difference);
}

function descriptionParts(description) {
  const colon = description.indexOf(":");
  const place = (colon === -1 ? description : description.slice(0, colon)).trim();
  const name = (colon === -1 ? description : description.slice(colon + 1)).trim();
  const comma = place.lastIndexOf(",");

  return {
    city: (comma === -1 ? place : place.slice(0, comma)).trim() || null,
    state: (comma === -1 ? "" : place.slice(comma + 1)).trim() || null,
    name: name || place || null,
  };
}

function normalizedText(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function locationKey(description) {
  const { city, state } = descriptionParts(description);
  return normalizedText(`${city ?? ""}|${state ?? ""}`);
}

const GENERIC_AIRPORT_WORDS = new Set([
  "airport",
  "airports",
  "at",
  "county",
  "field",
  "international",
  "municipal",
  "of",
  "regional",
  "the",
]);

function airportNameTokens(description) {
  const { name } = descriptionParts(description);
  return new Set(
    normalizedText(name ?? "")
      .split(" ")
      .filter((token) => token.length > 1 && !GENERIC_AIRPORT_WORDS.has(token)),
  );
}

function metadataRank(airport) {
  const scheduled = airport.scheduledService === "yes" ? 100 : 0;
  const country = airport.country === "US" ? 20 : 0;
  const typeRanks = {
    large_airport: 5,
    medium_airport: 4,
    small_airport: 3,
    seaplane_base: 2,
    heliport: 1,
  };
  return scheduled + country + (typeRanks[airport.type] ?? 0);
}

async function loadAirportLookups() {
  const descriptionsById = new Map();
  const codesByDescription = new Map();
  const candidatesByLocation = new Map();
  const candidatesByName = new Map();
  const metadataByCode = new Map();

  await forEachCsvRow(airportIdFile, ["Code", "Description"], (values, indexes) => {
    const id = finiteInteger(values[indexes.Code]);
    const description = values[indexes.Description].trim();
    if (id !== null && description !== "") descriptionsById.set(id, description);
  });

  await forEachCsvRow(airportCodeFile, ["Code", "Description"], (values, indexes) => {
    const code = values[indexes.Code].trim().toUpperCase();
    const description = values[indexes.Description].trim();
    if (!/^[A-Z0-9]{3}$/.test(code) || description === "") return;
    const normalizedDescription = normalizedText(description);
    const existing = codesByDescription.get(normalizedDescription) ?? [];
    existing.push(code);
    codesByDescription.set(normalizedDescription, existing);

    const location = locationKey(description);
    const locationCandidates = candidatesByLocation.get(location) ?? [];
    locationCandidates.push({ code, description });
    candidatesByLocation.set(location, locationCandidates);

    const name = normalizedText(descriptionParts(description).name ?? "");
    const nameCandidates = candidatesByName.get(name) ?? [];
    nameCandidates.push({ code, description });
    candidatesByName.set(name, nameCandidates);
  });

  const metadataFields = [
    "type",
    "name",
    "latitude_deg",
    "longitude_deg",
    "iso_country",
    "iso_region",
    "municipality",
    "scheduled_service",
    "iata_code",
    "gps_code",
    "local_code",
  ];

  await forEachCsvRow(airportMetadataFile, metadataFields, (values, indexes) => {
    const iataCode = values[indexes.iata_code].trim().toUpperCase();
    const gpsCode = values[indexes.gps_code].trim().toUpperCase();
    const localCode = values[indexes.local_code].trim().toUpperCase();
    const candidateCodes = [...new Set([
      iataCode,
      localCode,
      /^[A-Z0-9]{3}$/.test(gpsCode) ? gpsCode : "",
      /^K[A-Z0-9]{3}$/.test(gpsCode) ? gpsCode.slice(1) : "",
    ].filter((code) => /^[A-Z0-9]{3}$/.test(code)))];
    if (candidateCodes.length === 0) return;

    const latitude = finiteNumber(values[indexes.latitude_deg]);
    const longitude = finiteNumber(values[indexes.longitude_deg]);
    const region = nullableString(values[indexes.iso_region]);
    for (const code of candidateCodes) {
      const candidate = {
        code,
        name: nullableString(values[indexes.name]),
        city: nullableString(values[indexes.municipality]),
        state: region?.startsWith("US-") ? region.slice(3) : null,
        latitude,
        longitude,
        country: nullableString(values[indexes.iso_country]),
        type: nullableString(values[indexes.type]),
        scheduledService: nullableString(values[indexes.scheduled_service]),
      };

      const existing = metadataByCode.get(code);
      if (!existing || metadataRank(candidate) > metadataRank(existing)) {
        metadataByCode.set(code, candidate);
      }
    }
  });

  const resolvedById = new Map();
  let ambiguousDescriptionCount = 0;
  let locationFallbackCount = 0;
  let nameFallbackCount = 0;
  let overrideCount = 0;

  function chooseCode(candidates, sourceDescription) {
    const sourceTokens = airportNameTokens(sourceDescription);
    const uniqueCandidates = new Map();
    for (const candidate of candidates) uniqueCandidates.set(candidate.code, candidate);

    return (
      [...uniqueCandidates.values()]
        .map((candidate) => {
          const candidateTokens = airportNameTokens(candidate.description);
          const sharedTokens = [...sourceTokens].filter((token) => candidateTokens.has(token)).length;
          const metadata = metadataByCode.get(candidate.code);
          return {
            code: candidate.code,
            // Name overlap dominates; current scheduled-service metadata breaks ties.
            score: sharedTokens * 1_000 + (metadata ? metadataRank(metadata) : 0),
          };
        })
        .sort((left, right) => right.score - left.score || left.code.localeCompare(right.code))[0]
        ?.code ?? null
    );
  }

  for (const [id, description] of descriptionsById) {
    const exactCodes = [...new Set(codesByDescription.get(normalizedText(description)) ?? [])].sort();
    if (exactCodes.length > 1) ambiguousDescriptionCount += 1;

    const override = AIRPORT_ID_OVERRIDES.get(id) ?? null;
    const exactCandidates = exactCodes.map((code) => ({ code, description }));
    let code = override ?? chooseCode(exactCandidates, description);
    let resolutionMethod = override ? "override" : code ? "exact-description" : null;

    if (override) overrideCount += 1;
    if (!code && description !== "") {
      const locationCandidates = candidatesByLocation.get(locationKey(description)) ?? [];
      code = chooseCode(locationCandidates, description);
      if (code) {
        resolutionMethod = "location-name-fallback";
        locationFallbackCount += 1;
      }
    }
    if (!code && description !== "") {
      const name = normalizedText(descriptionParts(description).name ?? "");
      const nameCandidates = candidatesByName.get(name) ?? [];
      code = chooseCode(nameCandidates, description);
      if (code) {
        resolutionMethod = "airport-name-fallback";
        nameFallbackCount += 1;
      }
    }

    const parts = descriptionParts(description);
    resolvedById.set(id, { id, code, description, resolutionMethod, ...parts });
  }

  // Overrides can repair a lookup row whose supplied description is blank.
  for (const [id, code] of AIRPORT_ID_OVERRIDES) {
    const current = resolvedById.get(id);
    if (current?.code) continue;
    const metadata = metadataByCode.get(code);
    resolvedById.set(id, {
      id,
      code,
      description: "",
      resolutionMethod: "override",
      name: metadata?.name ?? null,
      city: metadata?.city ?? null,
      state: metadata?.state ?? null,
    });
    overrideCount += 1;
  }

  return {
    descriptionsById,
    metadataByCode,
    resolvedById,
    ambiguousDescriptionCount,
    locationFallbackCount,
    nameFallbackCount,
    overrideCount,
  };
}

function countRoutes(flights) {
  return new Set(flights.map((flight) => `${flight.origin}-${flight.destination}`)).size;
}

function addRotationLinks(flights, diagnostics) {
  const flightsByTail = new Map();

  for (const flight of flights) {
    if (flight.tail === null) continue;
    const rotation = flightsByTail.get(flight.tail) ?? [];
    rotation.push(flight);
    flightsByTail.set(flight.tail, rotation);
  }

  for (const rotation of flightsByTail.values()) {
    rotation.sort((left, right) => {
      const departureDifference = left.scheduledDeparture - right.scheduledDeparture;
      return departureDifference || left.id.localeCompare(right.id);
    });

    for (let index = 0; index < rotation.length - 1; index += 1) {
      const current = rotation[index];
      const next = rotation[index + 1];
      diagnostics.rotationCandidatePairCount += 1;

      const hasAirportContinuity = current.destination === next.origin;

      if (hasAirportContinuity) {
        current.nextFlightId = next.id;
        diagnostics.rotationLinkCount += 1;
      } else {
        diagnostics.rotationAirportDiscontinuityCount += 1;
      }
    }
  }
}

async function readNdjson(filePath, onRecord) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;

  for await (const line of lines) {
    lineNumber += 1;
    if (line === "") continue;
    try {
      onRecord(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid temporary record in ${basename(filePath)} line ${lineNumber}: ${error.message}`);
    }
  }
}

async function endStreams(streams) {
  await Promise.all(
    [...streams.values()].map(
      (stream) =>
        new Promise((resolvePromise, rejectPromise) => {
          stream.once("error", rejectPromise);
          stream.end(resolvePromise);
        }),
    ),
  );
}

async function main() {
  await mkdir(workDir, { recursive: true });
  const sourceFiles = (await readdir(workDir, { withFileTypes: true }))
    .filter((entry) =>
      entry.isFile() && /^T_ONTIME_REPORTING.*\.csv$/i.test(entry.name))
    .map((entry) => join(workDir, entry.name))
    .sort(compareSourcePaths);
  if (sourceFiles.length === 0) {
    throw new Error(`No T_ONTIME_REPORTING*.csv files found in ${workDir}`);
  }

  for (const inputFile of [
    ...sourceFiles,
    airportIdFile,
    airportCodeFile,
    airportMetadataFile,
  ]) {
    await stat(inputFile);
  }

  if (dirname(outputDir) !== join(projectRoot, "public")) {
    throw new Error(`Refusing to replace unexpected output directory: ${outputDir}`);
  }

  const lookups = await loadAirportLookups();
  const generatedAt = new Date().toISOString();
  const diagnostics = {
    sourceRows: 0,
    includedFlights: 0,
    skippedInvalidDate: 0,
    skippedMissingCarrier: 0,
    skippedMissingScheduledFields: 0,
    skippedUnresolvedAirport: 0,
    invalidHhmmValueCount: 0,
    hhmm2400ValueCount: 0,
    missingTailCount: 0,
    airportEndpointCount: 0,
    airportCodeMatchedEndpointCount: 0,
    coordinateMatchedEndpointCount: 0,
    rotationCandidatePairCount: 0,
    rotationLinkCount: 0,
    rotationAirportDiscontinuityCount: 0,
  };
  const unresolvedAirportIds = new Map();
  const usedAirports = new Map();
  const dateStreams = new Map();
  const dateTempFiles = new Map();
  const dates = new Set();
  const sourceFileByDate = new Map();

  const temporaryDir = await mkdtemp(join(workDir, ".prepare-data-"));

  try {
    for (const sourceFile of sourceFiles) {
      await forEachCsvRow(sourceFile, SOURCE_FIELDS, async (values, indexes, sourceRowNumber) => {
        diagnostics.sourceRows += 1;
        const date = parseDate(values, indexes);
        if (date === null) {
          diagnostics.skippedInvalidDate += 1;
          return;
        }

        claimServiceDate(sourceFileByDate, date, sourceFile);

        const carrier =
          nullableString(values[indexes.OP_UNIQUE_CARRIER]) ?? nullableString(values[indexes.OP_CARRIER]);
        if (carrier === null) {
          diagnostics.skippedMissingCarrier += 1;
          return;
        }

        const scheduledDepartureResult = parseHhmm(values[indexes.CRS_DEP_TIME]);
        const actualDepartureResult = parseHhmm(values[indexes.DEP_TIME]);
        const scheduledArrivalResult = parseHhmm(values[indexes.CRS_ARR_TIME]);
        for (const result of [
          scheduledDepartureResult,
          actualDepartureResult,
          scheduledArrivalResult,
        ]) {
          if (result.invalid) diagnostics.invalidHhmmValueCount += 1;
          if (result.used2400) diagnostics.hhmm2400ValueCount += 1;
        }

        const scheduledElapsed = finiteNumber(values[indexes.CRS_ELAPSED_TIME]);
        if (
          scheduledDepartureResult.value === null ||
          scheduledArrivalResult.value === null ||
          scheduledElapsed === null
        ) {
          diagnostics.skippedMissingScheduledFields += 1;
          return;
        }

        const originId = finiteInteger(values[indexes.ORIGIN_AIRPORT_ID]);
        const destinationId = finiteInteger(values[indexes.DEST_AIRPORT_ID]);
        diagnostics.airportEndpointCount += 2;
        const originLookup = originId === null ? null : lookups.resolvedById.get(originId) ?? null;
        const destinationLookup =
          destinationId === null ? null : lookups.resolvedById.get(destinationId) ?? null;

        for (const [id, lookup] of [
          [originId, originLookup],
          [destinationId, destinationLookup],
        ]) {
          if (lookup?.code) {
            diagnostics.airportCodeMatchedEndpointCount += 1;
            const metadata = lookups.metadataByCode.get(lookup.code);
            if (
              typeof metadata?.latitude === "number" &&
              Number.isFinite(metadata.latitude) &&
              typeof metadata.longitude === "number" &&
              Number.isFinite(metadata.longitude)
            ) {
              diagnostics.coordinateMatchedEndpointCount += 1;
            }
          } else {
            const key = id === null ? "missing" : String(id);
            unresolvedAirportIds.set(key, (unresolvedAirportIds.get(key) ?? 0) + 1);
          }
        }

        if (!originLookup?.code || !destinationLookup?.code) {
          diagnostics.skippedUnresolvedAirport += 1;
          return;
        }

        for (const airport of [originLookup, destinationLookup]) {
          if (!usedAirports.has(airport.code)) {
            const metadata = lookups.metadataByCode.get(airport.code);
            usedAirports.set(airport.code, {
              code: airport.code,
              id: airport.id,
              name: airport.name ?? metadata?.name ?? null,
              city: airport.city ?? metadata?.city ?? null,
              state: airport.state ?? metadata?.state ?? null,
              latitude: metadata?.latitude ?? null,
              longitude: metadata?.longitude ?? null,
            });
          }
        }

        const flight = {
          // The date makes IDs unique across non-overlapping exports, while the
          // file-local row keeps an existing month stable when another is added.
          id: createStableFlightId(date, sourceRowNumber),
          carrier,
          flightNumber: nullableString(values[indexes.OP_CARRIER_FL_NUM]),
          tail: nullableString(values[indexes.TAIL_NUM]),
          origin: originLookup.code,
          destination: destinationLookup.code,
          originId,
          destinationId,
          scheduledDeparture: scheduledDepartureResult.value,
          scheduledArrival: scheduledArrivalResult.value,
          scheduledElapsed,
          distance: finiteNumber(values[indexes.DISTANCE]),
          cancelled: flag(values[indexes.CANCELLED]),
          diverted: flag(values[indexes.DIVERTED]),
          actualDepartureDelay: positiveClockDelay(
            scheduledDepartureResult.value,
            actualDepartureResult.value,
          ),
          nextFlightId: null,
        };

        if (flight.tail === null) diagnostics.missingTailCount += 1;
        diagnostics.includedFlights += 1;
        dates.add(date);

        let stream = dateStreams.get(date);
        if (!stream) {
          const tempFile = join(temporaryDir, `${date}.ndjson`);
          stream = createWriteStream(tempFile, { encoding: "utf8" });
          dateStreams.set(date, stream);
          dateTempFiles.set(date, tempFile);
        }

        if (!stream.write(`${JSON.stringify(flight)}\n`)) {
          await once(stream, "drain");
        }
      });
    }

    await endStreams(dateStreams);

    await rm(outputDir, { recursive: true, force: true });
    await mkdir(join(outputDir, "days"), { recursive: true });

    const sortedDates = [...dates].sort();
    const carriers = new Set();
    const availability = {};
    const chunks = [];
    let totalRouteCount = 0;

    for (const date of sortedDates) {
      const flightsByCarrier = new Map();
      await readNdjson(dateTempFiles.get(date), (flight) => {
        const carrierFlights = flightsByCarrier.get(flight.carrier) ?? [];
        carrierFlights.push(flight);
        flightsByCarrier.set(flight.carrier, carrierFlights);
      });

      const dateCarriers = [...flightsByCarrier.keys()].sort();
      availability[date] = dateCarriers;
      await mkdir(join(outputDir, "days", date), { recursive: true });

      for (const carrier of dateCarriers) {
        const flights = flightsByCarrier.get(carrier);
        carriers.add(carrier);
        addRotationLinks(flights, diagnostics);
        const routeCount = countRoutes(flights);
        const relativePath = `/data/days/${date}/${carrier}.json`;
        const compactFlights = flights.map((flight) =>
          FLIGHT_FIELDS.map((field) => flight[field]),
        );
        const chunk = { date, carrier, flightFields: FLIGHT_FIELDS, flights: compactFlights };
        await writeFile(
          join(outputDir, "days", date, `${carrier}.json`),
          JSON.stringify(chunk),
          "utf8",
        );
        chunks.push({
          date,
          carrier,
          path: relativePath,
          flightCount: flights.length,
          routeCount,
        });
        totalRouteCount += routeCount;
      }
    }

    const airports = [...usedAirports.values()].sort((left, right) =>
      left.code.localeCompare(right.code),
    );
    await writeFile(
      join(outputDir, "airports.json"),
      JSON.stringify({ airports }),
      "utf8",
    );

    const datasetPeriod = summarizeDatasetPeriod(sortedDates);
    const manifest = {
      schemaVersion: 1,
      generatedAt,
      dataset: {
        sourceFile: sourceFiles.length === 1 ? basename(sourceFiles[0]) : null,
        sourceFiles: sourceFiles.map((filePath) => basename(filePath)),
        ...datasetPeriod,
      },
      dates: sortedDates,
      carriers: [...carriers].sort(),
      availability,
      chunks,
      totals: {
        flights: diagnostics.includedFlights,
        routes: totalRouteCount,
        airports: airports.length,
      },
      metadata: {
        airportCodeMatchRate: roundRate(
          diagnostics.airportCodeMatchedEndpointCount,
          diagnostics.airportEndpointCount,
        ),
        coordinateMatchRate: roundRate(
          diagnostics.coordinateMatchedEndpointCount,
          diagnostics.airportCodeMatchedEndpointCount,
        ),
        rotationLinkCount: diagnostics.rotationLinkCount,
      },
    };

    await writeFile(join(outputDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    await writeFile(
      join(outputDir, "diagnostics.json"),
      JSON.stringify(
        {
          ...diagnostics,
          airportDescriptionCount: lookups.descriptionsById.size,
          ambiguousAirportDescriptionCount: lookups.ambiguousDescriptionCount,
          locationNameFallbackAirportCount: lookups.locationFallbackCount,
          airportNameFallbackAirportCount: lookups.nameFallbackCount,
          airportIdOverrideCount: lookups.overrideCount,
          unresolvedAirportIds: Object.fromEntries(
            [...unresolvedAirportIds.entries()].sort((left, right) => right[1] - left[1]),
          ),
        },
        null,
        2,
      ),
      "utf8",
    );

    const outputStats = await Promise.all(
      ["manifest.json", "airports.json", "diagnostics.json"].map(async (fileName) => ({
        fileName,
        bytes: (await stat(join(outputDir, fileName))).size,
      })),
    );
    const chunkBytes = (
      await Promise.all(
        chunks.map(async (chunk) =>
          (await stat(join(projectRoot, "public", chunk.path.replace(/^\//, "")))).size,
        ),
      )
    ).reduce((sum, bytes) => sum + bytes, 0);

    console.log(
      JSON.stringify(
        {
          outputDir,
          dates: sortedDates.length,
          carriers: carriers.size,
          chunks: chunks.length,
          totals: manifest.totals,
          metadata: manifest.metadata,
          outputBytes: chunkBytes + outputStats.reduce((sum, item) => sum + item.bytes, 0),
          diagnostics,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const stream of dateStreams.values()) {
      if (!stream.closed && !stream.destroyed) stream.destroy();
    }
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

await main();
