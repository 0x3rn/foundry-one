import type { ProviderRecord, ProviderScalar } from "@foundry/providers-core";

export type TransferValue = ProviderScalar | string[];
export type TransferRecord = Readonly<Record<string, TransferValue>>;

export function encodeCsv(headers: readonly string[], rows: readonly TransferRecord[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }
  return lines.join("\n");
}

export function parseTransferFile(
  content: string,
  format: "csv" | "json",
): readonly TransferRecord[] {
  if (!content.trim()) throw new Error("The import file is empty.");
  if (format === "json") return parseJson(content);
  return parseCsv(content);
}

function parseJson(content: string): readonly TransferRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("The JSON import is not valid JSON.");
  }
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error("JSON imports must be an array of row objects.");
  }
  return value.map((item) => normalizeRecord(item as Record<string, unknown>));
}

function parseCsv(content: string): readonly TransferRecord[] {
  const rows = parseCsvRows(content);
  const headers = rows.shift();
  if (!headers || headers.length === 0 || headers.some((header) => !header.trim())) {
    throw new Error("CSV imports need a header row with non-empty column names.");
  }
  if (new Set(headers).size !== headers.length) throw new Error("CSV headers must be unique.");
  return rows
    .filter((row) => row.some((value) => value.length > 0))
    .map((row) => {
      if (row.length !== headers.length)
        throw new Error("Every CSV row must match the header width.");
      return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null]));
    });
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("CSV imports cannot end inside a quoted cell.");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function normalizeRecord(value: Record<string, unknown>): TransferRecord {
  const record: Record<string, TransferValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim() || !isTransferValue(item))
      throw new Error("Import rows contain an unsupported value.");
    record[key] = item;
  }
  if (Object.keys(record).length === 0) throw new Error("Import rows cannot be empty.");
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTransferValue(value: unknown): value is TransferValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function csvCell(value: ProviderScalar | string[] | undefined): string {
  const text =
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join(", ")
        : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function asProviderRecord(value: TransferRecord): ProviderRecord {
  return value;
}
