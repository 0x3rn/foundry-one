import type { PrismaClient } from "@prisma/client";

const MAX_NAME_LENGTH = 80;
const MAX_FOLDER_LENGTH = 40;
const MAX_SQL_LENGTH = 20_000;
const FOLDER_DELIMITER = " / ";

export interface StoredSavedQuery {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly createdById: string;
  readonly createdByName?: string;
  readonly name: string;
  readonly folder?: string;
  readonly sqlText: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSavedQueryInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly createdById: string;
  readonly name: string;
  readonly folder?: string;
  readonly sqlText: string;
}

export interface UpdateSavedQueryInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly folder?: string;
  readonly sqlText: string;
}

export interface DeleteSavedQueryInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

export class SavedQueryError extends Error {
  constructor(
    readonly code: "INVALID_SAVED_QUERY" | "SAVED_QUERY_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SavedQueryError";
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeFolder(folder?: string): string | undefined {
  if (folder === undefined) return undefined;
  const trimmed = folder.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_FOLDER_LENGTH) {
    throw new SavedQueryError(
      "INVALID_SAVED_QUERY",
      `Saved query folder names must be ${MAX_FOLDER_LENGTH} characters or fewer.`,
    );
  }
  if (trimmed.includes("/") || hasControlCharacters(trimmed)) {
    throw new SavedQueryError(
      "INVALID_SAVED_QUERY",
      "Saved query folder names cannot contain slashes or control characters.",
    );
  }
  return trimmed;
}

function normalizeName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    throw new SavedQueryError("INVALID_SAVED_QUERY", "A saved query name is required.");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new SavedQueryError(
      "INVALID_SAVED_QUERY",
      `Saved query names must be ${MAX_NAME_LENGTH} characters or fewer.`,
    );
  }
  if (hasControlCharacters(trimmed)) {
    throw new SavedQueryError(
      "INVALID_SAVED_QUERY",
      "Saved query names cannot contain control characters.",
    );
  }
  return trimmed;
}

function normalizeSqlText(sqlText: string): string {
  const trimmed = sqlText.trim();
  if (!trimmed) {
    throw new SavedQueryError("INVALID_SAVED_QUERY", "SQL text is required to save a query.");
  }
  if (trimmed.length > MAX_SQL_LENGTH) {
    throw new SavedQueryError(
      "INVALID_SAVED_QUERY",
      `Saved queries must be ${MAX_SQL_LENGTH.toLocaleString()} characters or fewer.`,
    );
  }
  return trimmed;
}

export function encodeSavedQueryTitle(name: string, folder?: string): string {
  const parsedFromName =
    folder === undefined && name.includes("/")
      ? (() => {
          const slashIndex = name.indexOf("/");
          const candidateFolder = name.slice(0, slashIndex).trim();
          const candidateName = name.slice(slashIndex + 1).trim();
          return candidateFolder && candidateName
            ? { folder: normalizeFolder(candidateFolder), name: normalizeName(candidateName) }
            : { folder: undefined, name: normalizeName(name) };
        })()
      : {
          folder: normalizeFolder(folder),
          name: normalizeName(name.replaceAll("/", "-")),
        };

  return parsedFromName.folder
    ? `${parsedFromName.folder}${FOLDER_DELIMITER}${parsedFromName.name}`
    : parsedFromName.name;
}

export function parseSavedQueryTitle(storedTitle: string): {
  readonly name: string;
  readonly folder?: string;
} {
  const delimiterIndex = storedTitle.indexOf(FOLDER_DELIMITER);
  if (delimiterIndex > 0) {
    const folder = storedTitle.slice(0, delimiterIndex).trim();
    const name = storedTitle.slice(delimiterIndex + FOLDER_DELIMITER.length).trim();
    if (folder && name) {
      return { folder, name };
    }
  }
  return { name: storedTitle.trim() || "Untitled query" };
}

interface SavedQueryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly createdById: string;
  readonly name: string;
  readonly sqlText: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdBy?: { readonly name: string } | null;
}

function toStoredSavedQuery(record: SavedQueryRecord): StoredSavedQuery {
  const parsed = parseSavedQueryTitle(record.name);
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId ?? "",
    createdById: record.createdById,
    ...(record.createdBy?.name ? { createdByName: record.createdBy.name } : {}),
    name: parsed.name,
    ...(parsed.folder ? { folder: parsed.folder } : {}),
    sqlText: record.sqlText,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export class PrismaSavedQueryStore {
  constructor(private readonly client: PrismaClient) {}

  async listByProject(
    workspaceId: string,
    projectId: string,
  ): Promise<readonly StoredSavedQuery[]> {
    const records = await this.client.savedQuery.findMany({
      where: { workspaceId, projectId },
      orderBy: [{ updatedAt: "desc" }],
      include: { createdBy: { select: { name: true } } },
    });
    return records.map(toStoredSavedQuery);
  }

  async create(input: CreateSavedQueryInput): Promise<StoredSavedQuery> {
    const title = encodeSavedQueryTitle(input.name, input.folder);
    const sqlText = normalizeSqlText(input.sqlText);
    const record = await this.client.savedQuery.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        createdById: input.createdById,
        name: title,
        sqlText,
      },
      include: { createdBy: { select: { name: true } } },
    });
    return toStoredSavedQuery(record);
  }

  async update(input: UpdateSavedQueryInput): Promise<StoredSavedQuery> {
    const title = encodeSavedQueryTitle(input.name, input.folder);
    const sqlText = normalizeSqlText(input.sqlText);
    const existing = await this.client.savedQuery.findFirst({
      where: {
        id: input.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
      select: { id: true },
    });
    if (!existing) {
      throw new SavedQueryError(
        "SAVED_QUERY_NOT_FOUND",
        "The saved query was not found in this project.",
      );
    }
    const record = await this.client.savedQuery.update({
      where: { id: existing.id },
      data: {
        name: title,
        sqlText,
      },
      include: { createdBy: { select: { name: true } } },
    });
    return toStoredSavedQuery(record);
  }

  async delete(input: DeleteSavedQueryInput): Promise<void> {
    const deleted = await this.client.savedQuery.deleteMany({
      where: {
        id: input.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
    });
    if (deleted.count !== 1) {
      throw new SavedQueryError(
        "SAVED_QUERY_NOT_FOUND",
        "The saved query was not found in this project.",
      );
    }
  }
}
