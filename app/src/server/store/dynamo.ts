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
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import type { Event, SessionState } from "../../engine/types.ts";
import {
  assetKeyProblem,
  assetPk,
  assetSortKey,
  checkAssetKey,
  checkAssetSize,
  checkPromoSize,
  codePk,
  eventSortKey,
  promoPk,
  sessionPk,
  SNAPSHOT_VERSION,
  ttlAt,
  type AssetSummary,
  type LoadedSession,
  type SessionMeta,
  type SessionStore,
  type StoredAsset,
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
/**
 * A number, or nothing at all.
 *
 * Distinct from `num` on purpose: the snapshot's vintage has to be able to say
 * "this row does not have one", and `num`'s zero default would turn a row
 * written before the field existed into a row written at the epoch, claiming
 * version 0 — the one answer that must not be invented. See
 * `SNAPSHOT_SELF_DESCRIBING_VERSION`.
 */
const optNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

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
      // Omitted rather than written null: DynamoDB stores what it is given,
      // and a session staged with no setup should read back the same as one
      // written before this field existed.
      ...(meta.setup == null ? {} : { setup: meta.setup }),
      ttl: ttlAt(meta.updatedAt),
    });
  }

  async putSnapshot(sid: string, state: SessionState, at: number): Promise<void> {
    await this.put({
      PK: sessionPk(sid),
      SK: "SNAPSHOT",
      version: SNAPSHOT_VERSION,
      seq: state.seq,
      // Also the row's write time, read back as `StoredSnapshot.writtenAt`. No
      // second attribute for it: `at` has been on every snapshot row since the
      // first one, so dating a row needs nothing new written — which is the
      // whole point, because the rows that need dating are the old ones.
      at,
      state,
      ttl: ttlAt(at),
    });
  }

  async putPromo(sid: string, html: string, at: number): Promise<void> {
    checkPromoSize(html);
    await this.put({
      PK: promoPk(sid),
      SK: "PROMO",
      html,
      // Denormalised so the size of the one item here that could approach
      // DynamoDB's 400KB ceiling is visible in the table without downloading
      // the page to measure it.
      chars: html.length,
      at,
      ttl: ttlAt(at),
    });
  }

  async getPromo(sid: string): Promise<string | null> {
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: promoPk(sid), SK: "PROMO" },
      }),
    );
    const html = (out.Item as Item | undefined)?.["html"];
    return typeof html === "string" ? html : null;
  }

  async putAsset(
    sid: string,
    key: string,
    bytes: Uint8Array,
    contentType: string,
    at: number,
  ): Promise<void> {
    checkAssetKey(key);
    checkAssetSize(key, bytes);
    await this.put({
      PK: assetPk(sid),
      SK: assetSortKey(key),
      assetKey: key,
      contentType,
      // A `Uint8Array` through `lib-dynamodb` marshals to a `B` attribute.
      // Base64 in an `S` would be a third larger for nothing — see
      // MAX_ASSET_BYTES.
      bytes,
      // Denormalised so the size of a montage is readable off the table
      // without downloading it to measure.
      size: bytes.byteLength,
      at,
      ttl: ttlAt(at),
    });
  }

  async getAsset(sid: string, key: string): Promise<StoredAsset | null> {
    if (assetKeyProblem(key) !== null) return null;
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: assetPk(sid), SK: assetSortKey(key) },
      }),
    );
    const item = out.Item as Item | undefined;
    if (!item) return null;
    const bytes = item["bytes"];
    if (!(bytes instanceof Uint8Array)) return null;
    return {
      key: str(item["assetKey"], key),
      contentType: str(item["contentType"], "application/octet-stream"),
      bytes,
      at: num(item["at"]),
    };
  }

  async listAssets(sid: string): Promise<readonly AssetSummary[]> {
    const summaries: AssetSummary[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out: {
        Items?: Item[] | undefined;
        LastEvaluatedKey?: Record<string, unknown> | undefined;
      } = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": assetPk(sid) },
          // Everything but the bytes. `size` is a reserved word and the others
          // are aliased beside it rather than half the list being bare, which
          // is the version somebody later adds a reserved word to.
          ProjectionExpression: "#k, #ct, #sz, #at",
          ExpressionAttributeNames: {
            "#k": "assetKey",
            "#ct": "contentType",
            "#sz": "size",
            "#at": "at",
          },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const i of out.Items ?? []) {
        const key = str(i["assetKey"]);
        if (key === "") continue;
        summaries.push({
          key,
          contentType: str(i["contentType"], "application/octet-stream"),
          size: num(i["size"]),
          at: num(i["at"]),
        });
      }
      start = out.LastEvaluatedKey;
    } while (start);
    summaries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return summaries;
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
          // No filter, and none needed: the promo card and the send-off
          // assets live in their own partitions (`promoPk`, `assetPk`)
          // precisely so this read never sees them. The
          // first attempt kept it here and excluded it with
          // `FilterExpression: "SK <> :promo"`, which DynamoDB rejects outright
          // — a filter may not name a key attribute — and which therefore broke
          // every recovery and every export, for every session, card or no
          // card. The suite did not catch it because the suite runs on the
          // memory store.
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
      setup: typeof metaItem["setup"] === "string" ? metaItem["setup"] : null,
    };

    const snapItem = items.find((i) => i["SK"] === "SNAPSHOT");
    const snapshot =
      snapItem && typeof snapItem["state"] === "object" && snapItem["state"] !== null
        ? {
            seq: num(snapItem["seq"]),
            state: snapItem["state"] as SessionState,
            // Spread away when absent rather than defaulted. A row written
            // before the version was read back has no vintage, and recovery
            // needs to be told that rather than handed a plausible number: it
            // is the difference between a migration that asserts and one that
            // guesses. `at` has been written since the first snapshot ever
            // stored, so even the oldest row in the table can be dated.
            ...(optNum(snapItem["version"]) !== undefined
              ? { version: optNum(snapItem["version"])! }
              : {}),
            ...(optNum(snapItem["at"]) !== undefined
              ? { writtenAt: optNum(snapItem["at"])! }
              : {}),
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
          // `draft` is in here because a session is created before it is
          // opened, and that gap is exactly when a host sets one up in
          // advance. Without it a deploy — or ECS replacing a task for its
          // own reasons — rebuilds the registry without the session, and the
          // console gets `bad_token` for a link that was correct. The rows
          // are all still in the table, which is the confusing part: the CSV
          // export keeps working because it reads the store directly, while
          // the socket needs the registry. This bit a real setup the day
          // before an event.
          //
          // `closed` is in here too, and it has to be: `reopen` exists to
          // undo an accidental close, and a close that outlives the process
          // could not be undone at all — the host socket got `bad_token` for
          // a correct link. That is not hypothetical either; it happened, and
          // the deploy that followed is what put the session out of reach.
          //
          // The argument for leaving it out was that a 90-day retention
          // window could hold a lot of finished sessions to pull at boot.
          // Worth checking rather than assuming: this table holds two META
          // rows. At roughly one event a month, and with the TTL clearing
          // them at 90 days, the scan stays trivial. If that ever stops being
          // true, bound it by `updatedAt` rather than by phase — a close from
          // six weeks ago does not need reopening, one from six minutes ago
          // very much does.
          FilterExpression:
            "SK = :meta AND #phase IN (:draft, :lobby, :running, :closed)",
          ExpressionAttributeNames: { "#phase": "phase" },
          ExpressionAttributeValues: {
            ":meta": "META",
            ":draft": "draft",
            ":lobby": "lobby",
            ":running": "running",
            ":closed": "closed",
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
