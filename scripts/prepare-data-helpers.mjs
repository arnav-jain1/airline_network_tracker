import { basename } from "node:path";

export function createFieldIndexes(
  headers,
  requiredFields,
  optionalFields = [],
  sourceName = "CSV source",
) {
  const indexes = {};
  for (const field of requiredFields) {
    const index = headers.indexOf(field);
    if (index === -1) {
      throw new Error(`${basename(sourceName)} is missing required field ${field}`);
    }
    indexes[field] = index;
  }
  for (const field of optionalFields) {
    const index = headers.indexOf(field);
    if (index !== -1) indexes[field] = index;
  }
  return indexes;
}

export function compareSourcePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createStableFlightId(date, sourceRowNumber) {
  return `f${date.replaceAll("-", "")}-${sourceRowNumber.toString(36)}`;
}

export function claimServiceDate(sourceFileByDate, date, sourceFile) {
  const existingSourceFile = sourceFileByDate.get(date);
  if (existingSourceFile && existingSourceFile !== sourceFile) {
    throw new Error(
      `Overlapping service date ${date} appears in both ${basename(existingSourceFile)} and ${basename(sourceFile)}`,
    );
  }
  sourceFileByDate.set(date, sourceFile);
}

export function summarizeDatasetPeriod(sortedDates) {
  const yearMonths = new Set(sortedDates.map((date) => date.slice(0, 7)));
  const onlyYearMonth = yearMonths.size === 1 ? [...yearMonths][0] : null;

  return {
    year: onlyYearMonth ? Number(onlyYearMonth.slice(0, 4)) : null,
    month: onlyYearMonth ? Number(onlyYearMonth.slice(5, 7)) : null,
    startDate: sortedDates[0] ?? null,
    endDate: sortedDates.at(-1) ?? null,
  };
}
