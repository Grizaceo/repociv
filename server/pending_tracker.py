import os
from pathlib import Path
from typing import Any
import re
import time

HERMES_ROOT = Path(os.path.expanduser(os.environ.get("HERMES_ROOT", "~/.hermes")))
PENDING_TRACKER = HERMES_ROOT / "workspace" / "PENDING_TRACKER.md"

# ─── PENDING_TRACKER ──────────────────────────────────────────────────────────

# Sections that count as "active" (shown in the pending panel)
_ACTIVE_SECTIONS = {"ALTA", "MEDIA", "BAJA"}
# Sections that are excluded from active listing
_INACTIVE_SECTIONS = {"STALE", "HECHO", "DESCARTADOS", "MOVIDOS FUERA"}
# Regex for item headers like "### [022] TITLE — State" or "### [024] TITLE — State"
_ITEM_RE = re.compile(
    r"^###\s+\[(\d+)\]\s+(.*?)\s+—\s+(.*)"
)
# Regex for state line like "**Estado:** 🔵 registrada"
_STATE_RE = re.compile(
    r"\*\*Estado:\*\*\s*(🔵|🟡|🟢|🔴)\s*(.*)"
)
# Regex for detail start
_DETAIL_RE = re.compile(r"\*\*Detalle:\*\*")
# Regex for next section/item boundary
_SECTION_RE = re.compile(r"^##\s+\[(\w+)\]|^##\s+(\w+)|^###\s+\[")
# Known closing markers
_SIGUIENTE_RE = re.compile(r"\*\*Siguiente paso:\*\*")
_UBICACION_RE = re.compile(r"\*\*Ubicaci")


def load_pending_tasks() -> list[dict[str, Any]]:
    """Parse PENDING_TRACKER.md into structured task items.

    Returns items from active sections (ALTA, MEDIA, BAJA) with:
      id, title, priority, state, detail (multiline string)
    Excludes items in STALE, HECHO, DESCARTADOS sections.
    """
    if not PENDING_TRACKER.exists():
        return []
    try:
        lines = PENDING_TRACKER.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []

    tasks: list[dict[str, Any]] = []
    current_section = ""
    i = 0
    while i < len(lines):
        line = lines[i]

        # Detect section headers: ## [ALTA], ## [MEDIA], ## [BAJA], ## [STALE], ## HECHO, etc.
        sec = re.match(r"^##\s+\[(\w+)\]", line)
        if sec:
            current_section = sec.group(1).upper()
            i += 1
            continue
        sec2 = re.match(r"^##\s+(\w[\w /-]*)", line)
        if sec2 and not sec:
            name = sec2.group(1).strip().upper()
            # Map actual section names
            if "HECHO" in name:
                current_section = "HECHO"
            elif "DESCARTADO" in name or "MOVIDO" in name:
                current_section = "DESCARTADOS"
            elif "STALE" in name:
                current_section = "STALE"
            else:
                current_section = name
            i += 1
            continue

        # Detect item headers: ### [NNN] TITLE — State
        m = _ITEM_RE.match(line)
        if m:
            item_id = m.group(1)
            title = m.group(2).strip()
            subtitle = m.group(3).strip()
            state_emoji = ""
            state_text = subtitle

            # Collect detail lines
            detail_lines: list[str] = []
            in_detail = False
            j = i + 1
            while j < len(lines):
                dl = lines[j]
                # Stop at next section or item header
                if _SECTION_RE.match(dl) and (dl.startswith("##") or (dl.startswith("###") and _ITEM_RE.match(dl))):
                    break
                # Check for **Estado:** line
                sm = _STATE_RE.match(dl)
                if sm:
                    state_emoji = sm.group(1)
                    state_text = sm.group(2).strip() or subtitle
                    j += 1
                    continue
                # Check for **Detalle:** start
                if _DETAIL_RE.match(dl):
                    in_detail = True
                    # Extract any text after "**Detalle:**" on same line
                    after_detail = dl.split("**Detalle:**", 1)[1].strip()
                    if after_detail:
                        detail_lines.append(after_detail)
                    j += 1
                    continue
                if in_detail:
                    # Stop detail at **Siguiente paso:**, **Ubicación:**, **Notas:** or blank line + new bullet
                    if _SIGUIENTE_RE.match(dl) or _UBICACION_RE.match(dl) or dl.startswith("**Notas:**"):
                        in_detail = False
                        j += 1
                        continue
                    # Stop at horizontal rule
                    if dl.strip() == "---":
                        in_detail = False
                        j += 1
                        continue
                    # Stop at empty line after detail content
                    if not dl.strip() and detail_lines:
                        in_detail = False
                        j += 1
                        continue
                    detail_lines.append(dl)
                j += 1

            # Only include items from active sections
            if current_section in _ACTIVE_SECTIONS:
                detail_text = "\n".join(detail_lines).strip()
                tasks.append({
                    "id": item_id,
                    "title": title,
                    "priority": current_section,
                    "state": state_emoji or "",
                    "stateText": state_text,
                    "detail": detail_text,
                })

        i += 1

    return tasks


