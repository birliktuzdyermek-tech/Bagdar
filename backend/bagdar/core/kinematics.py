"""Упрощённая кинематика поезда.

Одна и та же модель используется генератором графика, планировщиком и
симулятором, поэтому план исполняется без систематических расхождений.
Это не тяговый расчёт: разгон и торможение с постоянным ускорением,
уклон уменьшает ускорение и равновесную скорость тяжёлых поездов.
"""
from __future__ import annotations

import math

G = 9.81
KMH = 1 / 3.6


def effective_accel(base_accel: float, gradient_permille: float) -> float:
    """Ускорение разгона с поправкой на подъём (уклон в направлении движения)."""
    return max(0.02, base_accel - G * max(0.0, gradient_permille) / 1000.0 * 0.5)


def effective_vmax(train_vmax_kmh: float, speed_limit_kmh: float, gradient_permille: float,
                   mass_t: float, restriction_kmh: float | None = None) -> float:
    """Максимальная скорость на перегоне, м/с."""
    v = min(train_vmax_kmh, speed_limit_kmh)
    if mass_t > 2000 and gradient_permille > 0:
        # тяжёлый поезд на подъёме не держит полную скорость
        v = min(v, train_vmax_kmh - 2.5 * gradient_permille * min(1.5, mass_t / 5000))
    if restriction_kmh is not None:
        v = min(v, restriction_kmh)
    return max(15.0, v) * KMH


def run_time(length_m: float, v: float, accel: float, decel: float,
             stop_start: bool, stop_end: bool) -> float:
    """Время хода по трапециевидному профилю скорости, с.

    stop_start/stop_end — поезд трогается с места / останавливается в конце.
    Если перегон короткий и поезд не успевает набрать v — треугольный профиль.
    """
    d_acc = v * v / (2 * accel) if stop_start else 0.0
    d_dec = v * v / (2 * decel) if stop_end else 0.0
    if d_acc + d_dec <= length_m:
        t = (length_m - d_acc - d_dec) / v
        if stop_start:
            t += v / accel
        if stop_end:
            t += v / decel
        return t
    denom = (1 / (2 * accel) if stop_start else 0.0) + (1 / (2 * decel) if stop_end else 0.0)
    vp = math.sqrt(length_m / denom)
    return (vp / accel if stop_start else 0.0) + (vp / decel if stop_end else 0.0)


def stop_energy_kwh(mass_t: float, v: float) -> float:
    """Кинетическая энергия, теряемая при остановке: E = m·v²/2, кВт·ч."""
    return mass_t * 1000 * v * v / 2 / 3.6e6
