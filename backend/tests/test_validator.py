import copy

from bagdar.validator import validate_plan


def _trains(tt):
    return {t.id: t for t in tt.trains}


def test_validator_catches_opposing_trains_on_single_track(light42, rules):
    world, tt = light42
    plan = copy.deepcopy(tt.plan)
    single = {s.id for s in world.sections.values() if s.tracks == 1}
    legs = [lg for lg in plan.all_legs() if lg.section_id in single]
    a = legs[0]
    b = next(lg for lg in legs if lg.section_id == a.section_id and lg.direction != a.direction)
    shift = a.dep - b.dep + 30
    for lg in plan.legs[b.train_id]:
        lg.dep += shift
        lg.arr += shift
    kinds = {v.kind for v in validate_plan(world, _trains(tt), plan, rules)}
    assert "section" in kinds


def test_validator_catches_short_track(light42, rules):
    world, tt = light42
    plan = copy.deepcopy(tt.plan)
    trains = _trains(tt)
    for tid, legs in plan.legs.items():
        tr = trains[tid]
        for lg in legs:
            st = world.stations[lg.to_id]
            short = [t for t in st.tracks if t.length_m < tr.length_m]
            if short:
                lg.track_id = short[0].id
                vs = validate_plan(world, trains, plan, rules)
                assert any(v.kind == "track_length" for v in vs)
                return
    raise AssertionError("не нашли станцию с коротким путём")


def test_validator_catches_track_double_booking(light42, rules):
    world, tt = light42
    plan = copy.deepcopy(tt.plan)
    trains = _trains(tt)
    # два поезда, одновременно стоящие на станции (скрещение), ставим на один путь
    stays = {}
    for tid, legs in plan.legs.items():
        for lg, nxt in zip(legs, legs[1:]):
            if nxt.dep - lg.arr > 60:
                stays.setdefault(lg.to_id, []).append((lg.arr, nxt.dep, lg))
    for st_id, items in stays.items():
        for i, (a0, a1, x) in enumerate(items):
            for b0, b1, y in items[i + 1:]:
                fits = trains[y.train_id].length_m <= world.stations[st_id].track(x.track_id).length_m
                if x.train_id != y.train_id and a0 < b1 and b0 < a1 and fits:
                    y.track_id = x.track_id
                    kinds = {v.kind for v in validate_plan(world, trains, plan, rules)}
                    assert "track" in kinds
                    return
    raise AssertionError("не нашли пару поездов для проверки")


def test_validator_catches_throat_conflict(light42, rules):
    world, tt = light42
    plan = copy.deepcopy(tt.plan)
    trains = _trains(tt)
    # прибытие второго поезда переносим в окно прибытия первого через ту же горловину
    double = {s.id for s in world.sections.values() if s.tracks == 2}
    legs = [lg for lg in plan.all_legs() if lg.section_id in double]
    for x in legs:
        y = next((lg for lg in legs if lg.section_id == x.section_id and lg.direction == x.direction
                  and lg.train_id != x.train_id), None)
        if y is None:
            continue
        shift = x.arr - y.arr + 20
        for lg in plan.legs[y.train_id]:
            lg.dep += shift
            lg.arr += shift
        kinds = {v.kind for v in validate_plan(world, trains, plan, rules)}
        assert "throat" in kinds or "headway" in kinds
        return
    raise AssertionError("не нашли пару")


def test_validator_catches_loco_conflict(light42, rules):
    world, tt = light42
    trains = copy.deepcopy(_trains(tt))
    ids = list(tt.plan.legs)
    # одному локомотиву назначены два поезда, идущих одновременно
    a = ids[0]
    b = next(t for t in ids[1:] if tt.plan.legs[t][0].dep < tt.plan.legs[a][-1].arr
             and tt.plan.legs[t][-1].arr > tt.plan.legs[a][0].dep)
    trains[b].loco_id = trains[a].loco_id
    kinds = {v.kind for v in validate_plan(world, trains, tt.plan, rules)}
    assert "loco" in kinds


def test_valid_plan_has_no_violations(light42, rules):
    world, tt = light42
    assert validate_plan(world, _trains(tt), tt.plan, rules) == []
