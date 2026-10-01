import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bagdar.config import load_config, parse_hhmm  # noqa: E402
from bagdar.core.rules import TimingRules  # noqa: E402
from bagdar.generator.timetable import TimetableBuilder  # noqa: E402
from bagdar.generator.trains_gen import generate_traffic  # noqa: E402
from bagdar.generator.world_gen import generate_world  # noqa: E402


@pytest.fixture(scope="session")
def cfg():
    return load_config()


@pytest.fixture(scope="session")
def rules(cfg):
    return TimingRules.from_config(cfg.sim)


def build(seed: int, cfg):
    rules = TimingRules.from_config(cfg.sim)
    world = generate_world("light", seed)
    tt = TimetableBuilder(world, rules).build(generate_traffic(world, seed))
    return world, tt


@pytest.fixture(scope="session")
def light42(cfg):
    return build(42, cfg)


START = parse_hhmm("06:00")
