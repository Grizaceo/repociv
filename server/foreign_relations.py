#!/usr/bin/env python3
"""RepoCiv — Foreign Relations Analysis Pipeline.

Cheap local scoring between a news article and a target repo using:
  1. Keyword overlap (title + content vs readme + top dirs + tags)
  2. Lexical overlap / simple TF-IDF
  3. Category/source metadata matching
  4. Recent events (optional — fed by caller)
  5. Bibliotheca relations (optional — only if caller enables graphSuggestions)

Only if the score exceeds a threshold, the LLM is invoked to write the final report.
If score is below threshold, returns a low-confidence "impact low/unclear" response.

No full repo scan per news item. No automatic triggering.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from math import log
from typing import Any


# ─── Constants ─────────────────────────────────────────────────────────────────

_SCORE_THRESHOLD = 0.2  # Minimum combined score to invoke LLM
_HIGH_CONFIDENCE = 0.35  # Above this = medium+ confidence

_IMPACT_LABELS = ["none", "low", "medium", "high", "critical"]

# Default categories → relevant repo keywords map
_CATEGORY_REPO_MAP: dict[str, list[str]] = {
    "Seguridad": ["security", "vulnerability", "cve", "exploit", "yara", "malware", "pentest", "cyber"],
    "Vulnerabilidades": ["security", "vulnerability", "cve", "exploit", "yara"],
    "IA": ["ai", "llm", "model", "transformer", "embedding", "machine learning", "neural", "agent"],
    "Código": ["code", "typescript", "python", "rust", "go", "npm", "package", "api", "sdk", "library"],
    "Tecnología": ["tech", "infra", "cloud", "docker", "kubernetes", "linux", "gpu"],
    "Big Tech": ["api", "cloud", "platform", "service", "integration"],
}

# Weight multipliers per scoring dimension
_W_TOKEN_OVERLAP = 0.3
_W_TFIDF = 0.15
_W_CATEGORY_FIT = 0.2
_W_MANIFEST_FIT = 0.2
_W_EVENT_FIT = 0.15


# ─── Article representation ────────────────────────────────────────────────────


def _tokenize(text: str) -> set[str]:
    """Simple lowercase tokenizer — splits on non-alphanumeric."""
    return set(re.findall(r"[a-záéíóúñü]+", text.lower()))


def _tfidf_score(query_tokens: set[str], doc_tokens: set[str], doc_freq: int = 1, total_docs: int = 10) -> float:
    """Simple TF-IDF inspired score. Higher = more relevant."""
    intersection = query_tokens & doc_tokens
    if not intersection:
        return 0.0
    tf = len(intersection) / max(len(doc_tokens), 1)
    idf = log((total_docs + 1) / (doc_freq + 1)) + 1
    return tf * idf


def _keyword_overlap(article_text: str, repo_text: str) -> float:
    """Compute lexical overlap between article and repo text."""
    art_tokens = _tokenize(article_text)
    repo_tokens = _tokenize(repo_text)
    if not art_tokens or not repo_tokens:
        return 0.0
    intersection = art_tokens & repo_tokens
    # Jaccard-like but weighted toward coverage
    coverage = len(intersection) / max(len(art_tokens), 1)
    precision = len(intersection) / max(len(repo_tokens), 1)
    return (coverage + precision) / 2


def _category_fit(article: dict[str, Any], profile: dict[str, Any]) -> float:
    """Does the article's category match the repo's domain?"""
    category = (article.get("category") or "").strip()
    if not category:
        return 0.0

    repo_name = (profile.get("repoName") or "").lower()
    repo_tags = [t.lower() for t in (profile.get("skillTags") or [])]
    top_dirs = [d.lower() for d in (profile.get("topLevelDirs") or [])]
    readme = (profile.get("readmePreview") or "").lower()

    keywords = _CATEGORY_REPO_MAP.get(category, [])
    if not keywords:
        return 0.0

    matches = sum(
        1
        for kw in keywords
        if kw in repo_name or any(kw in t for t in repo_tags) or any(kw in d for d in top_dirs) or kw in readme
    )
    return min(matches / max(len(keywords), 1), 1.0)


def _manifest_fit(article: dict[str, Any], profile: dict[str, Any]) -> float:
    """Does the article mention technologies found in repo manifest?"""
    manifest = (profile.get("manifestSnippet") or "").lower()
    title = (article.get("title") or "").lower()

    # Scan manifest for version/package patterns mentioned in article
    tech_signals = re.findall(r"(?i)(python|typescript|rust|react|vue|svelte|tensorflow|pytorch|flask|fastapi|django|next|nuxt|node|deno|bun|kubernetes|docker|postgres|redis|sqlite)", manifest)

    if not tech_signals:
        return 0.0

    mentioned = sum(1 for t in set(tech_signals) if t.lower() in title)
    return min(mentioned / max(len(set(tech_signals)), 1) * 2, 1.0)


# ─── Main scoring pipeline ─────────────────────────────────────────────────────


def score_article_repo(article: dict[str, Any], profile: dict[str, Any], events: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Compute a relevance score between an article and a repo profile.

    Returns:
        {
            "score": float (0-1),
            "confidence": "high" | "medium" | "low",
            "dimensions": {
                "keywordOverlap": float,
                "categoryFit": float,
                "manifestFit": float,
                "eventFit": float,
            },
            "shouldTriggerLLM": bool,
        }
    """
    article_text = f"{article.get('title', '')} {article.get('blogName', '')} {article.get('category', '')}"
    repo_text = (
        f"{profile.get('repoName', '')} "
        f"{profile.get('readmePreview', '')[:2000]} "
        f"{' '.join(profile.get('topLevelDirs', []))} "
        f"{' '.join(profile.get('skillTags', []))}"
    )

    keyword_score = _keyword_overlap(article_text, repo_text)
    tfidf_score = _tfidf_score(_tokenize(article_text), _tokenize(repo_text))
    cat_score = _category_fit(article, profile)
    man_score = _manifest_fit(article, profile)
    event_score = 0.0

    if events:
        event_text = " ".join(
            e.get("summary", e.get("text", "")) for e in events if isinstance(e, dict)
        )
        event_score = _keyword_overlap(article_text, event_text) * 0.5

    combined = (
        keyword_score * _W_TOKEN_OVERLAP
        + tfidf_score * _W_TFIDF
        + cat_score * _W_CATEGORY_FIT
        + man_score * _W_MANIFEST_FIT
        + event_score * _W_EVENT_FIT
    )

    # Normalize to 0-1
    combined = min(max(combined, 0.0), 1.0)

    confidence: str
    if combined >= _HIGH_CONFIDENCE:
        confidence = "high"
    elif combined >= _SCORE_THRESHOLD:
        confidence = "medium"
    else:
        confidence = "low"

    return {
        "score": round(combined, 4),
        "confidence": confidence,
        "shouldTriggerLLM": combined >= _SCORE_THRESHOLD,
        "dimensions": {
            "keywordOverlap": round(keyword_score, 4),
            "tfidfScore": round(tfidf_score, 4),
            "categoryFit": round(cat_score, 4),
            "manifestFit": round(man_score, 4),
            "eventFit": round(event_score, 4),
        },
    }


