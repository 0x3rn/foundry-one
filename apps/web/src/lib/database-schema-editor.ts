export interface SchemaReference {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
}

const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function parseSchemaReference(value: string): SchemaReference | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;

  const parts = normalized.split(".").map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => !SIMPLE_IDENTIFIER.test(part))) {
    throw new Error("References must use the schema.table.column format.");
  }

  const [schema, table, column] = parts;
  return { schema, table, column };
}
