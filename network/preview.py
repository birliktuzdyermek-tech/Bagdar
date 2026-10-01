"""Render the two generated worlds as a compact, source-honest SVG preview."""
from __future__ import annotations

import html
import json
from pathlib import Path

from network.generate import OUT_DIR


def _text(x: float, y: float, value: str, *, size: int = 15, fill: str = "#e8f0fb",
          anchor: str = "middle") -> str:
    return f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" fill="{fill}" font-size="{size}" font-family="Arial, sans-serif">{html.escape(value)}</text>'


def make_svg(single: dict, double: dict) -> str:
    if [s["id"] for s in single["stations"]] != [s["id"] for s in double["stations"]]:
        raise ValueError("World variants must share stations")
    important = {"dm00", "dm07", "dm14", "dm23", "dm30", "dm34"}
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="630" viewBox="0 0 1600 630" role="img" aria-label="Схема двух модельных версий линии Достык — Мойынты">',
             '<rect width="1600" height="630" fill="#111110"/>',
             _text(55, 52, "Достык — Мойынты", size=30, anchor="start"),
             _text(55, 80, "35 именованных пунктов · 34 перегона · 834 км тарифный маршрут", size=17, fill="#c3c2b7", anchor="start")]
    for row, world in enumerate((single, double)):
        base = 180 if row == 0 else 415
        stations = world["stations"]
        coords = [(70 + s["x"] * 1.45, base + (s["y"] - 130) * 0.36) for s in stations]
        path = " ".join(("M" if i == 0 else "L") + f"{x:.1f},{y:.1f}" for i, (x, y) in enumerate(coords))
        parts.append(_text(55, base - 100, "До второго пути — модель" if row == 0 else "После второго пути — модель", size=21, anchor="start"))
        parts.append(_text(1545, base - 100, f"{len(world['trains'])} синтетических поездов/сутки", size=17, fill="#c3c2b7", anchor="end"))
        offsets = (0,) if row == 0 else (-4, 4)
        for offset in offsets:
            parts.append(f'<path d="{path}" transform="translate(0 {offset})" fill="none" stroke="#3987e5" stroke-width="3" stroke-linejoin="round"/>')
        for station, (x, y) in zip(stations, coords):
            major = station["id"] in important
            color = "#ffffff" if major else "#98a5b8"
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{5 if major else 2.4}" fill="{color}"/>')
            if major:
                label = station["name"]
                if label.startswith("Балхаш"):
                    label = "Балхаш"
                parts.append(_text(x, y + (29 if row == 0 else 28), label, size=14))
                parts.append(_text(x, y + (46 if row == 0 else 45), f"{station['km']:g} км", size=12, fill="#a7b4c8"))
    parts.extend([_text(55, 594, "Схема по открытым данным. Движение смоделировано. Позиции промежуточных пунктов на схеме интерполированы.", size=14, fill="#c3c2b7", anchor="start"),
                  _text(55, 616, "836 км — отдельная проектная длина второго пути; 12→60 пар/сутки — проектная способность, не измеренный поток.", size=13, fill="#c3c2b7", anchor="start"),
                  '</svg>'])
    return "\n".join(parts) + "\n"


def main() -> None:
    single = json.loads((OUT_DIR / "world.single.json").read_text(encoding="utf-8"))
    double = json.loads((OUT_DIR / "world.double.json").read_text(encoding="utf-8"))
    path = OUT_DIR / "diagram.svg"
    path.write_text(make_svg(single, double), encoding="utf-8")
    print(path)


if __name__ == "__main__":
    main()
