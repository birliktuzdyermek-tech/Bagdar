"""Живой индекс: сбор сырых показателей из симулятора и история во времени.

Скользящие окна (время модели): пропускная способность — 60 мин, простой —
30 мин, загрузка путей — среднее за 10 мин по срезам каждые 30 с. Средняя
задержка и конфликты — на текущий момент. Точка истории — раз в минуту
модели, она же пишется в журнал событием index_snapshot.
"""
from __future__ import annotations

import bisect
from collections import deque

from bagdar.config import BagdarConfig
from bagdar.index.compute import STATUS_LABEL, score

SAMPLE_S = 30
HISTORY_S = 60
THROUGHPUT_WINDOW_S = 3600
IDLE_WINDOW_S = 1800
LOAD_WINDOW_S = 600
MIN_WINDOW_S = 600
PLANNED_WAIT = ("по плану", "по расписанию", "удержан")
RANK = {"no_data": 0, "norm": 1, "warning": 2, "critical": 3}


class IndexTracker:
    def __init__(self, cfg: BagdarConfig) -> None:
        self.cfg = cfg
        self.engine = None
        self.history: deque[dict] = deque(maxlen=24 * 60)
        self.current: dict | None = None

    def reset(self, engine) -> None:
        self.engine = engine
        self.sched = sorted(sp.arr for tr in engine.trains.values() for sp in tr.schedule[1:] if sp.arr is not None)
        self.samples: deque[tuple[float, float, float, float]] = deque(maxlen=200)
        self.history.clear()
        self.current = None
        self.next_sample = engine.t
        self.next_hist = engine.t
        self.last_status: str | None = None
        self.tracks_total = sum(len(st.tracks) for st in engine.world.stations.values())

    # ------------------------------------------------------------ сырые показатели
    def _load_now(self) -> tuple[float, list[str]]:
        eng = self.engine
        busy_by_station: dict[str, int] = {}
        n = 0
        for tid, t in eng.il.tracks.items():
            if t.occupant or t.reserved:
                n += 1
                sid = tid.split("-")[0]
                busy_by_station[sid] = busy_by_station.get(sid, 0) + 1
        full = []
        for sid, cnt in sorted(busy_by_station.items(), key=lambda x: -x[1]):
            st = eng.world.stations[sid]
            if cnt >= len(st.tracks) and len(full) < 3:
                full.append(f"{st.name} ({cnt}/{len(st.tracks)})")
        return n / max(1, self.tracks_total), full

    def raw(self, conflicts: list[dict]) -> dict[str, dict]:
        eng = self.engine
        now = eng.t
        raw: dict[str, dict] = {}
        # пропускная способность
        w0 = max(eng.start_time, now - THROUGHPUT_WINDOW_S)
        if now - eng.start_time < MIN_WINDOW_S:
            raw["throughput"] = {"missing": "мало данных: с начала прогона меньше 10 мин"}
        else:
            planned = bisect.bisect_right(self.sched, now) - bisect.bisect_left(self.sched, w0)
            passed = bisect.bisect_right(eng.passages, now) - bisect.bisect_left(eng.passages, w0)
            raw["throughput"] = {"passed": passed, "planned": planned, "window_min": (now - w0) / 60}
        # отклонение от графика
        act = eng.active()
        if act:
            delays = sorted(((eng.live_delay(rt), rt.train.number) for rt in act), reverse=True)
            raw["punctuality"] = {"avg_delay_s": sum(d for d, _ in delays) / len(delays),
                                  "worst": [(n, d) for d, n in delays[:2]]}
        else:
            raw["punctuality"] = {"missing": "нет поездов на участке"}
        # загрузка путей: среднее за окно по срезам
        share_now, full = self._load_now()
        loads = [s[3] for s in self.samples if s[0] >= now - LOAD_WINDOW_S] + [share_now]
        raw["track_load"] = {"share": sum(loads) / len(loads), "busiest": full}
        # простой локомотивов и бригад
        base = next((s for s in self.samples if s[0] >= now - IDLE_WINDOW_S), None)
        d_idle = eng.idle_total_s - (base[1] if base else 0.0)
        d_act = eng.active_total_s - (base[2] if base else 0.0)
        if d_act > 0:
            top = sorted(((now - rt.wait_since, rt.train.number) for rt in act if rt.wait_since is not None),
                         reverse=True)[:2]
            raw["resource_idle"] = {"share": d_idle / d_act, "window_min": (now - (base[0] if base else
                                                                                   eng.start_time)) / 60,
                                    "top": [(n, d) for d, n in top]}
        else:
            raw["resource_idle"] = {"missing": "за окно на участке не было поездов"}
        # конфликты маршрутов: прогноз действующего плана + поезда, стоящие сейчас из-за занятого ресурса
        now_c = [rt for rt in act if rt.wait_reason and rt.wait_since is not None and now - rt.wait_since >= 60
                 and not rt.wait_reason.startswith(PLANNED_WAIT)]
        first = None
        if conflicts:
            c = conflicts[0]
            first = f"{c['message']} (через {max(0, round(c['in_s'] / 60))} мин)"
        elif now_c:
            first = f"{now_c[0].train.number}: {now_c[0].wait_reason}"
        raw["conflicts"] = {"count": len(conflicts) + len(now_c), "projected": len(conflicts), "now": len(now_c),
                            "first": first}
        return raw

    # ------------------------------------------------------------------ цикл
    def update(self, conflicts: list[dict]) -> dict:
        eng = self.engine
        now = eng.t
        cur = score(self.cfg.index, self.raw(conflicts), now)
        self.current = cur
        if now >= self.next_sample:
            self.next_sample = now + SAMPLE_S
            share, _ = self._load_now()
            self.samples.append((now, eng.idle_total_s, eng.active_total_s, share))
        if now >= self.next_hist:
            self.next_hist = now + HISTORY_S
            point = {"t": round(now, 1), "value": cur["value"], "status": cur["status"],
                     "f": {f["key"]: f["score"] for f in cur["factors"]}}
            self.history.append(point)
            eng.emit("index_snapshot", "debug",
                     f"Индекс {'—' if cur['value'] is None else round(cur['value'])} ({cur['status_label']})",
                     data=point)
            self._status_event(cur)
        return cur

    def _status_event(self, cur: dict) -> None:
        st = cur["status"]
        if self.last_status is None or st == self.last_status:
            self.last_status = st
            return
        worse = RANK[st] > RANK[self.last_status]
        why = f": {cur['reasons'][0]}" if worse and cur["reasons"] else ""
        self.engine.emit("index_status", "warn" if worse else "info",
                         f"Индекс {STATUS_LABEL[self.last_status]} → {STATUS_LABEL[st]} "
                         f"({'—' if cur['value'] is None else round(cur['value'])}){why}",
                         data={"from": self.last_status, "to": st, "value": cur["value"]})
        self.last_status = st

    def history_since(self, t: float | None = None) -> list[dict]:
        return [p for p in self.history if t is None or p["t"] > t]
