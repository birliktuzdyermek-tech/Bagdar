"""Уровни автономии: отмена B, выбор C, закрепление решения диспетчера."""
import pytest

from bagdar.planner.runner import ActionError
from bagdar.runtime import SimulationRuntime
from bagdar.scenarios import load_scenarios
from bagdar.validator import validate_plan


@pytest.fixture(scope="module")
def rt(cfg):
    c = cfg.model_copy(deep=True)
    c.solver.time_limit_s = 1.0
    r = SimulationRuntime(c, load_scenarios(), planner_sync=True)
    r.load("normal", 42)
    r._advance_steps(1800)
    return r


def _delay_until(rt, pred, attempts=8):
    for i in range(attempts):
        if pred():
            return True
        pax = [x.train.id for x in rt.engine.active() if x.train.pte_rank <= 3 and x.status == "section"]
        rt.external_event("train_delay", {"train_id": pax[i % len(pax)], "minutes": 15 + 5 * (i % 3)})
        if pred():
            return True
        rt._advance_steps(300)
        rt.planner.tick()
    return pred()


def _open_cancel(rt):
    return next((c for c in reversed(rt.planner.cards) if c["can_cancel"]), None)


def _valid_now(rt):
    eng = rt.engine
    return validate_plan(eng.world, eng.trains, rt.planner.current, eng.rules, since=eng.t)


def test_cancel_b_restores_order_and_next_replan_respects_it(rt):
    P = rt.planner
    assert _delay_until(rt, lambda: _open_cancel(rt) is not None)
    # отмена либо восстанавливает прежний порядок, либо честно отказывает с причиной
    card = msg = None
    refused = []
    for c in [c for c in reversed(P.cards) if c["can_cancel"]]:
        ctx = P.ctl[c["id"]].ctx
        v0 = P.version
        try:
            msg = rt.decision_action(c["id"], "cancel")
        except ActionError as e:
            refused.append(str(e))
            assert "Отмена невозможна" in str(e) or "Поздно" in str(e)
            continue
        card = c
        break
    assert card is not None, f"ни одна отмена не прошла: {refused}"
    assert card["status"] == "cancelled" and not card["can_cancel"], msg
    pair = frozenset((ctx.first, ctx.second))
    if P.version > v0:                       # прежний порядок восстановлен новым планом
        assert P.current.solver == "dispatcher"
        a, b = P.current.leg(*ctx.first), P.current.leg(*ctx.second)
        assert b.dep < a.dep, "после отмены первым идёт второй поезд пары"
    assert P.overrides.get(pair) == ctx.second
    assert not _valid_now(rt), "план после отмены проходит независимую проверку"
    P.request("тест: пересчёт после отмены", urgent=True)
    P.tick()
    a, b = P.current.leg(*ctx.first), P.current.leg(*ctx.second)
    ent = rt.engine.entered
    if a and b and ctx.first not in ent and ctx.second not in ent:
        assert b.dep < a.dep, "пересчёт не переворачивает решение диспетчера"
    with pytest.raises(ActionError):
        rt.decision_action(card["id"], "cancel")


def test_cancel_window_closes(rt):
    P = rt.planner
    assert _delay_until(rt, lambda: _open_cancel(rt) is not None)
    card = _open_cancel(rt)
    P.advance_windows(rt.cfg.autonomy.b_cancel_s + 1)
    assert not card["can_cancel"]
    with pytest.raises(ActionError):
        rt.decision_action(card["id"], "cancel")


def test_c_waits_for_choice_without_full_auto(rt):
    P = rt.planner
    rt.set_autonomy(False)
    try:
        assert _delay_until(rt, lambda: P.proposal is not None), "должна появиться карточка C"
        s = P.summary()
        assert s["awaiting_choice"] and s["applied_version"] < s["version"], "план C не применяется сам"
        card = next(c for c in P.cards if c["status"] == "pending")
        assert len(card["variants"]) >= 2 and card["variants"][0]["id"] == "v1"
        assert all("J" in v and "late_pax" in v for v in card["variants"])
        alt = next((v for v in card["variants"][1:] if v["valid"]), card["variants"][0])
        rt.decision_action(card["id"], "choose", alt["id"])
        s = P.summary()
        assert card["status"] == "chosen" and card["chosen_variant"] == alt["id"]
        assert not s["awaiting_choice"] and s["applied_version"] == s["version"]
        assert not [c for c in P.cards if c["status"] == "pending"]
        assert not _valid_now(rt)
    finally:
        rt.set_autonomy(True)


def test_unknown_card_action_rejected(rt):
    with pytest.raises(ActionError):
        rt.decision_action("d-9999-9", "cancel")
