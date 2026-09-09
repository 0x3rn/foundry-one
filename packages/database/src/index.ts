export interface DatabaseClient {
  query<T>(statement: string, parameters?: readonly unknown[]): Promise<readonly T[]>;
}