def append_pending_task(title: str, priority: str = "MEDIA") -> str | None:
    """Append a new item to PENDING_TRACKER.md under the given priority section.

    Returns the new item ID string, or None on failure.
    """
    try:
        existing = PENDING_TRACKER.read_text(encoding="utf-8") if PENDING_TRACKER.exists() else ""
        if not title.strip():
            return None
        # Guard: no duplicar si el título ya existe como item pendiente
        if re.search(re.escape(title.strip()), existing):
            return None

        # Find the highest existing ID in the file
        max_id = 0
        for m in re.finditer(r"\[(\d+)\]", existing):
            num = int(m.group(1))
            if num > max_id:
                max_id = num
        new_id = f"{max_id + 1:03d}"

        # Build the new item block
        section_marker = f"[{priority}]"
        new_block = (
            f"\n### [{new_id}] {title.strip()} — 🔵 registrada\n"
            f"**Estado:** 🔵 registrada\n"
            f"**Detalle:**\n"
        )

        # Insert after the section header
        lines = existing.splitlines(keepends=True)
        inserted = False
        result: list[str] = []
        i = 0
        while i < len(lines):
            line = lines[i]
            result.append(line)
            # Match section headers like "## [MEDIA] Pendientes activos"
            if section_marker in line.strip() and line.strip().startswith("##"):
                i += 1
                # Skip section header and any "(vacío)" line
                while i < len(lines):
                    next_line = lines[i]
                    if next_line.strip() == "*(vacío — ninguno)*" or next_line.strip() == "*(vacío)*":
                        # Replace the empty marker with our new block
                        result.append(new_block)
                        inserted = True
                        i += 1
                        break
                    elif next_line.startswith("### ["):
                        # Insert before first item in section
                        result.append(new_block)
                        inserted = True
                        break
                    elif next_line.startswith("## "):
                        # Hit next section before finding items — insert here
                        result.append(new_block)
                        inserted = True
                        break
                    else:
                        result.append(next_line)
                        i += 1
                if inserted:
                    # Continue appending remaining lines
                    while i < len(lines):
                        result.append(lines[i])
                        i += 1
                    break
            i += 1

        if not inserted:
            # Section not found — append at end
            result_str = "".join(result)
            if not result_str.endswith("\n"):
                result_str += "\n"
            result_str += f"\n## Pending\n\n{new_block}"
            PENDING_TRACKER.write_text(result_str, encoding="utf-8")
        else:
            PENDING_TRACKER.write_text("".join(result), encoding="utf-8")

        return new_id
    except Exception as e:
        print(f"[bridge] No pude escribir PENDING_TRACKER: {e}")
        return None


