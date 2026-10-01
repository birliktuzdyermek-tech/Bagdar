"""Слой безопасности симулятора (аналог СЦБ в модели).

Не даёт выполнить ни одного небезопасного движения, какой бы план ни был:
встречные на однопутном перегоне исключены, попутные идут с интервалом,
поезд принимается только на свободный путь подходящей длины, горловина
пропускает один маршрут за раз, закрытый перегон недоступен.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from bagdar.core.rules import TimingRules
from bagdar.models.world import Section, Track, World

NEG_INF = -1e18
POS_INF = 1e18


@dataclass(slots=True)
class SectionRT:
    sec: Section
    occupants: list[str] = field(default_factory=list)
    dirs: dict[str, int] = field(default_factory=dict)
    last_entry: dict[int, float] = field(default_factory=lambda: {1: NEG_INF, -1: NEG_INF})
    last_exit: dict[int, float] = field(default_factory=lambda: {1: NEG_INF, -1: NEG_INF})
    status: str = "open"                 # open | restricted | closed
    restriction_kmh: float | None = None
    headway_factor: float = 1.0
    open_tracks: int = 0

    def __post_init__(self) -> None:
        self.open_tracks = self.sec.tracks

    @property
    def single(self) -> bool:
        return self.sec.tracks == 1 or self.open_tracks < 2


@dataclass(slots=True)
class TrackRT:
    track: Track
    station_id: str
    occupant: str | None = None
    reserved: str | None = None
    busy_until: float = NEG_INF
    available: bool = True

    def free_for(self, train_id: str, now: float) -> bool:
        return (self.available and self.occupant is None and self.busy_until <= now
                and (self.reserved is None or self.reserved == train_id))


@dataclass(slots=True)
class ThroatRT:
    holder: str | None = None
    busy_until: float = NEG_INF

    def free_for(self, train_id: str, now: float) -> bool:
        return self.busy_until <= now or self.holder == train_id


@dataclass(slots=True)
class SignalRT:
    fault: bool = False
    open_until: float = NEG_INF

    def state(self, now: float) -> str:
        if self.fault:
            return "fault"
        return "open" if self.open_until > now else "closed"


class Interlocking:
    def __init__(self, world: World, rules: TimingRules) -> None:
        self.world = world
        self.r = rules
        self.sections = {sid: SectionRT(sec) for sid, sec in world.sections.items()}
        self.tracks: dict[str, TrackRT] = {}
        self.station_tracks: dict[str, list[TrackRT]] = {}
        for st in world.stations.values():
            lst = [TrackRT(t, st.id) for t in st.tracks]
            self.station_tracks[st.id] = lst
            for trt in lst:
                self.tracks[trt.track.id] = trt
        self.throats: dict[str, ThroatRT] = {}
        for sec in world.sections.values():
            self.throats.setdefault(sec.throat_a, ThroatRT())
            self.throats.setdefault(sec.throat_b, ThroatRT())
        for st in world.stations.values():
            self.throats.setdefault(f"{st.id}:A", ThroatRT())
            self.throats.setdefault(f"{st.id}:B", ThroatRT())
        self.signals = {sig_id: SignalRT() for sig_id in world.signals}

    # --- перегоны ---
    def entry_block_reason(self, sec_id: str, d: int, train_id: str, now: float,
                           dist_of, length_of, number_of) -> str | None:
        """Причина, по которой нельзя впустить поезд на перегон, или None."""
        s = self.sections[sec_id]
        if s.status == "closed":
            return f"перегон {sec_id} закрыт"
        if train_id in s.dirs:
            return None
        if s.single:
            for o in s.occupants:
                if s.dirs[o] != d:
                    return f"на однопутном перегоне встречный {number_of(o)}"
            if now < s.last_exit[-d] + self.r.tau_cross_s:
                return "выдерживается интервал скрещения"
        same = [o for o in s.occupants if s.dirs[o] == d]
        if same:
            leader = same[-1]
            sig = self.signals.get(self.world.exit_signal(sec_id, d))
            if s.sec.signalling == "PAB" or (sig is not None and sig.fault):
                return f"перегон занят попутным {number_of(leader)} (ПАБ)"
            if now < s.last_entry[d] + self.r.headway_s * s.headway_factor:
                return f"межпоездной интервал за {number_of(leader)}"
            block_len = s.sec.length_m / max(1, s.sec.blocks)
            if dist_of(leader) < length_of(leader) + 2 * block_len:
                return f"попутный {number_of(leader)} не освободил блок-участки"
        return None

    def enter_section(self, sec_id: str, d: int, train_id: str, now: float) -> None:
        s = self.sections[sec_id]
        if train_id not in s.dirs:
            s.occupants.append(train_id)
            s.dirs[train_id] = d
            s.last_entry[d] = now

    def exit_section(self, sec_id: str, train_id: str, now: float) -> None:
        s = self.sections[sec_id]
        d = s.dirs.pop(train_id, None)
        if d is not None:
            s.occupants.remove(train_id)
            s.last_exit[d] = now

    def leader_ahead(self, sec_id: str, train_id: str) -> str | None:
        s = self.sections[sec_id]
        d = s.dirs.get(train_id)
        prev = None
        for o in s.occupants:
            if o == train_id:
                return prev
            if s.dirs[o] == d:
                prev = o
        return None

    # --- пути ---
    def pick_track(self, station_id: str, train_id: str, length_m: int, now: float,
                   planned: str | None, prefer_main: bool) -> str | None:
        tracks = self.station_tracks[station_id]
        if planned:
            trt = self.tracks.get(planned)
            if trt is not None and trt.track.length_m >= length_m and trt.free_for(train_id, now):
                return planned
        cands = [t for t in tracks if t.track.length_m >= length_m and t.free_for(train_id, now)]
        if not cands:
            return None
        cands.sort(key=lambda t: (0 if t.track.is_main == prefer_main else 1, t.track.length_m))
        return cands[0].track.id

    def reserve_track(self, track_id: str, train_id: str) -> None:
        self.tracks[track_id].reserved = train_id

    def occupy_track(self, track_id: str, train_id: str) -> None:
        trt = self.tracks[track_id]
        trt.occupant = train_id
        if trt.reserved == train_id:
            trt.reserved = None

    def release_track(self, track_id: str, train_id: str, now: float) -> None:
        trt = self.tracks[track_id]
        if trt.occupant == train_id:
            trt.occupant = None
        if trt.reserved == train_id:
            trt.reserved = None
        trt.busy_until = max(trt.busy_until, now + self.r.clear_s)

    # --- горловины ---
    def throat_free(self, throat_id: str, train_id: str, now: float) -> bool:
        return self.throats[throat_id].free_for(train_id, now)

    def lock_throat(self, throat_id: str, train_id: str, until: float) -> None:
        th = self.throats[throat_id]
        th.holder = train_id
        th.busy_until = until

    def release_throat(self, throat_id: str, train_id: str, now: float, hold_s: float = 0.0) -> None:
        th = self.throats[throat_id]
        if th.holder == train_id:
            th.busy_until = now + hold_s
            if hold_s <= 0:
                th.holder = None

    def open_signal(self, sec_id: str, d: int, until: float) -> None:
        sig = self.signals.get(self.world.exit_signal(sec_id, d))
        if sig is not None:
            sig.open_until = max(sig.open_until, until)
