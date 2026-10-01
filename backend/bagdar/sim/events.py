"""События симуляции. Каждое событие неизменяемо после записи в журнал."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

Severity = Literal["debug", "info", "warn", "critical"]


@dataclass(slots=True)
class SimEvent:
    seq: int
    t: float
    kind: str
    severity: Severity
    message: str
    train_id: str | None = None
    station_id: str | None = None
    section_id: str | None = None
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "seq": self.seq, "t": round(self.t, 1), "kind": self.kind, "severity": self.severity,
            "message": self.message, "train_id": self.train_id, "station_id": self.station_id,
            "section_id": self.section_id, "data": self.data,
        }
