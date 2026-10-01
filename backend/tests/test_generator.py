from bagdar.generator.world_gen import generate_world
from bagdar.validator import validate_plan

from conftest import build


def test_world_is_deterministic_by_seed():
    a, b, c = generate_world("light", 42), generate_world("light", 42), generate_world("light", 43)
    sig = lambda w: [(s.id, s.name, s.km, [(t.id, t.length_m) for t in s.tracks]) for s in w.stations.values()]
    assert sig(a) == sig(b)
    assert sig(a) != sig(c)


def test_light_world_shape():
    w = generate_world("light", 42)
    assert len(w.stations) == 20
    assert len(w.sections) == 19
    single = sum(1 for s in w.sections.values() if s.tracks == 1)
    double = sum(1 for s in w.sections.values() if s.tracks == 2)
    assert single > double > 0, "однопутные перегоны с двухпутными вставками"
    for st in w.stations.values():
        main = [t for t in st.tracks if t.is_main]
        assert len(main) == 1 and main[0].length_m >= 1100, "главный путь принимает самый длинный поезд"


def test_timetable_is_deterministic(cfg):
    _, a = build(7, cfg)
    _, b = build(7, cfg)
    assert [(t.id, t.origin_dep, t.final_arr) for t in a.trains] == [(t.id, t.origin_dep, t.final_arr) for t in b.trains]


def test_timetable_conflict_free_for_many_seeds(cfg, rules):
    for seed in (1, 7, 42, 2026, 99):
        world, tt = build(seed, cfg)
        assert len(tt.trains) >= 70
        violations = validate_plan(world, {t.id: t for t in tt.trains}, tt.plan, rules)
        assert violations == [], violations[:3]


def test_long_trains_only_on_fitting_tracks(light42):
    world, tt = light42
    for tr in tt.trains:
        for stop in tr.schedule:
            track = world.stations[stop.station_id].track(stop.track_id)
            assert track.length_m >= tr.length_m


def test_simultaneous_trains_about_twenty(light42):
    _, tt = light42
    counts = [sum(1 for tr in tt.trains if tr.origin_dep - 600 <= T <= tr.final_arr + 600)
              for T in range(6 * 3600, 12 * 3600 + 1, 1800)]
    assert 14 <= sum(counts) / len(counts) <= 26
