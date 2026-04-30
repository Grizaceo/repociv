"""Quest naming helpers for RepoCiv missions."""

from __future__ import annotations

import re


def generate_quest_name(mission: str) -> str:
    words = re.findall(r"\b[a-zA-ZáéíóúñÁÉÍÓÚÑ]+\b", mission)
    if not words:
        return "Misión Desconocida"
    keywords = [w for w in words if len(w) >= 4][:3]
    if not keywords:
        keywords = words[:3]
    return " ".join(w.capitalize() for w in keywords)[:40]
