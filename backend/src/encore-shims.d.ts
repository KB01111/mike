declare module "encore.dev/api" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  export class RawRequest extends IncomingMessage {}
  export class RawResponse extends ServerResponse {}

  export type RawHandler = (
    req: IncomingMessage,
    resp: ServerResponse,
  ) => void;

  export const api: {
    raw: (
      options: {
        expose?: boolean;
        method?: string | string[];
        path?: string;
        bodyLimit?: number | null;
      },
      fn: RawHandler,
    ) => RawHandler;
  };
}

declare module "encore.dev/service" {
  export class Service {
    constructor(name: string, cfg?: Record<string, unknown>);
  }
}

declare module "encore.dev/storage/sqldb" {
  export class SQLDatabase {
    constructor(name: string, cfg?: { migrations?: string });
    rawQueryAll<T extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      ...params: unknown[]
    ): Promise<T[]>;
    rawQueryRow<T extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      ...params: unknown[]
    ): Promise<T | null>;
    rawExec(query: string, ...params: unknown[]): Promise<void>;
  }
}
