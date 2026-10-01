"""Эталон для копии расчёта «Кто первым?» в витрине: входы и ответы backend/bagdar/meet.py.

python showcase/tools/meet_fixture.py   → showcase/src/meet/fixture.json
Проверка витрины: cd showcase && npm run check:meet. Проверка ядра: backend/tests/test_meet.py.
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from bagdar import meet  # noqa: E402
from bagdar.config import BagdarConfig  # noqa: E402

OUT = ROOT / "showcase" / "src" / "meet" / "fixture.json"
PRESETS = ROOT / "showcase" / "src" / "meet" / "presets.json"


def build(params: dict) -> meet.MeetIn:
    return meet.MeetIn(section_km=params.get("section_km", 12.0), speed_limit_kmh=params.get("speed_limit_kmh", 100.0),
                       gap_min=params.get("gap_min", 0.0), pax=meet.PaxIn(**params.get("pax", {})),
                       freight=meet.FreightIn(**params.get("freight", {})))


def random_params(rng: random.Random) -> dict:
    return {
        "section_km": rng.choice([4, 6, 9, 12, 15, 20, 30]),
        "speed_limit_kmh": rng.choice([60, 80, 100, 120, 160]),
        "gap_min": round(rng.uniform(-15, 15), 1),
        "pax": {"cls": rng.choice(meet.PAX_CLASSES), "passengers": rng.choice([0, 40, 150, 300, 600, 900, 1400]),
                "delay_min": rng.choice([0, 0, 4, 12, 35]), "slack_min": rng.choice([0, 3, 8]),
                "dwell_min": rng.choice([0, 0, 2, 6]), "transfer": rng.random() < 0.3,
                "trip_left_h": rng.choice([1, 3, 8])},
        "freight": {"cls": rng.choice(meet.FREIGHT_CLASSES), "mass_t": rng.choice([1500, 3000, 5000, 7000, 9000]),
                    "cargo": rng.sample(list(meet.CARGO), rng.randint(0, 2)),
                    "delay_min": rng.choice([0, 0, 25, 90]), "slack_min": rng.choice([0, 10, 20, 60]),
                    "uphill": rng.random() < 0.4, "crew_left_h": rng.choice([1, 2.5, 6, 10]),
                    "trip_left_h": rng.choice([2, 4, 12])},
    }


def cases() -> list[dict]:
    rng = random.Random(7)
    out = [{"name": p["id"], "params": p["params"]} for p in json.loads(PRESETS.read_text(encoding="utf-8"))]
    out += [{"name": f"random-{i}", "params": random_params(rng)} for i in range(40)]
    out.append({"name": "not-strict", "params": {"pax": {"cls": "passenger", "passengers": 40}}, "pte_strict": False})
    return out


def compute(case: dict) -> dict:
    cfg = BagdarConfig()
    cfg.pte_strict = case.get("pte_strict", True)
    return meet.compare(build(case["params"]), cfg)


def main() -> None:
    data = {"config": "BagdarConfig() по умолчанию (как config/default.yaml)",
            "cases": [{**c, "result": compute(c)} for c in cases()]}
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(data['cases'])} случаев → {OUT}")


if __name__ == "__main__":
    main()
