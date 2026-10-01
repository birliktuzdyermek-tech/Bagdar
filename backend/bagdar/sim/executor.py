"""Исполнение плана в симуляторе.

Поезда входят на каждый перегон в том порядке, который задал план, и не
раньше планового времени, а на станционный путь — после тех, кого план
принимает на этот путь раньше. Если план допустим, исполнение по порядку не
может привести к взаимной блокировке: отклонения по времени дают только
задержку, а не конфликт. Порядок на перегоне без порядка на путях этого не
гарантирует: по двухпутному перегону встречные не упорядочены, и опоздавший
поезд находил свой единственный длинный путь занятым. Безопасность при этом
обеспечивает Interlocking.
"""
from __future__ import annotations

from collections import defaultdict

from bagdar.models.plan import Plan, PlanLeg
from bagdar.models.world import World

Key = tuple[str, int]


class PlanExecutor:
    def __init__(self, world: World, plan: Plan) -> None:
        self.world = world
        self.plan = plan
        self.track_seq: dict[str, list[tuple[float, str, int]]] = {}
        self.orders: dict[Key, list[tuple[str, int]]] = {}
        self.ptr: dict[Key, int] = {}
        self.members: dict[Key, set[tuple[str, int]]] = {}
        self.set_plan(plan, entered=set())

    def _key(self, section_id: str, direction: int) -> Key:
        sec = self.world.sections[section_id]
        return (section_id, 0 if sec.tracks == 1 else direction)

    def set_plan(self, plan: Plan, entered: set[tuple[str, int]]) -> None:
        self.plan = plan
        buckets: dict[Key, list[tuple[float, str, int]]] = defaultdict(list)
        for leg in plan.all_legs():
            if (leg.train_id, leg.k) in entered:
                continue
            buckets[self._key(leg.section_id, leg.direction)].append((leg.dep, leg.train_id, leg.k))
        self.orders = {}
        self.members = {}
        self.ptr = {}
        # порядок приёма на станционные пути: кто по плану прибывает на путь раньше
        tracks: dict[str, list[tuple[float, str, int]]] = defaultdict(list)
        for leg in plan.all_legs():
            if leg.track_id:
                tracks[leg.track_id].append((leg.arr, leg.train_id, leg.k))
        self.track_seq = {t: sorted(v) for t, v in tracks.items()}
        for key, items in buckets.items():
            items.sort()
            self.orders[key] = [(tid, k) for _, tid, k in items]
            self.members[key] = set(self.orders[key])
            self.ptr[key] = 0

    def leg(self, train_id: str, k: int) -> PlanLeg | None:
        return self.plan.leg(train_id, k)

    def order_blocker(self, train_id: str, k: int, section_id: str, direction: int,
                      entered: set[tuple[str, int]], gone: set[str]) -> str | None:
        """Поезд, который по плану должен войти на перегон раньше, или None."""
        key = self._key(section_id, direction)
        lst = self.orders.get(key)
        if not lst or (train_id, k) not in self.members[key]:
            return None
        i = self.ptr[key]
        while i < len(lst) and (lst[i] in entered or lst[i][0] in gone):
            i += 1
        self.ptr[key] = i
        if i >= len(lst) or lst[i] == (train_id, k):
            return None
        return lst[i][0]

    def track_blocker(self, track_id: str, train_id: str, k: int, arrived, gone: set[str]) -> str | None:
        """Поезд, которого план принимает на этот путь раньше и который ещё не прибыл, или None.

        Без этой проверки опоздавший поезд мог бы найти «свой» путь занятым тем, кто по плану
        приходит позже: на станциях с одним длинным путём это и есть «замок»."""
        leg = self.plan.leg(train_id, k)
        if leg is None:
            return None
        for arr, tid, kk in self.track_seq.get(track_id, ()):
            if arr >= leg.arr - 1e-6:
                break
            if tid == train_id or tid in gone or arrived(tid, kk):
                continue
            return tid
        return None

