from bagdar.sim.engine import Engine
from bagdar.sim.interlocking import Interlocking

from conftest import START, build


def _snapshot(eng):
    return [(tid, rt.status, rt.k, round(rt.dist, 3), round(rt.v, 4), rt.track_id, round(eng.live_delay(rt)))
            for tid, rt in eng.rt.items()]


def test_same_seed_same_run(cfg):
    w1, tt1 = build(42, cfg)
    w2, tt2 = build(42, cfg)
    e1 = Engine(w1, tt1.trains, tt1.plan, cfg, 42, START)
    e2 = Engine(w2, tt2.trains, tt2.plan, cfg, 42, START)
    e1.advance(2 * 3600)
    e2.advance(2 * 3600)
    assert _snapshot(e1) == _snapshot(e2)
    assert [(e.kind, e.t, e.message) for e in e1.drain_events()] == \
           [(e.kind, e.t, e.message) for e in e2.drain_events()]


def test_different_seed_differs(cfg):
    w1, tt1 = build(42, cfg)
    w2, tt2 = build(43, cfg)
    e1 = Engine(w1, tt1.trains, tt1.plan, cfg, 42, START)
    e2 = Engine(w2, tt2.trains, tt2.plan, cfg, 43, START)
    e1.advance(1800)
    e2.advance(1800)
    assert _snapshot(e1) != _snapshot(e2)


def test_six_hours_without_deadlock(cfg, light42):
    world, tt = light42
    eng = Engine(world, tt.trains, tt.plan, cfg, 42, START)
    finished0 = len(eng.gone)
    worst_wait = 0.0
    for _ in range(36):
        eng.advance(600)
        for rt in eng.active():
            if rt.wait_since is not None:
                worst_wait = max(worst_wait, eng.t - rt.wait_since)
        m = eng.metrics()
        assert 8 <= m["active_trains"] <= 30
    assert len(eng.gone) - finished0 >= 15, "поезда проходят участок"
    assert worst_wait < 45 * 60, "никто не стоит бесконечно"


def test_safety_invariants_hold_every_step(cfg, light42):
    world, tt = light42
    eng = Engine(world, tt.trains, tt.plan, cfg, 42, START)
    for _ in range(3 * 3600):
        eng.step()
        for sid, s in eng.il.sections.items():
            if s.single and s.occupants:
                assert len({s.dirs[o] for o in s.occupants}) == 1, f"встречные на {sid}"
            if world.sections[sid].signalling == "PAB":
                for d in (1, -1):
                    assert sum(1 for o in s.occupants if s.dirs[o] == d) <= 1
        occupied = {}
        for rt in eng.active():
            if rt.status == "station":
                assert rt.track_id not in occupied, "два поезда на одном пути"
                occupied[rt.track_id] = rt.train.id
                track = world.stations[rt.train.route[rt.k]].track(rt.track_id)
                assert track.length_m >= rt.train.length_m


def test_interlocking_blocks_opposing_entry(cfg, rules, light42):
    world, _ = light42
    il = Interlocking(world, rules)
    sec = next(s for s in world.sections.values() if s.tracks == 1)
    il.enter_section(sec.id, 1, "A", 0.0)
    reason = il.entry_block_reason(sec.id, -1, "B", 10.0, lambda o: 100.0, lambda o: 500, lambda o: o)
    assert reason and "встречный" in reason


def test_interlocking_throat_one_route_at_a_time(rules, light42):
    world, _ = light42
    il = Interlocking(world, rules)
    th = next(iter(il.throats))
    il.lock_throat(th, "A", 100.0)
    assert not il.throat_free(th, "B", 50.0)
    assert il.throat_free(th, "A", 50.0)
    assert il.throat_free(th, "B", 100.0)


def test_interlocking_rejects_long_train_on_short_track(rules, light42):
    world, _ = light42
    il = Interlocking(world, rules)
    st = next(s for s in world.stations.values()
              if s.kind == "loop" and len(s.tracks) == 2 and s.tracks[1].length_m < 900)
    main, siding = st.tracks[0], st.tracks[1]
    il.occupy_track(main.id, "X")
    assert il.pick_track(st.id, "L", siding.length_m + 100, 0.0, None, prefer_main=True) is None
    assert il.pick_track(st.id, "S", siding.length_m - 50, 0.0, None, prefer_main=True) == siding.id
