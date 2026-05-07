import Database from 'better-sqlite3'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_STATION_SETTINGS,
  normalizeStationSettings,
  type GuiResponseEnvelope,
  type HistoricalRecords,
  type MirroredEventRecord,
  type OverrideRecord,
  type StationSettings,
  type StoredCommandResponseRecord,
  type StorageSummary,
  type UpdateCheckResult,
} from '../src/shared/contracts'

export class LocalStorageStore {
  private readonly db: Database.Database
  readonly databasePath: string
  readonly jsonlPath: string

  constructor(userDataPath: string) {
    const dataDir = join(userDataPath, 'data')
    mkdirSync(dataDir, { recursive: true })
    this.databasePath = join(dataDir, 'cartridge-subassembly.sqlite')
    this.jsonlPath = join(dataDir, 'event-mirror.jsonl')
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  getSettings(): StationSettings {
    const row = this.db
      .prepare('SELECT value_json FROM station_settings WHERE key = ?')
      .get('default') as { value_json: string } | undefined

    if (!row) {
      this.saveSettings(DEFAULT_STATION_SETTINGS)
      return DEFAULT_STATION_SETTINGS
    }

    return normalizeStationSettings(JSON.parse(row.value_json))
  }

  saveSettings(settings: StationSettings): StationSettings {
    const normalizedSettings = normalizeStationSettings(settings)
    this.db
      .prepare(
        `INSERT INTO station_settings (key, value_json, updated_at)
         VALUES ('default', @value_json, @updated_at)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        value_json: JSON.stringify(normalizedSettings),
        updated_at: new Date().toISOString(),
      })

    return normalizedSettings
  }

  saveCommand(command: string, mode: string): string {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO commands (id, command, mode, sent_at)
         VALUES (@id, @command, @mode, @sent_at)`,
      )
      .run({
        id,
        command,
        mode,
        sent_at: new Date().toISOString(),
      })
    return id
  }

  saveResponse(response: GuiResponseEnvelope, rawLine?: string): void {
    this.db
      .prepare(
        `INSERT INTO command_responses (id, command, ok, response_json, raw_line, received_at)
         VALUES (@id, @command, @ok, @response_json, @raw_line, @received_at)`,
      )
      .run({
        id: randomUUID(),
        command: response.command,
        ok: response.ok ? 1 : 0,
        response_json: JSON.stringify(response),
        raw_line: rawLine ?? null,
        received_at: new Date().toISOString(),
      })
  }

  saveMirroredEvent(record: MirroredEventRecord): void {
    const recordJson = JSON.stringify(record)
    this.db
      .prepare(
        `INSERT INTO mirrored_events
          (id, event_name, data_json, record_json, run_uid, cartridge_serial, created_at, upload_status)
         VALUES
          (@id, @event_name, @data_json, @record_json, @run_uid, @cartridge_serial, @created_at, @upload_status)`,
      )
      .run({
        id: randomUUID(),
        event_name: record.event_name,
        data_json: JSON.stringify(record.data),
        record_json: recordJson,
        run_uid: record.run_uid ?? null,
        cartridge_serial: record.cartridge_serial ?? null,
        created_at: record.local_timestamp,
        upload_status: record.upload_status,
      })

    appendFileSync(this.jsonlPath, `${recordJson}\n`, { encoding: 'utf8' })
  }

  saveOverride(override: OverrideRecord): void {
    this.db
      .prepare(
        `INSERT INTO overrides
          (id, run_uid, cartridge_serial, operator, action, reason, created_at)
         VALUES
          (@id, @run_uid, @cartridge_serial, @operator, @action, @reason, @created_at)`,
      )
      .run({
        id: override.id,
        run_uid: override.run_uid ?? null,
        cartridge_serial: override.cartridge_serial ?? null,
        operator: override.operator,
        action: override.action,
        reason: override.reason,
        created_at: override.created_at,
      })
  }

  saveUpdateCheck(result: UpdateCheckResult): void {
    this.db
      .prepare(
        `INSERT INTO update_checks (id, checked_at, status, version, message)
         VALUES (@id, @checked_at, @status, @version, @message)`,
      )
      .run({
        id: randomUUID(),
        checked_at: result.checked_at,
        status: result.status,
        version: result.version ?? null,
        message: result.message ?? null,
      })
  }

  getStorageSummary(): StorageSummary {
    return {
      databasePath: this.databasePath,
      jsonlPath: this.jsonlPath,
      eventCount: this.count('mirrored_events'),
      commandCount: this.count('commands'),
      overrideCount: this.count('overrides'),
    }
  }

  getHistoricalRecords(): HistoricalRecords {
    const commands = this.db
      .prepare(
        `SELECT id, command, mode, sent_at
         FROM commands
         ORDER BY sent_at DESC`,
      )
      .all() as HistoricalRecords['commands']

    const responses = (this.db
      .prepare(
        `SELECT id, command, ok, response_json, raw_line, received_at
         FROM command_responses
         ORDER BY received_at DESC`,
      )
      .all() as Array<{
      id: string
      command: string
      ok: number
      response_json: string
      raw_line: string | null
      received_at: string
    }>).map<StoredCommandResponseRecord>((row) => ({
      id: row.id,
      command: row.command,
      ok: Boolean(row.ok),
      response: JSON.parse(row.response_json) as GuiResponseEnvelope,
      raw_line: row.raw_line ?? undefined,
      received_at: row.received_at,
    }))

    const events = (this.db
      .prepare(
        `SELECT id, event_name, record_json, run_uid, cartridge_serial, created_at, upload_status
         FROM mirrored_events
         ORDER BY created_at DESC`,
      )
      .all() as Array<{
      id: string
      event_name: string
      record_json: string
      run_uid: string | null
      cartridge_serial: string | null
      created_at: string
      upload_status: MirroredEventRecord['upload_status']
    }>).map((row) => ({
      id: row.id,
      event_name: row.event_name,
      record: JSON.parse(row.record_json) as MirroredEventRecord,
      run_uid: row.run_uid ?? undefined,
      cartridge_serial: row.cartridge_serial ?? undefined,
      created_at: row.created_at,
      upload_status: row.upload_status,
    }))

    const overrides = this.db
      .prepare(
        `SELECT id, run_uid, cartridge_serial, operator, action, reason, created_at
         FROM overrides
         ORDER BY created_at DESC`,
      )
      .all() as OverrideRecord[]

    return { commands, responses, events, overrides }
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS station_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        mode TEXT NOT NULL,
        sent_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS command_responses (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        ok INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        raw_line TEXT,
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mirrored_events (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        data_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        run_uid TEXT,
        cartridge_serial TEXT,
        created_at TEXT NOT NULL,
        upload_status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS overrides (
        id TEXT PRIMARY KEY,
        run_uid TEXT,
        cartridge_serial TEXT,
        operator TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS update_checks (
        id TEXT PRIMARY KEY,
        checked_at TEXT NOT NULL,
        status TEXT NOT NULL,
        version TEXT,
        message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_run_uid ON mirrored_events(run_uid);
      CREATE INDEX IF NOT EXISTS idx_events_cartridge ON mirrored_events(cartridge_serial);
      CREATE INDEX IF NOT EXISTS idx_commands_sent_at ON commands(sent_at);
    `)
  }

  private count(tableName: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }
    return row.count
  }
}
