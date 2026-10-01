import math

from bagdar.core.kinematics import effective_vmax, run_time, stop_energy_kwh


def test_run_time_trapezoid_matches_formula():
    v, a, b, L = 20.0, 0.2, 0.4, 10_000.0
    t = run_time(L, v, a, b, True, True)
    expected = L / v + v / (2 * a) + v / (2 * b)
    assert math.isclose(t, expected, rel_tol=1e-9)


def test_run_time_pass_through_is_fastest():
    assert run_time(8000, 25, 0.3, 0.5, False, False) < run_time(8000, 25, 0.3, 0.5, True, False) \
        < run_time(8000, 25, 0.3, 0.5, True, True)


def test_run_time_short_section_triangle():
    t = run_time(200, 30, 0.3, 0.5, True, True)
    vp = math.sqrt(200 / (1 / 0.6 + 1 / 1.0))
    assert math.isclose(t, vp / 0.3 + vp / 0.5, rel_tol=1e-9)


def test_stop_energy_matches_spec_examples():
    # BAGDAR.md, раздел 6: грузовой 6000 т на 60 км/ч ≈ 230 кВт·ч, пассажирский 1000 т на 100 км/ч ≈ 107
    assert abs(stop_energy_kwh(6000, 60 / 3.6) - 231) < 3
    assert abs(stop_energy_kwh(1000, 100 / 3.6) - 107) < 2


def test_vmax_never_above_limits():
    for limit in (60, 80, 120):
        for restr in (None, 40):
            v = effective_vmax(160, limit, 3.0, 5000, restr) * 3.6
            assert v <= limit + 1e-9
            if restr:
                assert v <= restr + 1e-9
