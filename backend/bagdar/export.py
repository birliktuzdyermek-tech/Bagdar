"""Экспорт из живых данных прогона: CSV (события, план по поездам) и PDF-отчёт.

Всё берётся из текущего состояния и журнала, ничего не дорисовывается. Период
можно ограничить (from/to, секунды модели) — например последние 15 минут.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime
from pathlib import Path

FONTS = Path(__file__).resolve().parent / "assets" / "fonts"
STATUS_RU = {"applied": "применено", "pending": "ждёт выбора", "proposed": "предложено", "cancelled": "отменено",
             "chosen": "выбран вариант", "expired": "истекло", "superseded": "заменено"}


def hhmmss(t: float | None) -> str:
    if t is None:
        return ""
    t = int(round(t)) % 86400
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"


def _period(rt, t_from: float | None, t_to: float | None) -> tuple[float, float]:
    eng = rt.engine
    a = eng.start_time if t_from is None else max(eng.start_time, t_from)
    b = eng.t if t_to is None else min(eng.t, t_to)
    return a, b


# ------------------------------------------------------------------ CSV
def csv_events(rt, t_from: float | None = None, t_to: float | None = None) -> str:
    a, b = _period(rt, t_from, t_to)
    out = io.StringIO()
    w = csv.writer(out, delimiter=";")
    w.writerow(["seq", "время", "t_с", "тип", "важность", "сообщение", "поезд", "станция", "перегон"])
    num = rt.engine.number if rt.engine else (lambda x: x)
    for e in rt.history.events_db():
        if a - 1e-6 <= e["t"] <= b + 1e-6:
            w.writerow([e["seq"], hhmmss(e["t"]), round(e["t"], 1), e["kind"], e["severity"], e["message"],
                        num(e["train_id"]) if e["train_id"] in rt.engine.trains else (e["train_id"] or ""),
                        e["station_id"] or "", e["section_id"] or ""])
    return "﻿" + out.getvalue()       # BOM — Excel открывает кириллицу без танцев


def csv_plan(rt) -> str:
    eng = rt.engine
    plan = rt.planner.current
    out = io.StringIO()
    w = csv.writer(out, delimiter=";")
    w.writerow(["поезд", "номер", "класс", "плечо", "от", "до", "перегон", "отправление", "прибытие",
                "путь", "остановка", "по расписанию прибытие", "отклонение_мин", "версия_плана"])
    if plan is None:
        return "﻿" + out.getvalue()
    st = eng.world.stations
    for lg in sorted(plan.all_legs(), key=lambda x: (x.train_id, x.k)):
        tr = eng.trains.get(lg.train_id)
        if tr is None:
            continue
        sched = tr.schedule[lg.k + 1].arr if lg.k + 1 < len(tr.schedule) else None
        dev = "" if sched is None else round((lg.arr - sched) / 60, 1)
        w.writerow([tr.id, tr.number, tr.cls, lg.k, st[lg.from_id].name, st[lg.to_id].name, lg.section_id,
                    hhmmss(lg.dep), hhmmss(lg.arr), lg.track_id, "да" if lg.stop else "нет", hhmmss(sched), dev,
                    plan.version])
    return "﻿" + out.getvalue()


# ------------------------------------------------------------------ PDF
def _fonts():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    if "DejaVu" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("DejaVu", str(FONTS / "DejaVuSans.ttf")))
        pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(FONTS / "DejaVuSans-Bold.ttf")))
        from reportlab.lib.fonts import addMapping
        addMapping("DejaVu", 0, 0, "DejaVu")
        addMapping("DejaVu", 1, 0, "DejaVu-Bold")


def report_data(rt, t_from: float | None = None, t_to: float | None = None) -> dict:
    """Всё, что идёт в отчёт, одной структурой (её же проверяют тесты)."""
    eng = rt.engine
    a, b = _period(rt, t_from, t_to)
    m = eng.metrics()
    idx = rt.index.current or {}
    hist = [p for p in rt.index.history if a <= p["t"] <= b]
    plans = [h for h in rt.planner.history if a <= h.get("applied_at", h.get("t0", 0)) <= b]
    ms = [h["timings"]["total_ms"] for h in plans if h.get("timings")]
    cards = [c for c in rt.planner.cards if a <= c.get("t", 0) <= b]
    levels = {lv: sum(1 for c in cards if c["level"] == lv) for lv in ("A", "B", "C")}
    incs = [i for i in rt.incidents.items if a <= i.t <= b]
    vals = [p["value"] for p in hist if p["value"] is not None]
    return {
        "scenario": rt.scenario.title if rt.scenario else "", "scenario_id": rt.scenario.id if rt.scenario else "",
        "seed": eng.seed, "from": a, "to": b, "run_id": rt.run_id,
        "index": idx.get("value"), "index_status": idx.get("status_label"), "index_min": min(vals) if vals else None,
        "index_history": [(p["t"], p["value"]) for p in hist if p["value"] is not None],
        "active": m.get("active_trains"), "avg_delay_min": round((m.get("avg_delay_s") or 0) / 60, 1),
        "max_delay_min": round((m.get("max_delay_s") or 0) / 60, 1), "on_time": m.get("on_time_share"),
        "finished": m.get("finished_trains", m.get("finished")), "plans": len(plans),
        "replan_avg_s": round(sum(ms) / len(ms) / 1000, 2) if ms else None,
        "replan_max_s": round(max(ms) / 1000, 2) if ms else None,
        "cards": len(cards), "levels": levels,
        "incidents": [{"t": i.t, "level": i.level, "title": i.title, "status": i.status,
                       "affected": (i.after or {}).get("plan", {}).get("affected"),
                       "recovery_at": (i.after or {}).get("plan", {}).get("recovery_at")} for i in incs],
        "changes": [{"t": c["t"], "level": c["level"], "type": c["type"], "action": c["action"],
                     "status": c.get("status")} for c in cards][-40:],
        "stop_energy_kwh": m.get("stop_energy_kwh"),
    }


def _conclusion(d: dict) -> str:
    parts = []
    if d["index"] is not None:
        parts.append(f"Индекс эффективности на конец периода {round(d['index'])} ({d['index_status']}), "
                     f"минимум за период {round(d['index_min']) if d['index_min'] is not None else '—'}.")
    parts.append(f"План перестраивался {d['plans']} раз" + (f", в среднем за {d['replan_avg_s']} с, максимум "
                                                             f"{d['replan_max_s']} с." if d['replan_avg_s'] else "."))
    if d["incidents"]:
        parts.append(f"Сбоев за период: {len(d['incidents'])}; по каждому план перестроен автоматически, "
                     f"разбор «до / после» — в карточках решений.")
    else:
        parts.append("Сбоев за период не было.")
    parts.append(f"Решений Бағдара: {d['cards']} (A {d['levels']['A']}, B {d['levels']['B']}, C {d['levels']['C']}). "
                 f"Средняя задержка поездов на участке {d['avg_delay_min']} мин.")
    return " ".join(parts)


def pdf_report(rt, t_from: float | None = None, t_to: float | None = None) -> bytes:
    from reportlab.graphics.charts.lineplots import LinePlot
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    _fonts()
    d = report_data(rt, t_from, t_to)
    base = ParagraphStyle("b", fontName="DejaVu", fontSize=9.5, leading=13)
    h1 = ParagraphStyle("h1", parent=base, fontName="DejaVu-Bold", fontSize=17, leading=22, spaceAfter=4)
    h2 = ParagraphStyle("h2", parent=base, fontName="DejaVu-Bold", fontSize=12, leading=16, spaceBefore=10, spaceAfter=4)
    small = ParagraphStyle("s", parent=base, fontSize=8, leading=10, textColor=colors.HexColor("#555555"))
    cell = ParagraphStyle("c", parent=base, fontSize=8.5, leading=11)

    headc = ParagraphStyle("hc", parent=cell, fontName="DejaVu-Bold")

    def table(rows, widths, head=True):
        if head:
            rows = [[Paragraph(str(x), headc) for x in rows[0]]] + rows[1:]
        t = Table(rows, colWidths=widths, repeatRows=1 if head else 0)
        st = [("FONT", (0, 0), (-1, -1), "DejaVu", 8.5), ("VALIGN", (0, 0), (-1, -1), "TOP"),
              ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#BBBBBB")),
              ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]
        if head:
            st += [("FONT", (0, 0), (-1, 0), "DejaVu-Bold", 8.5), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF7"))]
        t.setStyle(TableStyle(st))
        return t

    story = [
        Paragraph("Бағдар — отчёт по прогону", h1),
        Paragraph("Консультативный прототип, не система управления движением. Данные синтетические, "
                  "цены и «сэкономленное» — условные единицы.", small),
        Spacer(1, 4 * mm),
        table([["Сценарий", f"{d['scenario']} ({d['scenario_id']}), seed {d['seed']}"],
               ["Период модели", f"{hhmmss(d['from'])} — {hhmmss(d['to'])} (01.10.2026, UTC+5)"],
               ["Прогон", d["run_id"]],
               ["Сформирован", datetime.now().strftime("%d.%m.%Y %H:%M")]], [40 * mm, 130 * mm], head=False),
        Paragraph("Показатели", h2),
        table([["Индекс", "Поездов на участке", "Ср. задержка", "Макс. задержка", "Пересчётов плана", "Время пересчёта"],
               [f"{round(d['index']) if d['index'] is not None else '—'} · {d['index_status'] or ''}",
                str(d["active"]), f"{d['avg_delay_min']} мин", f"{d['max_delay_min']} мин", str(d["plans"]),
                f"ср. {d['replan_avg_s'] or '—'} с, макс. {d['replan_max_s'] or '—'} с"]],
              [28 * mm, 28 * mm, 26 * mm, 26 * mm, 28 * mm, 40 * mm]),
    ]
    pts = d["index_history"]
    if len(pts) >= 2:
        dr = Drawing(170 * mm, 45 * mm)
        lp = LinePlot()
        lp.x, lp.y, lp.width, lp.height = 12 * mm, 6 * mm, 150 * mm, 34 * mm
        lp.data = [[((t - pts[0][0]) / 60, v) for t, v in pts]]
        lp.lines[0].strokeColor = colors.HexColor("#2A78D6")
        lp.lines[0].strokeWidth = 1.6
        lp.yValueAxis.valueMin, lp.yValueAxis.valueMax, lp.yValueAxis.valueStep = 0, 100, 25
        lp.xValueAxis.labels.fontName = lp.yValueAxis.labels.fontName = "DejaVu"
        lp.xValueAxis.labels.fontSize = lp.yValueAxis.labels.fontSize = 7
        dr.add(lp)
        dr.add(String(12 * mm, 41 * mm, "Индекс 0–100 по минутам периода", fontName="DejaVu", fontSize=8))
        story += [Spacer(1, 3 * mm), dr]
    story.append(Paragraph("Инциденты", h2))
    if d["incidents"]:
        rows = [["Время", "Ур.", "Что", "Задето волной", "График восстановится"]]
        for i in d["incidents"]:
            rows.append([hhmmss(i["t"]), i["level"], Paragraph(i["title"], cell),
                         "—" if i["affected"] is None else f"{i['affected']} п.", hhmmss(i["recovery_at"]) or "—"])
        story.append(table(rows, [18 * mm, 10 * mm, 92 * mm, 24 * mm, 26 * mm]))
    else:
        story.append(Paragraph("Сбоев за период не было.", base))
    story.append(Paragraph("Изменения плана (решения Бағдара)", h2))
    if d["changes"]:
        rows = [["Время", "Ур.", "Решение", "Статус"]]
        for c in d["changes"]:
            rows.append([hhmmss(c["t"]), c["level"], Paragraph(c["action"], cell),
                         STATUS_RU.get(c["status"] or "", c["status"] or "")])
        story.append(table(rows, [18 * mm, 10 * mm, 120 * mm, 22 * mm]))
    else:
        story.append(Paragraph("Изменений плана за период не было.", base))
    story += [Paragraph("Вывод", h2), Paragraph(_conclusion(d), base)]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm,
                            bottomMargin=16 * mm, title="Бағдар — отчёт по прогону", author="Бағдар (прототип)")
    doc.build(story)
    return buf.getvalue()
