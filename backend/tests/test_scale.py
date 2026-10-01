"""Замер пересчёта на 20 и 100 поездах (1 и 6 зон). 1 000 поездов — scripts/bench_scale.py."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from bench_scale import plan_zone, run  # noqa: E402


def test_zone_replan_20_trains_is_valid_and_timed():
    r = plan_zone((1000, "cpsat", 1.0))
    assert r["valid"] and r["active"] >= 12 and 0 < r["ms"] < 10_000


def test_six_zones_100_trains_in_parallel():
    r = run(6, "greedy", workers=2, limit=1.0)
    assert r["valid"] and r["trains"] >= 80 and r["zone_max_ms"] < 5_000
    assert r["pairs"] == r["trains"] * (r["trains"] - 1) // 2
