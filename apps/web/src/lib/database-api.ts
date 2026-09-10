export interface DatabaseApiResponse<T> {
  readonly data?: T;
  readonly error?: { readonly message?: string };
}

interface DatabaseFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type DatabaseApiFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<DatabaseFetchResponse>;

export function parseDatabaseApiResponse<T>(status: number, bodyText: string): T {
  let body: DatabaseApiResponse<T>;
  try {
    body = JSON.parse(bodyText) as DatabaseApiResponse<T>;
  } catch {
    throw new Error(
      status >= 200 && status < 300
        ? "The database returned an invalid response."
        : "The database request failed.",
    );
  }

  if (status < 200 || status >= 300 || body.data === undefined) {
    throw new Error(body.error?.message ?? "Database request failed.");
  }
  return body.data;
}

export async function fetchDatabaseApi<T>(
  url: string,
  fetcher: DatabaseApiFetcher = globalThis.fetch,
  timeoutMs = 15_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    return parseDatabaseApiResponse<T>(response.status, await response.text());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The database request timed out. Check the connection and try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