# ─── LLM invocation (final report) ─────────────────────────────────────────────


def _invoke_llm(prompt: str, model: str = "deepseek/deepseek-v4-flash:free") -> str | None:
    """Call Hermes/OpenAI-compatible endpoint for report generation.

    Uses HERMES_URL / HERMES_KEY from env. Falls back gracefully.
    """
    hermes_url = os.environ.get("HERMES_URL", "").rstrip("/")
    if not hermes_url:
        # Try local gateway
        hermes_url = "http://localhost:8642/v1"

    # Remove /v1/chat/completions suffix if present
    for suffix in ("/v1/chat/completions", "/v1/completions", "/v1"):
        if hermes_url.endswith(suffix):
            hermes_url = hermes_url[: -len(suffix)]
            break

    api_url = f"{hermes_url}/v1/chat/completions"
    api_key = os.environ.get("HERMES_KEY", "")

    headers = {
        "Content-Type": "application/json",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Eres el Analista Exterior / Diplomatico del Imperio RepoCiv. "
                    "Analizas cómo una noticia afecta un repositorio específico. "
                    "Eres preciso, breve y basas tus afirmaciones en evidencia. "
                    "Nunca inventas relaciones. Si no hay suficiente información, "
                    "lo declaras explícitamente con baja confianza."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 1024,
        "temperature": 0.3,
    }

    try:
        req = urllib.request.Request(
            api_url,
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        return content.strip() if content else None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        # LLM unavailable — caller handles fallback
        return None


def generate_report(
    article: dict[str, Any],
    profile: dict[str, Any],
    scoring: dict[str, Any],
    events: list[dict[str, Any]] | None = None,
    graph_relations: list[dict[str, Any]] | None = None,
    agent_id: str = "diplomat",
) -> dict[str, Any] | None:
    """Generate a ForeignRelationsReport document.

    If the LLM is unavailable or score is too low, returns a synthesized
    low-confidence report from heuristics only.
    """
    score = scoring.get("score", 0.0)

    if score < _SCORE_THRESHOLD:
        # Below threshold — no LLM, return low-confidence baseline
        return _build_low_confidence_report(article, profile, scoring, agent_id)

    # Build the LLM prompt
    prompt = _build_report_prompt(article, profile, scoring, events, graph_relations)

    llm_output = _invoke_llm(prompt)
    if llm_output:
        return _parse_llm_report(llm_output, article, profile, scoring, agent_id)

    # LLM unavailable — synthesize from heuristics
    return _build_heuristic_report(article, profile, scoring, agent_id)


# ─── Prompt builder ────────────────────────────────────────────────────────────


def _build_report_prompt(
    article: dict[str, Any],
    profile: dict[str, Any],
    scoring: dict[str, Any],
    events: list[dict[str, Any]] | None = None,
    graph_relations: list[dict[str, Any]] | None = None,
) -> str:
    lines = [
        "## Noticia",
        f"- Título: {article.get('title', 'Sin título')}",
        f"- Fuente: {article.get('blogName', 'Desconocida')}",
        f"- Categoría: {article.get('category', 'General')}",
        f"- URL: {article.get('url', 'N/A')}",
        "",
        "## Repositorio objetivo",
        f"- Nombre: {profile.get('repoName', 'Desconocido')}",
        f"- Ruta: {profile.get('repoPath', 'N/A')}",
        f"- Top-level dirs: {', '.join(profile.get('topLevelDirs', [])[:10])}",
    ]

    tags = profile.get("skillTags", [])
    if tags:
        lines.append(f"- Tags/Skills: {', '.join(tags)}")

    manifest = profile.get("manifestSnippet")
    if manifest:
        lines.append(f"- Manifest: {manifest[:500]}")
    readme = profile.get("readmePreview")
    if readme:
        lines.append(f"- README preview: {readme[:500]}")

    lines.extend([
        "",
        "## Scoring local",
        f"- Score combinado: {scoring.get('score', 0)}",
        f"- Confianza heurística: {scoring.get('confidence', 'low')}",
        f"- Dimensiones: {json.dumps(scoring.get('dimensions', {}))}",
    ])

    if events:
        lines.extend(["", "## Eventos recientes relevantes"])
        for ev in events[:5]:
            lines.append(f"- {ev.get('summary', ev.get('text', str(ev)))[:200]}")

    if graph_relations:
        lines.extend(["", "## Relaciones de grafo (Bibliotheca)"])
        for rel in graph_relations[:5]:
            lines.append(f"- {rel.get('label', str(rel))}")

    lines.extend([
        "",
        "## Instrucciones",
        "Genera un informe estructurado con los siguientes campos (separados por |):",
        "1. **title**: Título corto del informe",
        "2. **summary**: Resumen de 2-3 líneas de cómo la noticia afecta al repo",
        "3. **impact**: 'none' | 'low' | 'medium' | 'high' | 'critical'",
        "4. **confidence**: número 0-1 basado en cuánta evidencia tienes",
        "5. **evidence**: lista de evidencias usadas (cada una: tipo, ref, quote opcional)",
        "6. **recommendations**: lista de acciones sugeridas (cada una: label, risk)",
        "7. **markdown**: texto completo del informe en markdown",
        "",
        "IMPORTANTE: Si no hay suficiente evidencia, pon impacto 'none' o 'low'",
        "y confianza baja. No inventes relaciones que no puedas respaldar.",
    ])

    return "\n".join(lines)


# ─── Report builders ───────────────────────────────────────────────────────────


def _build_low_confidence_report(
    article: dict[str, Any],
    profile: dict[str, Any],
    scoring: dict[str, Any],
    agent_id: str,
) -> dict[str, Any]:
    """Build a report when score is below LLM threshold."""
    impact = "none" if scoring["score"] < 0.05 else "low"
    requires_follow_up = scoring["score"] >= 0.12
    return {
        "title": f"Impacto {impact.replace('none', 'no detectable').replace('low', 'bajo')}: {article.get('title', '')[:60]}",
        "summary": f"No se detectó una relación significativa entre la noticia y el repositorio {profile.get('repoName', 'desconocido')}. El scoring local ({scoring['score']}) está por debajo del umbral de análisis.",
        "impact": impact,
        "confidence": scoring["score"],
        "evidence": [
            {"type": "article", "ref": article.get("url", ""), "quote": article.get("title", "")},
            {"type": "repo_file", "ref": profile.get("repoPath", ""), "quote": f"README: {(profile.get('readmePreview') or '')[:200]}"},
        ],
        "recommendations": [{"label": "Monitorear — la relación puede cambiar con nuevo contexto", "risk": "safe"}],
        "requiresFollowUp": requires_follow_up,
        "markdown": (
            f"# Informe de Relaciones Exteriores: Impacto Bajo\n\n"
            f"**Noticia:** {article.get('title', '')}\n"
            f"**Repositorio:** {profile.get('repoName', '')}\n"
            f"**Confianza:** {scoring['score']:.2f}\n\n"
            f"El análisis heurístico no encontró superposición significativa "
            f"entre esta noticia y el repositorio. Se recomienda monitoreo pasivo.\n\n"
            f"### Dimensiones de scoring\n"
            f"- Keyword overlap: {scoring['dimensions']['keywordOverlap']}\n"
            f"- TF-IDF local: {scoring['dimensions'].get('tfidfScore', 0)}\n"
            f"- Category fit: {scoring['dimensions']['categoryFit']}\n"
            f"- Manifest fit: {scoring['dimensions']['manifestFit']}\n"
            f"- Event fit: {scoring['dimensions']['eventFit']}\n"
        ),
        "agentId": agent_id,
    }


def _parse_llm_report(
    llm_output: str,
    article: dict[str, Any],
    profile: dict[str, Any],
    scoring: dict[str, Any],
    agent_id: str,
) -> dict[str, Any]:
    """Parse structured fields from LLM output.

    The LLM returns fields separated by |. We do lightweight parsing
    with sensible fallbacks for any missing fields.
    """
    # Default structure
    report: dict[str, Any] = {
        "title": f"Informe: {article.get('title', '')[:80]}",
        "summary": "",
        "impact": "low",
        "confidence": scoring["score"],
        "evidence": [
            {"type": "article", "ref": article.get("url", ""), "quote": article.get("title", "")},
            {"type": "repo_file", "ref": profile.get("repoPath", ""), "quote": profile.get("repoName", "")},
        ],
        "recommendations": [],
        "requiresFollowUp": scoring["score"] >= 0.45 or scoring["confidence"] == "high",
        "markdown": llm_output,
        "agentId": agent_id,
    }

    # Extract structured fields from LLM output
    current_field = None

    for line in llm_output.split("\n"):
        line = line.strip()

        # Match field headers
        title_m = re.match(r"1\.\s*\*?\*?(?:title|Título|Title)\*?\*?\s*[:：]\s*(.+?)(?:\s*$)", line, re.IGNORECASE)
        if title_m:
            report["title"] = title_m.group(1).strip()
            continue

        summary_m = re.match(r"2\.\s*\*?\*?(?:summary|Resumen|Summary)\*?\*?\s*[:：]\s*(.+?)(?:\s*$)", line, re.IGNORECASE)
        if summary_m:
            report["summary"] = summary_m.group(1).strip()
            continue

        impact_m = re.match(r"3\.\s*\*?\*?(?:impact|Impacto|Impact)\*?\*?\s*[:：]\s*(none|low|medium|high|critical)", line, re.IGNORECASE)
        if impact_m:
            report["impact"] = impact_m.group(1).lower()
            continue

        conf_m = re.match(r"4\.\s*\*?\*?(?:confidence|Confianza|Confidence)\*?\*?\s*[:：]\s*(\d+(?:\.\d+)?)", line, re.IGNORECASE)
        if conf_m:
            report["confidence"] = min(float(conf_m.group(1)), 1.0)
            continue

        ev_m = re.match(r"5\.\s*\*?\*?(?:evidence|Evidencia|Evidence)\*?\*?\s*[:：]", line, re.IGNORECASE)
        if ev_m:
            current_field = "evidence"
            continue

        rec_m = re.match(r"6\.\s*\*?\*?(?:recommendations|Recomendaciones|Recommendations)\*?\*?\s*[:：]", line, re.IGNORECASE)
        if rec_m:
            current_field = "recommendations"
            continue

        mark_m = re.match(r"7\.\s*\*?\*?(?:markdown)\*?\*?\s*[:：]", line, re.IGNORECASE)
        if mark_m:
            current_field = "markdown"
            continue

        # Collect items for current field
        if current_field == "evidence" and line.startswith("-"):
            parts = line.lstrip("- ").split(",")
            ev = {"type": "repo_file", "ref": line, "quote": ""}
            for p in parts:
                p = p.strip()
                if ":" in p:
                    k, v = p.split(":", 1)
                    k = k.strip().lower()
                    if k == "tipo" or k == "type":
                        ev["type"] = v.strip()
                    elif k == "ref":
                        ev["ref"] = v.strip()
                    elif k == "quote":
                        ev["quote"] = v.strip()
            if ev not in report["evidence"]:
                report["evidence"].append(ev)

        if current_field == "recommendations" and line.startswith("-"):
            label = line.lstrip("- ").strip()
            risk = "safe"
            risk_m = re.search(r"risk:\s*(\w+)", label, re.IGNORECASE)
            if risk_m:
                risk = risk_m.group(1)
                label = label[: risk_m.start()].strip().rstrip(",")
            report["recommendations"].append({"label": label, "risk": risk})

    return report


def _build_heuristic_report(
    article: dict[str, Any],
    profile: dict[str, Any],
    scoring: dict[str, Any],
    agent_id: str,
) -> dict[str, Any]:
    """Build report from heuristics alone (no LLM available)."""
    impact: str
    if scoring["score"] >= 0.5:
        impact = "medium"
    elif scoring["score"] >= _SCORE_THRESHOLD:
        impact = "low"
    else:
        impact = "none"

    dims = scoring.get("dimensions", {})

    evidence = [
        {"type": "article", "ref": article.get("url", ""), "quote": article.get("title", "")},
    ]

    if dims.get("keywordOverlap", 0) > 0.1:
        evidence.append({
            "type": "repo_file",
            "ref": f"README/{profile.get('repoName', '')}",
            "quote": "Keyword overlap detectado entre artículo y perfil del repo",
        })
    if dims.get("categoryFit", 0) > 0.1:
        evidence.append({
            "type": "article",
            "ref": f"categoría={article.get('category', '')}",
            "quote": "La categoría del artículo es relevante para el dominio del repo",
        })
    if dims.get("manifestFit", 0) > 0.1:
        evidence.append({
            "type": "repo_file",
            "ref": f"manifest/{profile.get('manifestType', 'unknown')}",
            "quote": "El manifest del repo contiene tecnologías mencionadas en el artículo",
        })

    return {
        "title": f"Informe heurístico: {article.get('title', '')[:60]}",
        "summary": (
            f"Análisis local sin LLM. El artículo '{article.get('title', '')}' "
            f"tiene un score de {scoring['score']:.2f} con el repo {profile.get('repoName', '')}. "
            f"La relación es {impact.replace('none', 'no detectable').replace('low', 'baja').replace('medium', 'moderada')}."
        ),
        "impact": impact,
        "confidence": scoring["score"],
        "evidence": evidence,
        "recommendations": [{"label": "Monitorear cambios en el repo que puedan aumentar relevancia", "risk": "safe"}],
        "requiresFollowUp": scoring["score"] >= 0.3,
        "markdown": (
            f"# Informe Heurístico de Relaciones Exteriores\n\n"
            f"**Noticia:** {article.get('title', '')}\n"
            f"**Fuente:** {article.get('blogName', '')}\n"
            f"**Repositorio:** {profile.get('repoName', '')}\n"
            f"**Score combinado:** {scoring['score']}\n\n"
            f"**Impacto estimado:** {impact}\n"
            f"**Confianza:** {scoring['score']:.2f}\n\n"
            f"### Evidencia usada\n"
            + "\n".join(f"- {e['type']}: {e['ref']}" for e in evidence) +
            "\n\n"
            f"### Dimensiones de scoring\n"
            f"- Keyword overlap: {dims.get('keywordOverlap', 0)}\n"
            f"- TF-IDF local: {dims.get('tfidfScore', 0)}\n"
            f"- Category fit: {dims.get('categoryFit', 0)}\n"
            f"- Manifest fit: {dims.get('manifestFit', 0)}\n"
            f"- Event fit: {dims.get('eventFit', 0)}\n\n"
            f"*Informe generado sin LLM — basado únicamente en heurísticas locales.*"
        ),
        "agentId": agent_id,
        "llmUnavailable": True,
    }
