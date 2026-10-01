"""Генератор условных названий станций в духе казахской топонимики.

Названия синтетические: совпадение с реальными пунктами случайно."""
from __future__ import annotations

import random

_PREFIX = ["Ақ", "Қара", "Сары", "Көк", "Жаңа", "Бес", "Үш", "Қызыл", "Ұлы", "Тас",
           "Алтын", "Күміс", "Шығыс", "Батыс", "Жел", "Құм", "Ескі", "Таң", "Ай", "Бел"]
_ROOT = ["су", "бұлақ", "тау", "көл", "құдық", "арық", "дала", "шоқы", "тоғай", "сай",
         "өзек", "жар", "қайың", "терек", "адыр", "төбе", "сор", "бел", "қаспақ", "кеңес"]


def station_names(rng: random.Random, count: int) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    attempts = 0
    while len(out) < count and attempts < count * 50:
        attempts += 1
        name = rng.choice(_PREFIX) + rng.choice(_ROOT)
        if name not in seen:
            seen.add(name)
            out.append(name)
    while len(out) < count:
        out.append(f"Пункт {len(out) + 1}")
    return out
