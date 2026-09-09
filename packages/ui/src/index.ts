export type UiTone = "neutral" | "positive" | "warning" | "critical";

export type CapabilityKey =
  | "database"
  | "authentication"
  | "storage"
  | "functions"
  | "observability"
  | "security"
  | "analytics"
  | "alerts";

export interface TableColumn<T> {
  key: keyof T;
  label: string;
}

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export function filterItems<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [...items];
  }

  return items.filter((item) => getText(item).toLowerCase().includes(normalizedQuery));
}

export function paginateItems<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): { items: T[]; state: PaginationState } {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError("page must be a positive integer.");
  }

  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError("pageSize must be a positive integer.");
  }

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    state: {
      page: safePage,
      pageSize,
      total: items.length,
      pageCount,
    },
  };
}

export function capabilityIsAvailable(
  capabilities: Partial<Record<CapabilityKey, boolean>>,
  capability: CapabilityKey,
): boolean {
  return capabilities[capability] === true;
}
