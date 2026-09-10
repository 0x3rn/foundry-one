export interface SchemaReference {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
}

export interface SchemaColumnDraft {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly isPrimaryKey?: boolean;
  readonly isUnique?: boolean;
  readonly defaultValue?: string;
  readonly reference?: string;
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

export function prepareSchemaColumnDraft(draft: SchemaColumnDraft): {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly isPrimaryKey?: boolean;
  readonly isUnique?: boolean;
  readonly defaultValue?: string;
  readonly references?: SchemaReference;
} {
  const name = draft.name.trim();
  if (!name) throw new Error("Every table column needs a name.");
  const references = parseSchemaReference(draft.reference ?? "");
  return {
    name,
    dataType: draft.dataType,
    nullable: draft.isPrimaryKey ? false : draft.nullable,
    ...(draft.isPrimaryKey ? { isPrimaryKey: true } : {}),
    ...(draft.isUnique && !draft.isPrimaryKey ? { isUnique: true } : {}),
    ...(draft.defaultValue?.trim() ? { defaultValue: draft.defaultValue.trim() } : {}),
    ...(references ? { references } : {}),
  };
}

export function ensureUniqueSchemaColumnNames(columns: readonly { readonly name: string }[]): void {
  const names = columns.map((column) => column.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    throw new Error("Table column names must be unique.");
  }
}