def resolve_pending_task(item_id: str) -> bool:
    """Move an item from its active section to the HECHO section.

    Returns True if the item was found and moved.
    """
    try:
        if not PENDING_TRACKER.exists():
            return False
        content = PENDING_TRACKER.read_text(encoding="utf-8")
        lines = content.splitlines()

        # Find the item block
        item_start = -1
        item_end = -1
        for i, line in enumerate(lines):
            m = _ITEM_RE.match(line)
            if m and m.group(1) == item_id:
                item_start = i
                # Find end: next ### [ or ## section or end of file
                for j in range(i + 1, len(lines)):
                    if lines[j].startswith("### [") or (lines[j].startswith("## ") and not lines[j].startswith("## [")):
                        item_end = j
                        break
                    if lines[j].startswith("## ["):
                        item_end = j
                        break
                if item_end == -1:
                    item_end = len(lines)
                break

        if item_start == -1:
            return False

        # Extract the item block
        item_block = lines[item_start:item_end]
        # Remove the item from its current position
        remaining = lines[:item_start] + lines[item_end:]

        # Find or create HECHO section
        hecho_start = -1
        for i, line in enumerate(remaining):
            if re.match(r"^##\s+HECHO", line) or re.match(r"^##\s+\[HECHO\]", line):
                hecho_start = i
                break

        # Build the table row for HECHO
        title_line = item_block[0]
        title_m = _ITEM_RE.match(title_line)
        title_text = title_m.group(2).strip() if title_m else title_line
        today = time.strftime("%Y-%m-%d")
        table_row = f"| [{item_id}] | {title_text} | {today} | Movido desde panel |"

        if hecho_start == -1:
            # Create HECHO section at end
            hecho_block = [
                "",
                "---",
                "",
                "## HECHO (eliminados de lista activa)",
                "",
                "| ID | Título | Fecha cierre | Notas |",
                "|----|--------|-------------|-------|",
                table_row,
                "",
            ]
            new_content_lines = remaining + hecho_block
        else:
            # Find the table in HECHO section and insert row
            insert_idx = -1
            for i in range(hecho_start + 1, len(remaining)):
                if remaining[i].startswith("|") and "---" in remaining[i]:
                    insert_idx = i + 1
                    break
                if remaining[i].startswith("## ") or remaining[i].startswith("### "):
                    break
            if insert_idx == -1:
                # No table header found — insert after section header
                insert_idx = hecho_start + 1
            new_content_lines = remaining[:insert_idx] + [table_row] + remaining[insert_idx:]

        PENDING_TRACKER.write_text("\n".join(new_content_lines) + "\n", encoding="utf-8")
        return True
    except Exception as e:
        print(f"[bridge] No pude resolver pendiente: {e}")
        return False


