/**
 * DynamoDB, single table, exactly the key layout in ARCHITECTURE.md's
 * "Data model".
 *
 * Everything is `PK = SESSION#<sid>` except the join-code lookup, which is its
 * own partition. There is no GSI, so recovery is a `Scan` filtered to `META`
 * items in `lobby` or `running` — the table holds a few thousand small items
 * and the task role is scoped to allow exactly that.
 *
 * `lib-dynamodb`'s document client does the marshalling. Hand-rolling
 * `{ S: … }` shapes for a nested session state would be a page of code whose
 * only job is to be wrong in one place.
 *
 * No credentials appear here. In production the task role provides them; in
 * local development the endpoint override comes with a pair of throwaway
 * values, because DynamoDB Local requires *something* in the signature and
 * refuses the request without it.
 */

import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import type { Event, SessionState } from "../../engine/types.ts";
import {
  codePk,
  eventSortKey,
  sessionPk,
  SNAPSHOT_VERSION,
  ttlAt,
  type LoadedSession,
  type SessionMeta,
  type SessionStore,
  type StoredEvent,
  type StoredParticipant,
} from "./types.ts";

export interface DynamoStoreOptions {
  readonly table: string;
  readonly region?: string;
  /** Set for DynamoDB Local. Unset in production, where the SDK resolves it. */
  readonly endpoint?: string;
  /** Create the table if it is missing. Local only; production is Terraform. */
  readonly createTable?: boolean;
}

