import json
import os
import sqlite3
from pathlib import Path


def main() -> None:
    user_data = Path(os.environ["SPORESCOUT_HISTORY_SMOKE_USER_DATA"])
    package_json = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text(encoding="utf-8"))
    app_version = str(package_json["version"])
    data_dir = user_data / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    db_path = data_dir / "cartridge-subassembly.sqlite"

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
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
            )
            """
        )

        data = {
            "cart": "SS-SA-007-030-0169",
            "run": "history-smoke-run-1",
            "g": "RESEAT_AND_REPEAT_BORDERLINE",
            "status": "PASS",
            "o": {
                "cnt": 30,
                "cv": 0.008,
                "min": 13.9,
                "max": 14.4,
                "med": 14.1,
                "raw": 14.12,
                "sd": 0.12,
                "slpm": 14.1,
                "q": True,
                "trim_cnt": 24,
            },
            "n": {
                "cnt": 30,
                "cv": 0.007,
                "min": 12.2,
                "max": 12.7,
                "med": 12.5,
                "raw": 12.49,
                "sd": 0.09,
                "slpm": 12.5,
                "q": True,
                "trim_cnt": 24,
            },
            "s": {
                "cnt": 30,
                "cv": 0.015,
                "min": 3.70,
                "max": 3.92,
                "med": 3.82,
                "raw": 3.83,
                "sd": 0.05,
                "slpm": 3.827,
                "q": True,
                "trim_cnt": 24,
            },
            "r": {"so": 0.271502, "valid": True},
            "fix": "SS-P-001-010-0085",
            "noz": "NOZL-0001",
            "seal": "SEAL-0001",
            "prof_ver": "phase1-characterization.v2",
        }
        record = {
            "event_id": "history-smoke-event-1",
            "idempotency_key": "history-smoke-event-1",
            "event_name": "dd_cartridge_air_leak_summary",
            "data": data,
            "local_timestamp": "2026-05-12T04:00:00.000Z",
            "run_uid": data["run"],
            "cartridge_serial": data["cart"],
            "station_id": "STATION-001",
            "operator": "Harry Blake",
            "batch": "P1-STAGE-2026-05",
            "tester_device_serial": "SS-A-001-101A-0122",
            "enclosure_base_id": data["fix"],
            "nozzle_id": data["noz"],
            "seal_fixture_id": data["seal"],
            "workflow": "cartridge_subassembly",
            "app_version": app_version,
            "upload_status": "local_only",
        }
        conn.execute(
            """
            INSERT OR REPLACE INTO mirrored_events
              (id, event_name, data_json, record_json, run_uid, cartridge_serial, workflow, app_version, created_at, upload_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record["event_id"],
                record["event_name"],
                json.dumps(data, separators=(",", ":")),
                json.dumps(record, separators=(",", ":")),
                record["run_uid"],
                record["cartridge_serial"],
                record["workflow"],
                record["app_version"],
                record["local_timestamp"],
                record["upload_status"],
            ),
        )
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
