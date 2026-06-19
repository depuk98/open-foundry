"""Stage 3: LLM verification via Ollama.

Calls phi4-mini (or configured model) on host Ollama to verify, correct, or
reject entity candidates from Stage 2. Only invoked when the merged result
contains conflicts or low-confidence entities.
"""

import hashlib
import json
import logging
import re
import time
from typing import Optional

import httpx

import config
import constants
import logging_config
import text_utils
import ner_pb2

logger = logging_config.get_logger(__name__)

LLM_SYSTEM_PROMPT = """You are an NER verification agent. Your ONLY job is to review entity candidates and return a strict JSON array.

RULES YOU MUST FOLLOW:
1. Output ONLY a valid JSON array — no markdown, no explanation, no text before/after
2. Use DOUBLE QUOTES for all keys and string values (JSON standard)
3. Action must be one of: "confirm", "correct", "reject", "add"
4. Type must be from: Person, Organization, Location, Equipment, WeaponSystem, MilitaryUnit, ArmedGroup, ConflictZone, Event
5. Confidence must be a number between 0.0 and 1.0
6. "add" action ONLY for extremely obvious missing entities — use sparingly

EXAMPLE OUTPUT (this exact format):
[{"text":"Bakhmut","type":"Location","confidence":0.97,"action":"confirm","reasoning":"City in Ukraine"}]

WRONG FORMATS (never do these):
- Do NOT wrap in {"array": [...]}
- Do NOT use single quotes
- Do NOT add text before or after the JSON
- Do NOT use markdown code blocks"""


def _build_candidates_text(entities: list[dict]) -> str:
    """Format entity candidates for LLM prompt."""
    lines = []
    for i, ent in enumerate(entities, 1):
        g_conf = ent.get("gliner_confidence", 0)
        f_conf = ent.get("flair_confidence", 0)
        status_name = ent.get("status_name", "UNKNOWN")
        lines.append(
            f'  {i}. [{ent["type"]}] "{ent["text"]}" '
            f"(GLiNER:{g_conf:.2f}, Flair:{f_conf:.2f}) — {status_name}"
        )
    return "\n".join(lines)


def _build_prompt(text: str, candidates: list[dict]) -> str:
    """Build the full LLM verification prompt."""
    candidates_text = _build_candidates_text(candidates)
    return (
        f"Original text: \"{text}\"\n\n"
        f"Candidate entities to review:\n{candidates_text}\n\n"
        "Review each candidate. For each one, decide: confirm (keep), correct (fix span/type), "
        "reject (false positive), or add (missed entity).\n"
        "Return ONLY a JSON array. Nothing else. Double quotes only."
    )


def _parse_llm_response(raw: str) -> list[dict]:
    """Parse LLM JSON response, handling various phi4-mini output formats.

    phi4-mini with format=json sometimes returns:
    1. Valid JSON array: [{"text": "...", ...}]
    2. Wrapped JSON: {"array": [{"text": "...", ...}]}
    3. Python-style dicts inside JSON strings
    4. Markdown-wrapped JSON
    5. Plain text with embedded dicts
    """
    # Try direct JSON parsing first
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict) and "array" in parsed:
            return _parse_llm_response(json.dumps(parsed["array"]))
        if isinstance(parsed, list):
            return parsed
    except (json.JSONDecodeError, TypeError):
        pass

    # Try extracting from markdown code blocks
    match = re.search(r'```(?:json)?\s*(\[.*?\])\s*```', raw, re.DOTALL)
    if match:
        return _parse_llm_response(match.group(1))

    # Try finding JSON array in response
    match = re.search(r'\[[\s\S]*\]', raw)
    if match:
        try:
            arr = json.loads(match.group(0))
            if isinstance(arr, list):
                return arr
        except json.JSONDecodeError:
            pass

    # phi4-mini sometimes wraps Python dicts in JSON strings like:
    # {"[{'text': '...', ...}]": "{'text': '...', ...}"}
    # Extract Python-style dicts using regex
    py_matches = re.findall(r"\{'text':\s*'[^']*',\s*'type':\s*'[^']*',\s*'confidence':\s*[\d.]+,\s*'action':\s*'[^']*'(?:,\s*'reasoning':\s*'[^']*')?\}", raw)
    if py_matches:
        results = []
        for m in py_matches:
            try:
                d = _parse_python_dict(m)
                if d:
                    results.append(d)
            except Exception:
                continue
        if results:
            return results

    logger.warning("Failed to parse LLM response JSON", extra={
        "response_length": len(raw),
        "response_hash": hashlib.sha256(raw.encode()).hexdigest()[:16],
    })
    return []


def _parse_python_dict(raw: str) -> dict | None:
    """Parse a Python-style dict literal (single quotes) into a regular dict."""
    import ast
    try:
        return ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return None


