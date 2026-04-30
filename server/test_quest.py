from server.quest import generate_quest_name


def test_generate_quest_name_uses_keywords():
    assert generate_quest_name("revisar transporte SSE de producción") == "Revisar Transporte Producción"


def test_generate_quest_name_falls_back_for_empty_text():
    assert generate_quest_name("123 !!!") == "Misión Desconocida"
