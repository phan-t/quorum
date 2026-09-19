/**
 * Choosing a store from the environment.
 *
 * The rule is that nothing requires AWS to run. Unset environment means the
 * in-memory store, which is why `npm test` and a bare `node src/server/main.ts`
 * work on a laptop with no credentials and no container. DynamoDB is opted
 * into, either by `QUORUM_ENV=local` (DynamoDB Local, table created on boot)
 * or by `QUORUM_TABLE` (production, table created by Terraform).
 */

import { DynamoStore } from "./dynamo.ts";
import { MemoryStore } from "./memory.ts";
import type { SessionStore } from "./types.ts";

export { DynamoStore } from "./dynamo.ts";
export { MemoryStore } from "./memory.ts";
export * from "./types.ts";

export const LOCAL_ENDPOINT = "http://localhost:8000";
export const LOCAL_TABLE = "quorum-local";
/** DynamoDB Local ignores it, but the SDK will not sign a request without one. */
export const LOCAL_REGION = "local";

export interface StoreChoice {
  readonly store: SessionStore;
  readonly why: string;
}

type Env = Record<string, string | undefined>;

export function chooseStore(env: Env = process.env): StoreChoice {
  const explicit = env["QUORUM_STORE"];
  if (explicit === "memory") {
    return { store: new MemoryStore(), why: "QUORUM_STORE=memory" };
  }

  const local = env["QUORUM_ENV"] === "local";
  const table = env["QUORUM_TABLE"] ?? (local ? LOCAL_TABLE : undefined);

  if (!table) {
    return {
      store: new MemoryStore(),
      why: "no QUORUM_TABLE and QUORUM_ENV is not local — nothing is persisted",
    };
  }

  const endpoint = env["QUORUM_DYNAMO_ENDPOINT"] ?? (local ? LOCAL_ENDPOINT : undefined);
  // A region is mandatory even when the endpoint is a container on this
  // laptop: without one the SDK refuses to sign and the failure reads "Region
  // is missing", which points at AWS configuration rather than at the fact
  // that nothing needs configuring. DynamoDB Local runs with `-sharedDb` and
  // ignores the value. In production the task definition sets AWS_REGION.
  const region = env["AWS_REGION"] ?? (endpoint ? LOCAL_REGION : undefined);
  return {
    store: new DynamoStore({
      table,
      ...(region ? { region } : {}),
      ...(endpoint ? { endpoint } : {}),
      // Local development creates its own table so `docker compose up` and
      // `npm run dev` are the whole setup. Production must not: the task role
      // has no CreateTable, deliberately, because Terraform owns the schema.
      createTable: local,
    }),
    why: endpoint ? `dynamodb ${table} at ${endpoint}` : `dynamodb ${table}`,
  };
}

/**
 * Open the chosen store, falling back to memory if it will not answer.
 *
 * A laptop that forgot `docker compose up` should still get a running server
 * with a loud line in the log, not a stack trace at boot. The same fallback in
 * production means a DynamoDB outage delays the scoreboard's durability rather
 * than preventing the session from starting, which is the right way round for
 * a room full of people waiting.
 */
export async function openStore(
  env: Env = process.env,
  log: (line: string) => void = console.log,
): Promise<SessionStore> {
  const { store, why } = chooseStore(env);
  try {
    await store.init();
    log(`  store: ${why}`);
    return store;
  } catch (err) {
    log(
      `  store: ${why} — unreachable (${describe(err)}); falling back to memory. ` +
        `Nothing will survive a restart.`,
    );
    await store.close().catch(() => {});
    return new MemoryStore();
  }
}

export function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