type Item = Record<string, unknown>;

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;
const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export class DynamoStore implements SessionStore {
  readonly kind = "dynamodb" as const;

  private readonly raw: DynamoDBClient;
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;
  private readonly createTable: boolean;

  constructor(opts: DynamoStoreOptions) {
    this.table = opts.table;
    this.createTable = opts.createTable ?? false;
    this.raw = new DynamoDBClient({
      ...(opts.region ? { region: opts.region } : {}),
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      // Only alongside an endpoint override, which only local development
      // sets. DynamoDB Local ignores the values but rejects an unsigned
      // request, and the production path must keep resolving the task role.
      ...(opts.endpoint
        ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
        : {}),
      maxAttempts: 3,
    });
    this.doc = DynamoDBDocumentClient.from(this.raw, {
      marshallOptions: {
        // A snapshot is a plain object graph; an absent optional field should
        // simply not be stored rather than fail the write.
        removeUndefinedValues: true,
        convertClassInstanceToMap: false,
      },
    });
  }

  async init(): Promise<void> {
    if (!this.createTable) return;
    try {
      await this.raw.send(
        new CreateTableCommand({
          TableName: this.table,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "PK", AttributeType: "S" },
            { AttributeName: "SK", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "PK", KeyType: "HASH" },
            { AttributeName: "SK", KeyType: "RANGE" },
          ],
        }),
      );
      await waitUntilTableExists(
        { client: this.raw, maxWaitTime: 30 },
        { TableName: this.table },
      );
    } catch (err) {
      // Already there: two `npm run dev` processes, or a second boot against
      // the named volume. That is the normal case, not a failure.
      if (err instanceof ResourceInUseException) return;
      throw err;
    }
  }

  private async put(item: Item): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async putMeta(meta: SessionMeta): Promise<void> {
    await this.put({
      PK: sessionPk(meta.sid),
      SK: "META",
      sid: meta.sid,
      title: meta.title,
      joinCode: meta.joinCode,
      phase: meta.phase,
      seal: meta.seal,
      hostTokenHash: meta.hostTokenHash,
      screenTokenHash: meta.screenTokenHash,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      ttl: ttlAt(meta.updatedAt),
    });
  }

  async putSnapshot(sid: string, state: SessionState, at: number): Promise<void> {
    await this.put({
      PK: sessionPk(sid),
      SK: "SNAPSHOT",
      version: SNAPSHOT_VERSION,
      seq: state.seq,
      at,
      state,
      ttl: ttlAt(at),
    });
  }

  async appendEvent(sid: string, record: StoredEvent): Promise<void> {
    await this.put({
      PK: sessionPk(sid),
      SK: eventSortKey(record.seq),
      seq: record.seq,
      type: record.event.type,
      event: record.event,
      at: record.at,
      // Denormalised so a dispute can be read straight off the console
      // without parsing the payload.
      ...("pid" in record.event ? { byPid: record.event.pid } : {}),
      ttl: ttlAt(record.at),
    });
  }

  async putParticipant(sid: string, p: StoredParticipant): Promise<void> {
    await this.put({
      PK: sessionPk(sid),
      SK: `PARTICIPANT#${p.pid}`,
      pid: p.pid,
      nickname: p.nickname,
      nicknameKey: p.nicknameKey,
      playerNumber: p.playerNumber,
      joinedAt: p.joinedAt,
      kicked: p.kicked,
      rejoinTokenHashes: [...p.rejoinTokenHashes],
      ttl: ttlAt(Date.now()),
    });
  }

  async putJoinCode(joinCode: string, sid: string): Promise<void> {
    await this.put({
      PK: codePk(joinCode),
      SK: "ACTIVE",
      sid,
      ttl: ttlAt(Date.now()),
    });
  }

  async deleteJoinCode(joinCode: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { PK: codePk(joinCode), SK: "ACTIVE" },
      }),
    );
  }

  /** Every item in one session's partition, following pagination. */
  private async partition(sid: string): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out: {
        Items?: Item[] | undefined;
        LastEvaluatedKey?: Record<string, unknown> | undefined;
      } = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": sessionPk(sid) },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const i of out.Items ?? []) items.push(i);
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }

  private assemble(items: readonly Item[]): LoadedSession | null {
    const metaItem = items.find((i) => i["SK"] === "META");
    if (!metaItem) return null;

    const meta: SessionMeta = {
      sid: str(metaItem["sid"]),
      title: str(metaItem["title"]),
      joinCode: str(metaItem["joinCode"]),
      phase: str(metaItem["phase"], "draft") as SessionMeta["phase"],
      seal: str(metaItem["seal"], "live") as SessionMeta["seal"],
      hostTokenHash: str(metaItem["hostTokenHash"]),
      screenTokenHash: str(metaItem["screenTokenHash"]),
      createdAt: num(metaItem["createdAt"]),
      updatedAt: num(metaItem["updatedAt"]),
    };

    const snapItem = items.find((i) => i["SK"] === "SNAPSHOT");
    const snapshot =
      snapItem && typeof snapItem["state"] === "object" && snapItem["state"] !== null
        ? {
            seq: num(snapItem["seq"]),
            state: snapItem["state"] as SessionState,
          }
        : null;

    const events: StoredEvent[] = items
      .filter((i) => str(i["SK"]).startsWith("EVENT#"))
      .map((i) => ({
        seq: num(i["seq"]),
        event: i["event"] as Event,
        at: num(i["at"]),
      }))
      .filter((e) => e.event != null && typeof e.event === "object")
      .sort((a, b) => a.seq - b.seq);

    const participants: StoredParticipant[] = items
      .filter((i) => str(i["SK"]).startsWith("PARTICIPANT#"))
      .map((i) => ({
        pid: str(i["pid"]),
        nickname: str(i["nickname"]),
        nicknameKey: str(i["nicknameKey"]),
        playerNumber: num(i["playerNumber"]),
        joinedAt: num(i["joinedAt"]),
        kicked: i["kicked"] === true,
        rejoinTokenHashes: Array.isArray(i["rejoinTokenHashes"])
          ? (i["rejoinTokenHashes"] as unknown[]).filter(
              (h): h is string => typeof h === "string",
            )
          : [],
      }))
      .filter((p) => p.pid !== "");

    return { meta, snapshot, events, participants };
  }

  async loadRecoverable(): Promise<LoadedSession[]> {
    const sids: string[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out: {
        Items?: Item[] | undefined;
        LastEvaluatedKey?: Record<string, unknown> | undefined;
      } = await this.doc.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "SK = :meta AND #phase IN (:lobby, :running)",
          ExpressionAttributeNames: { "#phase": "phase" },
          ExpressionAttributeValues: {
            ":meta": "META",
            ":lobby": "lobby",
            ":running": "running",
          },
          ProjectionExpression: "sid",
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const i of out.Items ?? []) {
        const sid = str(i["sid"]);
        if (sid) sids.push(sid);
      }
      start = out.LastEvaluatedKey;
    } while (start);

    const loaded: LoadedSession[] = [];
    for (const sid of sids) {
      const s = this.assemble(await this.partition(sid));
      if (s) loaded.push(s);
    }
    return loaded;
  }

  async loadSession(sid: string): Promise<LoadedSession | null> {
    return this.assemble(await this.partition(sid));
  }

  async close(): Promise<void> {
    this.doc.destroy();
  }
}