def edit_pending_task(item_id: str, title: str | None = None,
                      priority: str | None = None,
                      detail: str | None = None) -> bool:
    """Edit fields of an existing pending item. Returns True if found and updated."""
    try:
        if not PENDING_TRACKER.exists():
            return False
        content = PENDING_TRACKER.read_text(encoding="utf-8")
        lines = content.splitlines()

        # Find the item block
        item_start = -1
        item_end = -1
        current_section = ""
        for i, line in enumerate(lines):
            # Track section
            sec = re.match(r"^##\s+\[(\w+)\]", line)
            if sec:
                current_section = sec.group(1).upper()
                continue
            sec2 = re.match(r"^##\s+(\w[\w /-]*)", line)
            if sec2 and not sec:
                name = sec2.group(1).strip().upper()
                if "HECHO" in name:
                    current_section = "HECHO"
                elif "DESCARTADO" in name or "MOVIDO" in name:
                    current_section = "DESCARTADOS"
                elif "STALE" in name:
                    current_section = "STALE"
                else:
                    current_section = name
                continue

            m = _ITEM_RE.match(line)
            if m and m.group(1) == item_id:
                item_start = i
                item_section = current_section
                for j in range(i + 1, len(lines)):
                    if lines[j].startswith("### [") or lines[j].startswith("## "):
                        item_end = j
                        break
                if item_end == -1:
                    item_end = len(lines)
                break

        if item_start == -1:
            return False

        item_lines = lines[item_start:item_end]

        # Edit title in the header line
        if title is not None and title.strip():
            old_header = item_lines[0]
            m = _ITEM_RE.match(old_header)
            if m:
                state_part = m.group(3).strip()
                item_lines[0] = f"### [{item_id}] {title.strip()} — {state_part}"

        # Edit detail
        if detail is not None:
            # Remove old detail block
            new_item_lines = []
            in_detail = False
            detail_done = False
            for il in item_lines:
                if not detail_done and _DETAIL_RE.match(il):
                    in_detail = True
                    detail_done = True
                    # Skip until end of detail
                    continue
                if in_detail:
                    if _SIGUIENTE_RE.match(il) or _UBICACION_RE.match(il) or il.startswith("**Notas:**") or il.strip() == "---":
                        in_detail = False
                        new_item_lines.append(il)
                    continue
                new_item_lines.append(il)
            # Insert new detail after Estado line
            insert_after = -1
            for idx, il in enumerate(new_item_lines):
                if _STATE_RE.match(il):
                    insert_after = idx
                    break
            if insert_after >= 0:
                detail_lines = ["**Detalle:**"] + detail.splitlines()
                item_lines = new_item_lines[:insert_after + 1] + detail_lines + new_item_lines[insert_after + 1:]
            else:
                item_lines = new_item_lines

        # If priority changed, move the block
        if priority is not None and priority.upper() != item_section and priority.upper() in _ACTIVE_SECTIONS:
            # Remove item from current position
            remaining = lines[:item_start] + lines[item_end:]
            # Insert into new section
            new_section_marker = f"[{priority.upper()}]"
            inserted = False
            result2: list[str] = []
            i = 0
            while i < len(remaining):
                result2.append(remaining[i])
                if new_section_marker in remaining[i] and remaining[i].strip().startswith("##"):
                    i += 1
                    while i < len(remaining):
                        if remaining[i].startswith("### ["):
                            result2.extend(item_lines)
                            inserted = True
                            break
                        if remaining[i].startswith("## "):
                            result2.extend(item_lines)
                            inserted = True
                            break
                        result2.append(remaining[i])
                        i += 1
                    if inserted:
                        while i < len(remaining):
                            result2.append(remaining[i])
                            i += 1
                        break
                i += 1
            if not inserted:
                result2.extend(item_lines)
            lines = result2
        else:
            lines = lines[:item_start] + item_lines + lines[item_end:]

        PENDING_TRACKER.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return True
    except Exception as e:
        print(f"[bridge] No pude editar pendiente: {e}")
        return False


def delete_pending_task(item_id: str) -> bool:
    """Remove an item entirely from PENDING_TRACKER.md. Returns True if found."""
    try:
        if not PENDING_TRACKER.exists():
            return False
        content = PENDING_TRACKER.read_text(encoding="utf-8")
        lines = content.splitlines()

        item_start = -1
        item_end = -1
        for i, line in enumerate(lines):
            m = _ITEM_RE.match(line)
            if m and m.group(1) == item_id:
                item_start = i
                for j in range(i + 1, len(lines)):
                    if lines[j].startswith("### [") or lines[j].startswith("## "):
                        item_end = j
                        break
                if item_end == -1:
                    item_end = len(lines)
                break

        if item_start == -1:
            return False

        remaining = lines[:item_start] + lines[item_end:]
        PENDING_TRACKER.write_text("\n".join(remaining) + "\n", encoding="utf-8")
        return True
    except Exception as e:
        print(f"[bridge] No pude eliminar pendiente: {e}")
        return False


def change_pending_state(item_id: str, new_state: str) -> bool:
    """Change the state emoji of an item (🔵 🟡 🟢 🔴). Returns True if found."""
    valid_states = {"🔵", "🟡", "🟢", "🔴"}
    if new_state not in valid_states:
        return False
    try:
        if not PENDING_TRACKER.exists():
            return False
        content = PENDING_TRACKER.read_text(encoding="utf-8")
        lines = content.splitlines()

        for i, line in enumerate(lines):
            m = _ITEM_RE.match(line)
            if m and m.group(1) == item_id:
                # Update state in header line
                old_title = m.group(2).strip()
                lines[i] = f"### [{item_id}] {old_title} — {new_state}"
                # Update Estado line
                for j in range(i + 1, min(i + 5, len(lines))):
                    if _STATE_RE.match(lines[j]):
                        lines[j] = f"**Estado:** {new_state}"
                        break
                PENDING_TRACKER.write_text("\n".join(lines) + "\n", encoding="utf-8")
                return True
        return False
    except Exception as e:
        print(f"[bridge] No pude cambiar estado: {e}")
        return False


