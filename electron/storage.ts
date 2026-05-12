import Database from 'better-sqlite3'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_STATION_SETTINGS,
  normalizeStationSettings,
  type GuiResponseEnvelope,
  type HistoricalRecords,
  type HistoricalRecordsQuery,
  type LocalRunContext,
  type MirroredEventRecord,
  type OverrideRecord,
  type StationSettings,
  type StoredCommandRecord,
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
    this.retryPendingJsonlAppends()
  }

  getSettings(): StationSettings {
    const row = this.db
      .prepare('SELECT value_json FROM station_settings WHERE key = ?')
      .get('default') as { value_json: string } | undefined

    if (!row) {
      this.saveSettings(DEFAULT_STATION_SETTINGS)
      return DEFAULT_STATION_SETTINGS
    }

    const parsed = parseJsonSafely(row.value_json, undefined) as Partial<StationSettings> | undefined
    if (!parsed || typeof parsed !== 'object') {
      console.warn('Station settings JSON was corrupt. Falling back to defaults.')
      return DEFAULT_STATION_SETTINGS
    }

    return normalizeStationSettings(parsed)
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

  getActiveRunContext(): LocalRunContext | undefined {
    const row = this.db
      .prepare('SELECT value_json FROM station_settings WHERE key = ?')
      .get('activeRunContext') as { value_json: string } | undefined

    if (!row) return undefined

    const parsed = parseJsonSafely(row.value_json, undefined) as LocalRunContext | undefined
    if (!parsed || typeof parsed !== 'object') return undefined
    return pruneRunContext(parsed)
  }

  saveActiveRunContext(context?: LocalRunContext): LocalRunContext | undefined {
    const normalized = pruneRunContext(context)
    if (!normalized) {
      this.db.prepare('DELETE FROM station_settings WHERE key = ?').run('activeRunContext')
      return undefined
    }

    this.db
      .prepare(
        `INSERT INTO station_settings (key, value_json, updated_at)
         VALUES ('activeRunContext', @value_json, @updated_at)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run({
        value_json: JSON.stringify(normalized),
        updated_at: new Date().toISOString(),
      })

    return normalized
  }

  saveCommand(command: string, mode: string, context?: LocalRunContext): string {
    const id = randomUUID()
    const normalizedContext = pruneRunContext(context)
    this.db
      .prepare(
        `INSERT INTO commands
          (id, command, mode, sent_at, context_json, run_uid, cartridge_serial, workflow, linear_stage_run_id)
         VALUES
          (@id, @command, @mode, @sent_at, @context_json, @run_uid, @cartridge_serial, @workflow, @linear_stage_run_id)`,
      )
      .run({
        id,
        command,
        mode,
        sent_at: new Date().toISOString(),
        context_json: normalizedContext ? JSON.stringify(normalizedContext) : null,
        run_uid: normalizedContext?.run_uid ?? null,
        cartridge_serial: normalizedContext?.cartridge_serial ?? null,
        workflow: normalizedContext?.workflow ?? null,
        linear_stage_run_id: normalizedContext?.linear_stage_run_id ?? null,
      })
    return id
  }

  saveResponse(response: GuiResponseEnvelope, rawLine?: string, context?: LocalRunContext): void {
    const normalizedContext = pruneRunContext(context)
    this.db
      .prepare(
        `INSERT INTO command_responses
          (id, command, ok, response_json, raw_line, received_at, context_json, run_uid, cartridge_serial, workflow, linear_stage_run_id)
         VALUES
          (@id, @command, @ok, @response_json, @raw_line, @received_at, @context_json, @run_uid, @cartridge_serial, @workflow, @linear_stage_run_id)`,
      )
      .run({
        id: randomUUID(),
        command: response.command,
        ok: response.ok ? 1 : 0,
        response_json: JSON.stringify(response),
        raw_line: rawLine ?? null,
        received_at: new Date().toISOString(),
        context_json: normalizedContext ? JSON.stringify(normalizedContext) : null,
        run_uid: normalizedContext?.run_uid ?? null,
        cartridge_serial: normalizedContext?.cartridge_serial ?? null,
        workflow: normalizedContext?.workflow ?? null,
        linear_stage_run_id: normalizedContext?.linear_stage_run_id ?? null,
      })
  }

  saveMirroredEvent(record: MirroredEventRecord): void {
    const eventId = record.event_id || randomUUID()
    const idempotencyKey = record.idempotency_key || eventId
    const pendingRecord: MirroredEventRecord = {
      ...record,
      event_id: eventId,
      idempotency_key: idempotencyKey,
      jsonl_status: 'pending',
    }
    const pendingJson = JSON.stringify(pendingRecord)
    const insertResult = this.db
      .prepare(
        `INSERT OR IGNORE INTO mirrored_events
          (id, event_name, data_json, record_json, run_uid, cartridge_serial, workflow, linear_stage_run_id, linear_stage_mode, app_version, created_at, upload_status)
         VALUES
          (@id, @event_name, @data_json, @record_json, @run_uid, @cartridge_serial, @workflow, @linear_stage_run_id, @linear_stage_mode, @app_version, @created_at, @upload_status)`,
      )
      .run({
        id: eventId,
        event_name: pendingRecord.event_name,
        data_json: JSON.stringify(pendingRecord.data),
        record_json: pendingJson,
        run_uid: pendingRecord.run_uid ?? null,
        cartridge_serial: pendingRecord.cartridge_serial ?? null,
        workflow: pendingRecord.workflow ?? null,
        linear_stage_run_id: pendingRecord.linear_stage_run_id ?? null,
        linear_stage_mode: pendingRecord.linear_stage_mode ?? null,
        app_version: pendingRecord.app_version ?? null,
        created_at: pendingRecord.local_timestamp,
        upload_status: pendingRecord.upload_status,
      })

    if (insertResult.changes === 0) {
      this.retryJsonlAppendIfNeeded(eventId)
      return
    }

    let storedRecord: MirroredEventRecord = {
      ...pendingRecord,
      jsonl_status: 'written',
    }
    let storedJson = JSON.stringify(storedRecord)
    try {
      this.appendJsonlRecord(storedRecord)
    } catch (error) {
      storedRecord = {
        ...pendingRecord,
        jsonl_status: 'write_failed',
      }
      storedJson = JSON.stringify(storedRecord)
      console.warn('Could not append mirrored event JSONL. SQLite record was saved.', error)
    }

    this.db
      .prepare(
        `UPDATE mirrored_events
         SET record_json = @record_json
         WHERE id = @id`,
      )
      .run({
        id: eventId,
      record_json: storedJson,
      })
  }

  private retryJsonlAppendIfNeeded(eventId: string): void {
    const row = this.db
      .prepare('SELECT record_json FROM mirrored_events WHERE id = ?')
      .get(eventId) as { record_json: string } | undefined
    if (!row) return

    const record = parseJsonSafely(row.record_json, undefined) as MirroredEventRecord | undefined
    if (!record || record.jsonl_status !== 'write_failed') return

    const writtenRecord: MirroredEventRecord = { ...record, jsonl_status: 'written' }
    const writtenJson = JSON.stringify(writtenRecord)
    try {
      this.appendJsonlRecord(writtenRecord)
      this.db
        .prepare('UPDATE mirrored_events SET record_json = @record_json WHERE id = @id')
        .run({ id: eventId, record_json: writtenJson })
    } catch (error) {
      console.warn('Could not retry mirrored event JSONL append.', error)
    }
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
      responseCount: this.count('command_responses'),
      overrideCount: this.count('overrides'),
    }
  }

  getHistoricalRecords(query: HistoricalRecordsQuery = {}): HistoricalRecords {
    const limit = clampHistoryLimit(query.limit)
    const offset = Math.max(0, Math.trunc(query.offset ?? 0))
    const workflow = query.workflow?.trim()
    const linearStageRunId = query.linearStageRunId?.trim()
    const text = query.text?.trim()

    const commandWhere: string[] = []
    const commandParams: Record<string, unknown> = { limit, offset }
    if (workflow === 'linear_stage') {
      commandWhere.push("(workflow = 'linear_stage' OR command LIKE 'test step%' OR command LIKE 'test linear_stage%')")
    } else if (workflow) {
      commandWhere.push('workflow = @workflow')
      commandParams.workflow = workflow
    }
    if (query.runUid?.trim()) {
      commandWhere.push('(run_uid = @runUid OR command LIKE @runUidPattern OR context_json LIKE @runUidPattern)')
      commandParams.runUid = query.runUid.trim()
      commandParams.runUidPattern = `%${query.runUid.trim()}%`
    }
    if (linearStageRunId) {
      commandWhere.push('(linear_stage_run_id = @linearStageRunId OR command LIKE @linearStageRunIdPattern OR context_json LIKE @linearStageRunIdPattern)')
      commandParams.linearStageRunId = linearStageRunId
      commandParams.linearStageRunIdPattern = `%${linearStageRunId}%`
    }
    if (query.cartridgeSerial?.trim()) {
      commandWhere.push('(cartridge_serial = @cartridgeSerial OR command LIKE @cartridgePattern OR context_json LIKE @cartridgePattern)')
      commandParams.cartridgeSerial = query.cartridgeSerial.trim()
      commandParams.cartridgePattern = `%${query.cartridgeSerial.trim()}%`
    }
    if (text) {
      commandWhere.push('(command LIKE @commandTextPattern OR context_json LIKE @commandTextPattern)')
      commandParams.commandTextPattern = `%${text}%`
    }

    const commands = this.db
      .prepare(
        `SELECT id, command, mode, sent_at, context_json, run_uid, cartridge_serial, workflow, linear_stage_run_id
         FROM commands
         ${commandWhere.length ? `WHERE ${commandWhere.join(' AND ')}` : ''}
         ORDER BY sent_at DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all(commandParams) as Array<StoredCommandRecord & { context_json?: string | null }>

    const mappedCommands = commands.map((row) => ({
      id: row.id,
      command: row.command,
      mode: row.mode,
      sent_at: row.sent_at,
      context: row.context_json ? parseJsonSafely(row.context_json, undefined) as LocalRunContext | undefined : undefined,
      run_uid: row.run_uid ?? undefined,
      cartridge_serial: row.cartridge_serial ?? undefined,
      workflow: row.workflow ?? undefined,
      linear_stage_run_id: row.linear_stage_run_id ?? undefined,
    }))

    const responseWhere: string[] = []
    const responseParams: Record<string, unknown> = { limit, offset }
    if (workflow === 'linear_stage') {
      responseWhere.push("(workflow = 'linear_stage' OR command LIKE 'test step%' OR command LIKE 'test linear_stage%' OR response_json LIKE '%LINEAR_STAGE%' OR response_json LIKE '%linear_stage%')")
    } else if (workflow) {
      responseWhere.push('workflow = @workflow')
      responseParams.workflow = workflow
    }
    if (query.runUid?.trim()) {
      responseWhere.push('(run_uid = @runUid OR command LIKE @runUidPattern OR response_json LIKE @runUidPattern OR context_json LIKE @runUidPattern)')
      responseParams.runUid = query.runUid.trim()
      responseParams.runUidPattern = `%${query.runUid.trim()}%`
    }
    if (linearStageRunId) {
      responseWhere.push('(linear_stage_run_id = @linearStageRunId OR command LIKE @linearStageRunIdPattern OR response_json LIKE @linearStageRunIdPattern OR context_json LIKE @linearStageRunIdPattern)')
      responseParams.linearStageRunId = linearStageRunId
      responseParams.linearStageRunIdPattern = `%${linearStageRunId}%`
    }
    if (query.cartridgeSerial?.trim()) {
      responseWhere.push('(cartridge_serial = @cartridgeSerial OR command LIKE @cartridgePattern OR response_json LIKE @cartridgePattern OR context_json LIKE @cartridgePattern)')
      responseParams.cartridgeSerial = query.cartridgeSerial.trim()
      responseParams.cartridgePattern = `%${query.cartridgeSerial.trim()}%`
    }
    if (text) {
      responseWhere.push('(command LIKE @responseTextPattern OR response_json LIKE @responseTextPattern OR raw_line LIKE @responseTextPattern OR context_json LIKE @responseTextPattern)')
      responseParams.responseTextPattern = `%${text}%`
    }

    const responses = (this.db
      .prepare(
        `SELECT id, command, ok, response_json, raw_line, received_at, context_json, run_uid, cartridge_serial, workflow, linear_stage_run_id
         FROM command_responses
         ${responseWhere.length ? `WHERE ${responseWhere.join(' AND ')}` : ''}
         ORDER BY received_at DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all(responseParams) as Array<{
      id: string
      command: string
      ok: number
      response_json: string
      raw_line: string | null
      received_at: string
      context_json: string | null
      run_uid: string | null
      cartridge_serial: string | null
      workflow: string | null
      linear_stage_run_id: string | null
    }>).map<StoredCommandResponseRecord>((row) => ({
      id: row.id,
      command: row.command,
      ok: Boolean(row.ok),
      response: parseJsonSafely(row.response_json, {
        type: 'response',
        ok: false,
        command: row.command,
        error: 'Stored response JSON is corrupt.',
      }) as GuiResponseEnvelope,
      raw_line: row.raw_line ?? undefined,
      received_at: row.received_at,
      context: row.context_json ? parseJsonSafely(row.context_json, undefined) as LocalRunContext | undefined : undefined,
      run_uid: row.run_uid ?? undefined,
      cartridge_serial: row.cartridge_serial ?? undefined,
      workflow: row.workflow ?? undefined,
      linear_stage_run_id: row.linear_stage_run_id ?? undefined,
    }))

    const eventWhere: string[] = []
    const eventParams: Record<string, unknown> = { limit, offset }
    if (workflow === 'cartridge_subassembly') {
      eventWhere.push(`(
        workflow = @workflow
        OR event_name = 'dd_cartridge_air_leak_summary'
        OR data_json LIKE '%CARTRIDGE_SUBASSEMBLY%'
        OR record_json LIKE '%CARTRIDGE_SUBASSEMBLY%'
        OR data_json LIKE '%cartridge_leak%'
        OR record_json LIKE '%cartridge_leak%'
        OR (event_name = 'dd_test_step_result' AND (data_json LIKE '%"cartridge_serial"%' OR record_json LIKE '%"cartridge_serial"%'))
      )`)
      eventParams.workflow = workflow
    } else if (workflow) {
      eventWhere.push('(workflow = @workflow OR record_json LIKE @workflowPattern OR data_json LIKE @workflowPattern OR event_name LIKE @workflowPattern)')
      eventParams.workflow = workflow
      eventParams.workflowPattern = `%${workflow}%`
    }
    if (query.runUid?.trim()) {
      eventWhere.push('(run_uid = @runUid OR record_json LIKE @runUidPattern OR data_json LIKE @runUidPattern)')
      eventParams.runUid = query.runUid.trim()
      eventParams.runUidPattern = `%${query.runUid.trim()}%`
    }
    if (linearStageRunId) {
      eventWhere.push('(linear_stage_run_id = @linearStageRunId OR run_uid = @linearStageRunId OR record_json LIKE @linearStageRunIdPattern)')
      eventParams.linearStageRunId = linearStageRunId
      eventParams.linearStageRunIdPattern = `%${linearStageRunId}%`
    }
    if (query.cartridgeSerial?.trim()) {
      eventWhere.push('(cartridge_serial = @cartridgeSerial OR record_json LIKE @cartridgePattern OR data_json LIKE @cartridgePattern)')
      eventParams.cartridgeSerial = query.cartridgeSerial.trim()
      eventParams.cartridgePattern = `%${query.cartridgeSerial.trim()}%`
    }
    if (text) {
      eventWhere.push('(event_name LIKE @eventTextPattern OR data_json LIKE @eventTextPattern OR record_json LIKE @eventTextPattern)')
      eventParams.eventTextPattern = `%${text}%`
    }

    const events = (this.db
      .prepare(
        `SELECT id, event_name, record_json, run_uid, cartridge_serial, workflow, linear_stage_run_id, linear_stage_mode, app_version, created_at, upload_status
         FROM mirrored_events
         ${eventWhere.length ? `WHERE ${eventWhere.join(' AND ')}` : ''}
         ORDER BY created_at DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all(eventParams) as Array<{
      id: string
      event_name: string
      record_json: string
      run_uid: string | null
      cartridge_serial: string | null
      workflow: string | null
      linear_stage_run_id: string | null
      linear_stage_mode: MirroredEventRecord['linear_stage_mode'] | null
      app_version: string | null
      created_at: string
      upload_status: MirroredEventRecord['upload_status']
    }>).map((row) => ({
      id: row.id,
      event_name: row.event_name,
      record: parseJsonSafely(row.record_json, {
        event_id: row.id,
        idempotency_key: row.id,
        event_name: row.event_name,
        data: { storage_error: 'Stored event JSON is corrupt.' },
        local_timestamp: row.created_at,
        run_uid: row.run_uid ?? undefined,
        cartridge_serial: row.cartridge_serial ?? undefined,
        workflow: row.workflow ?? undefined,
        linear_stage_run_id: row.linear_stage_run_id ?? undefined,
        linear_stage_mode: row.linear_stage_mode ?? undefined,
        app_version: row.app_version ?? undefined,
        upload_status: row.upload_status,
      }) as MirroredEventRecord,
      run_uid: row.run_uid ?? undefined,
      cartridge_serial: row.cartridge_serial ?? undefined,
      workflow: row.workflow ?? undefined,
      linear_stage_run_id: row.linear_stage_run_id ?? undefined,
      linear_stage_mode: row.linear_stage_mode ?? undefined,
      app_version: row.app_version ?? undefined,
      created_at: row.created_at,
      upload_status: row.upload_status,
    }))

    const overrideWhere: string[] = []
    const overrideParams: Record<string, unknown> = { limit, offset }
    if (workflow === 'linear_stage') {
      overrideWhere.push("(action LIKE '%linear-stage%' OR run_uid LIKE 'linear-%')")
    }
    if (query.runUid?.trim()) {
      overrideWhere.push('run_uid = @runUid')
      overrideParams.runUid = query.runUid.trim()
    }
    if (linearStageRunId) {
      overrideWhere.push('run_uid = @linearStageRunId')
      overrideParams.linearStageRunId = linearStageRunId
    }
    if (query.cartridgeSerial?.trim()) {
      overrideWhere.push('cartridge_serial = @cartridgeSerial')
      overrideParams.cartridgeSerial = query.cartridgeSerial.trim()
    }
    if (text) {
      overrideWhere.push('(run_uid LIKE @overrideTextPattern OR cartridge_serial LIKE @overrideTextPattern OR operator LIKE @overrideTextPattern OR action LIKE @overrideTextPattern OR reason LIKE @overrideTextPattern)')
      overrideParams.overrideTextPattern = `%${text}%`
    }

    const overrides = this.db
      .prepare(
        `SELECT id, run_uid, cartridge_serial, operator, action, reason, created_at
         FROM overrides
         ${overrideWhere.length ? `WHERE ${overrideWhere.join(' AND ')}` : ''}
         ORDER BY created_at DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all(overrideParams) as OverrideRecord[]

    return { commands: mappedCommands, responses, events, overrides }
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
        sent_at TEXT NOT NULL,
        context_json TEXT,
        run_uid TEXT,
        cartridge_serial TEXT,
        workflow TEXT,
        linear_stage_run_id TEXT
      );

      CREATE TABLE IF NOT EXISTS command_responses (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        ok INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        raw_line TEXT,
        received_at TEXT NOT NULL,
        context_json TEXT,
        run_uid TEXT,
        cartridge_serial TEXT,
        workflow TEXT,
        linear_stage_run_id TEXT
      );

      CREATE TABLE IF NOT EXISTS mirrored_events (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        data_json TEXT NOT NULL,
        record_json TEXT NOT NULL,
        run_uid TEXT,
        cartridge_serial TEXT,
        workflow TEXT,
        linear_stage_run_id TEXT,
        linear_stage_mode TEXT,
        app_version TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON mirrored_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_commands_sent_at ON commands(sent_at);
    `)

    this.ensureColumn('commands', 'context_json', 'TEXT')
    this.ensureColumn('commands', 'run_uid', 'TEXT')
    this.ensureColumn('commands', 'cartridge_serial', 'TEXT')
    this.ensureColumn('commands', 'workflow', 'TEXT')
    this.ensureColumn('commands', 'linear_stage_run_id', 'TEXT')
    this.ensureColumn('command_responses', 'context_json', 'TEXT')
    this.ensureColumn('command_responses', 'run_uid', 'TEXT')
    this.ensureColumn('command_responses', 'cartridge_serial', 'TEXT')
    this.ensureColumn('command_responses', 'workflow', 'TEXT')
    this.ensureColumn('command_responses', 'linear_stage_run_id', 'TEXT')
    this.ensureColumn('mirrored_events', 'workflow', 'TEXT')
    this.ensureColumn('mirrored_events', 'linear_stage_run_id', 'TEXT')
    this.ensureColumn('mirrored_events', 'linear_stage_mode', 'TEXT')
    this.ensureColumn('mirrored_events', 'app_version', 'TEXT')

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_commands_run ON commands(run_uid);
      CREATE INDEX IF NOT EXISTS idx_commands_linear_run ON commands(linear_stage_run_id);
      CREATE INDEX IF NOT EXISTS idx_responses_run ON command_responses(run_uid);
      CREATE INDEX IF NOT EXISTS idx_responses_linear_run ON command_responses(linear_stage_run_id);
      CREATE INDEX IF NOT EXISTS idx_responses_received_at ON command_responses(received_at);
      CREATE INDEX IF NOT EXISTS idx_events_workflow ON mirrored_events(workflow);
      CREATE INDEX IF NOT EXISTS idx_events_linear_run ON mirrored_events(linear_stage_run_id);
      CREATE INDEX IF NOT EXISTS idx_events_linear_mode ON mirrored_events(linear_stage_mode);
      CREATE INDEX IF NOT EXISTS idx_events_app_version ON mirrored_events(app_version);
      CREATE INDEX IF NOT EXISTS idx_overrides_created_at ON overrides(created_at);
    `)
  }

  private retryPendingJsonlAppends(): void {
    const rows = this.db
      .prepare("SELECT id, record_json FROM mirrored_events WHERE record_json LIKE '%\"jsonl_status\":\"pending\"%' OR record_json LIKE '%\"jsonl_status\":\"write_failed\"%'")
      .all() as Array<{ id: string; record_json: string }>

    for (const row of rows) {
      const record = parseJsonSafely(row.record_json, undefined) as MirroredEventRecord | undefined
      if (!record || (record.jsonl_status !== 'pending' && record.jsonl_status !== 'write_failed')) continue

      const writtenRecord: MirroredEventRecord = { ...record, jsonl_status: 'written' }
      const writtenJson = JSON.stringify(writtenRecord)
      try {
        this.appendJsonlRecord(writtenRecord)
        this.db
          .prepare('UPDATE mirrored_events SET record_json = @record_json WHERE id = @id')
          .run({ id: row.id, record_json: writtenJson })
      } catch (error) {
        console.warn('Could not recover mirrored event JSONL append.', error)
      }
    }
  }

  private appendJsonlRecord(record: MirroredEventRecord): void {
    if (existsSync(this.jsonlPath)) {
      const existing = readFileSync(this.jsonlPath, { encoding: 'utf8' })
      if (existing.includes(`"event_id":"${record.event_id}"`) || existing.includes(`"idempotency_key":"${record.idempotency_key}"`)) {
        return
      }
    }
    appendFileSync(this.jsonlPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
  }

  private ensureColumn(tableName: string, columnName: string, declaration: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
    if (rows.some((row) => row.name === columnName)) return
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${declaration}`)
  }

  private count(tableName: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }
    return row.count
  }
}

function parseJsonSafely(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function pruneRunContext(context?: LocalRunContext): LocalRunContext | undefined {
  if (!context) return undefined
  const pruned = Object.fromEntries(
    Object.entries(context)
      .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])
      .filter(([, value]) => (typeof value === 'string' && value.length > 0) || value === true),
  ) as LocalRunContext

  return Object.keys(pruned).length ? pruned : undefined
}

function clampHistoryLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return 500
  }
  return Math.min(10000, Math.max(25, Math.trunc(limit)))
}