def review(
    text: str,
    candidates: list[dict],
    timeout: Optional[float] = None,
) -> list[dict]:
    """Review entity candidates using the LLM.

    Args:
        text: Original source text.
        candidates: List of candidate entity dicts from Stage 2 merge.
        timeout: HTTP timeout in seconds. Defaults to config.LLM_TIMEOUT_SECONDS.

    Returns:
        List of verified entity dicts with keys: text, type, confidence, action, reasoning.
        Returns original candidates unchanged if LLM is unavailable or fails.
    """
    if not candidates:
        return []

    timeout = timeout or config.LLM_TIMEOUT_SECONDS
    url = f"http://{config.OLLAMA_HOST}/api/chat"

    prompt = _build_prompt(text, candidates)

    payload = {
        "model": config.OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": LLM_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "format": "json",
        "stream": False,
        "options": {
            "temperature": 0.1,
            "num_predict": 1024,
        },
    }

    for attempt in range(config.LLM_MAX_RETRIES + 1):
        try:
            start = time.monotonic()
            response = httpx.post(url, json=payload, timeout=timeout)
            response.raise_for_status()
            elapsed = time.monotonic() - start

            body = response.json()
            content = body.get("message", {}).get("content", "")

            reviewed = _parse_llm_response(content)
            if reviewed:
                logger.info("LLM review complete", extra={
                    "candidates_count": len(candidates),
                    "reviewed_count": len(reviewed),
                    "latency_ms": round(elapsed * 1000, 1),
                    "attempt": attempt + 1,
                })
                return reviewed

        except httpx.TimeoutException:
            logger.warning("LLM review timed out", extra={"timeout": timeout, "attempt": attempt + 1})
        except httpx.HTTPStatusError as exc:
            logger.warning("LLM review HTTP error", extra={
                "status": exc.response.status_code,
                "attempt": attempt + 1,
            })
        except Exception as exc:
            logger.warning("LLM review failed", extra={"error": str(exc), "attempt": attempt + 1})

    logger.warning("LLM review failed after all retries — returning Stage 2 output unchanged")
    return candidates


def apply_review(
    merged: list[dict],
    reviewed: list[dict],
    source_text: str = "",
) -> list[dict]:
    """Apply LLM review actions to the merged entity list.

    Merges original context from the merged list back into LLM-reviewed
    entities. LLMs do not return context — only span, type, and confidence.
    Context must be recovered from the original merged entities.

    Args:
        merged: Original Stage 2 merged entities (with context, gliner_confidence, etc).
        reviewed: LLM verification output (list of {text, type, confidence, action, reasoning}).
        source_text: Original source text (for computing context on ADD/corrected entities).

    Returns:
        Final entity list after applying confirm/correct/reject/add actions
        with preserved context strings.
    """
    # Index merged entities by normalized text for context lookup
    merged_by_span: dict[str, dict] = {}
    for m in merged:
        key = m.get("text", "").strip().lower()
        if key:
            merged_by_span[key] = m

    final: list[dict] = []

    for item in reviewed:
        if not isinstance(item, dict):
            logger.warning("LLM returned non-dict item, skipping", extra={"item": str(item)[:200]})
            continue

        action = item.get("action", "confirm")
        name = item.get("text", "").strip()
        norm = name.lower()

        if action == constants.LLM_ACTION_REJECT:
            continue

        # Recover context from original merged entity
        original = merged_by_span.get(norm, {})
        context = original.get("context", "")
        if not context and source_text:
            context = text_utils.extract_context(source_text, name)

        if action == constants.LLM_ACTION_ADD:
            final.append({
                "text": name,
                "type": item.get("type", ""),
                "confidence": float(item.get("confidence", 0.8)),
                "context": context,
                "action": constants.LLM_ACTION_ADD,
                "reasoning": item.get("reasoning", ""),
            })
        elif action == constants.LLM_ACTION_CORRECT:
            final.append({
                "text": name,
                "type": item.get("type", ""),
                "confidence": float(item.get("confidence", 0.8)),
                "context": context,
                "action": constants.LLM_ACTION_CORRECT,
                "reasoning": item.get("reasoning", ""),
            })
        elif action == constants.LLM_ACTION_CONFIRM:
            final.append({
                "text": name,
                "type": item.get("type", ""),
                "confidence": float(item.get("confidence", 0.8)),
                "context": context,
                "action": constants.LLM_ACTION_CONFIRM,
                "reasoning": item.get("reasoning", ""),
            })

    return final


def should_review(merged: list[dict], conflict_count: int, enable_llm: bool) -> bool:
    """Determine whether Stage 3 LLM review should be invoked.

    Invoked when:
    - LLM is enabled in config AND request
    - There are conflicts (>0) OR entities with ENTITY_STATUS_CONFLICT status
    - OR there are low-confidence single-source entities (< 0.6)
    """
    if not enable_llm:
        return False
    if not config.ENABLE_LLM:
        return False
    if conflict_count > 0:
        return True

    # Check for explicitly conflicted or low-confidence entities
    for ent in merged:
        status = ent.get("status", 0)
        if status == ner_pb2.ENTITY_STATUS_CONFLICT:
            return True

        conf = ent.get("confidence", 0.0)
        if 0.0 < conf < 0.6:
            return True

    return False
