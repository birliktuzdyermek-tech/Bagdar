"""Журнал прогона и перемотка.

Журнал неизменяемый: события, применённые планы и снимки состояния только
дописываются. Снимок — полное состояние для экрана (поезда, ресурсы, индекс,
планировщик, конфликты, сбои) раз в SNAP_S секунд модели. Перемотка берёт
последний снимок не позже момента t и план, действовавший в t, поэтому схема,
графики, индекс и лента показывают согласованное прошлое.

Хранение: последние KEEP_S секунд модели — в памяти (для перемотки без диска),
всё — в SQLite (`BAGDAR_HISTORY_DB`, по умолчанию в памяти процесса). Запись на
диск пакетами, раз в секунду реального времени.
"""
from __future__ import annotations

import bisect
import json
import os
import sqlite3
import threading
import time
import zlib
from collections import deque

SNAP_S = 10.0            # снимок раз в 10 с модели
KEEP_S = 90 * 60         # в памяти — последние 90 мин модели
FLUSH_S = 1.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, scenario TEXT, seed INTEGER, t0 REAL, created REAL);
CREATE TABLE IF NOT EXISTS events (run_id TEXT, seq INTEGER, t REAL, kind TEXT, severity TEXT, message TEXT,
                                   train_id TEXT, station_id TEXT, section_id TEXT, data TEXT,
                                   PRIMARY KEY (run_id, seq));
CREATE TABLE IF NOT EXISTS snapshots (run_id TEXT, t REAL, state BLOB, PRIMARY KEY (run_id, t));
CREATE TABLE IF NOT EXISTS plans (run_id TEXT, version INTEGER, t REAL, plan BLOB, PRIMARY KEY (run_id, version));
"""


def _pack(obj) -> bytes:
    return zlib.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 6)


def _unpack(blob: bytes):
    return json.loads(zlib.decompress(blob).decode("utf-8"))


class History:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.environ.get("BAGDAR_HISTORY_DB", ":memory:")
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()
        self.run_id = ""
        self._reset_memory()

    def _reset_memory(self) -> None:
        self.snaps: deque[dict] = deque()          # {"t", "state"}
        self.snap_t: deque[float] = deque()
        self.plans: list[tuple[float, object, dict]] = []   # (t применения, Plan, dto)
        self.next_t = -1e18
        self._pending: list[tuple[str, tuple]] = []
        self._last_flush = time.monotonic()

    # ------------------------------------------------------------ запись
    def start_run(self, run_id: str, scenario: str, seed: int, t0: float) -> None:
        self.flush()
        self.run_id = run_id
        self._reset_memory()
        self.next_t = t0
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?)", (run_id, scenario, seed, t0, time.time()))
            self.db.commit()

    def add_events(self, events) -> None:
        for e in events:
            d = e.to_dict() if hasattr(e, "to_dict") else e
            self._pending.append(("INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?,?,?,?)",
                                  (self.run_id, d["seq"], d["t"], d["kind"], d["severity"], d["message"],
                                   d.get("train_id"), d.get("station_id"), d.get("section_id"),
                                   json.dumps(d.get("data") or {}, ensure_ascii=False))))

    def add_plan(self, t: float, plan, dto: dict) -> None:
        self.plans.append((t, plan, dto))
        self._trim(t)
        self._pending.append(("INSERT OR REPLACE INTO plans VALUES (?,?,?,?)",
                              (self.run_id, dto["version"], t, _pack(dto))))

    def maybe_snapshot(self, t: float, make_state) -> None:
        if t + 1e-6 < self.next_t:
            return
        self.next_t = t + SNAP_S
        state = make_state()
        self.snaps.append({"t": t, "state": state})
        self.snap_t.append(t)
        self._trim(t)
        self._pending.append(("INSERT OR REPLACE INTO snapshots VALUES (?,?,?)", (self.run_id, t, _pack(state))))

    def _trim(self, now: float) -> None:
        while self.snap_t and self.snap_t[0] < now - KEEP_S:
            self.snap_t.popleft()
            self.snaps.popleft()
        # план, действовавший на начало окна, оставляем — он нужен для перемотки к краю
        while len(self.plans) > 1 and self.plans[1][0] < now - KEEP_S:
            self.plans.pop(0)

    def flush(self, force: bool = True) -> None:
        if not self._pending or (not force and time.monotonic() - self._last_flush < FLUSH_S):
            return
        batch, self._pending = self._pending, []
        with self.lock:
            for sql, args in batch:
                self.db.execute(sql, args)
            self.db.commit()
        self._last_flush = time.monotonic()

    # ------------------------------------------------------------ чтение
    def window(self) -> tuple[float, float] | None:
        if not self.snap_t:
            return None
        return self.snap_t[0], self.snap_t[-1]

    def snapshot_at(self, t: float) -> dict | None:
        if not self.snap_t:
            return None
        i = bisect.bisect_right(list(self.snap_t), t + 1e-6) - 1
        return self.snaps[max(0, i)]

    def plan_at(self, t: float) -> tuple[object | None, object | None, dict | None]:
        """(действовавший в t план, предыдущий, dto действовавшего)."""
        cur = prev = None
        dto = None
        for ta, plan, d in self.plans:
            if ta <= t + 1e-6:
                prev, cur, dto = cur, plan, d
            else:
                break
        return cur, prev, dto

    def events_db(self, run_id: str | None = None) -> list[dict]:
        self.flush()
        with self.lock:
            rows = self.db.execute("SELECT seq, t, kind, severity, message, train_id, station_id, section_id, data "
                                   "FROM events WHERE run_id=? ORDER BY seq", (run_id or self.run_id,)).fetchall()
        return [{"seq": r[0], "t": r[1], "kind": r[2], "severity": r[3], "message": r[4], "train_id": r[5],
                 "station_id": r[6], "section_id": r[7], "data": json.loads(r[8] or "{}")} for r in rows]

    def stats(self) -> dict:
        self.flush()
        with self.lock:
            n = {tbl: self.db.execute(f"SELECT COUNT(*) FROM {tbl} WHERE run_id=?", (self.run_id,)).fetchone()[0]
                 for tbl in ("events", "snapshots", "plans")}
        w = self.window()
        return {"path": self.path, "run_id": self.run_id, **n, "memory_snapshots": len(self.snaps),
                "window": None if w is None else {"from": round(w[0], 1), "to": round(w[1], 1)}}
