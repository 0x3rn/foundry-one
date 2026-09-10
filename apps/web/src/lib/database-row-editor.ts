import type { ProviderRecord, ProviderScalar } from "@foundry/providers-core";

export interface RowEditorColumn {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly defaultValue?: string;
  readonly isIdentity: boolean;
}

export type RowEditorInput = Readonly<Record<string, string>>;

export function prepareRowInputValues(
  columns: readonly RowEditorColumn[],
  input: RowEditorInput,
): ProviderRecord {
  const values: Record<string, ProviderScalar> = {};
  for (const column of columns) {
    const value = parseInputValue(column, input[column.name] ?? "");
    if (value !== undefined) values[column.name] = value;
  }
  if (Object.keys(values).length === 0) {
    throw new Error("Enter at least one row value before saving.");
  }
  return values;
}

export function duplicateRowValues(
  columns: readonly RowEditorColumn[],
  row: Readonly<Record<string, ProviderScalar | ProviderScalar[]>>,
): ProviderRecord {
  const values: Record<string, ProviderScalar | ProviderScalar[]> = {};
  for (const column of columns) {
    if (
      !column.isIdentity &&
      column.defaultValue === undefined &&
      Object.hasOwn(row, column.name)
    ) {
      values[column.name] = row[column.name] as ProviderScalar | ProviderScalar[];
    }
  }
  if (Object.keys(values).length === 0) {
    throw new Error("This row has no duplicable values.");
  }
  return values;
}

function parseInputValue(column: RowEditorColumn, rawValue: string): ProviderScalar | undefined {
  if (column.isIdentity) return undefined;
  const value = rawValue.trim();
  if (!value) {
    if (column.defaultValue !== undefined) return undefined;
    if (column.nullable) return null;
    throw new Error(`${column.name} is required.`);
  }

  if (column.dataType.includes("boolean")) {
    if (value !== "true" && value !== "false") {
      throw new Error(`${column.name} must be true or false.`);
    }
    return value === "true";
  }

  if (
    column.dataType.includes("int") ||
    column.dataType.includes("numeric") ||
    column.dataType.includes("decimal") ||
    column.dataType.includes("real") ||
    column.dataType.includes("double")
  ) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${column.name} must be a number.`);
    return parsed;
  }

  return value;
}
