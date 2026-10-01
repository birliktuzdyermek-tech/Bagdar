"""Правила занятия ресурсов (слой 0). Общие для генератора графика,
планировщика и симулятора; валидатор реализует их независимо."""
from __future__ import annotations

from dataclasses import dataclass

from bagdar.config import SimConfig


@dataclass(frozen=True, slots=True)
class TimingRules:
    tau_cross_s: float
    headway_s: float
    headway_arr_s: float
    throat_s: float
    approach_s: float
    clear_s: float
    prep_s: float
    terminate_s: float
    min_stop_s: float
    recovery_margin: float
    max_wait_s: float

    @classmethod
    def from_config(cls, sim: SimConfig) -> "TimingRules":
        return cls(
            tau_cross_s=sim.tau_cross_s,
            headway_s=sim.headway_s,
            headway_arr_s=sim.headway_arr_s,
            throat_s=sim.throat_s,
            approach_s=sim.approach_s,
            clear_s=sim.clear_s,
            prep_s=sim.prep_s,
            terminate_s=sim.terminate_s,
            min_stop_s=sim.min_stop_s,
            recovery_margin=sim.recovery_margin,
            max_wait_s=sim.max_wait_s,
        )

    def track_hold_start(self, single_track_leg: bool, t_in: float, t_out: float) -> float:
        """С какого момента путь приёма закреплён за поездом.

        Перед впуском на однопутный перегон путь приёма на следующей станции
        резервируется сразу при отправлении (защита от «замка»). На двухпутном
        перегоне маршрут приёма задаётся при подходе.
        """
        return t_in if single_track_leg else t_out - self.approach_s
