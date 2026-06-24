"""Stage 1a: GLiNER zero-shot entity extraction.

Loads the GLiNER model once at module initialization and exposes a
thread-safe extract function. GLiNER extracts any entity type by name
(zero-shot) — Person, Organization, Location, Equipment, WeaponSystem,
MilitaryUnit, ArmedGroup, ConflictZone, Event.
"""

import logging
import threading
import time
from typing import Optional

from ner_service.config import EXTRACTION_TIMEOUT, GLINER_MODEL, get_logger
from ner_service.utils.text import extract_context

logger = get_logger(__name__)

# Module-level model reference (loaded once, read-only after load)
_model: Optional[object] = None
_model_lock = threading.Lock()
_load_attempted = False
_load_error: Optional[str] = None


def is_available() -> bool:
    """Whether GLiNER model is loaded and ready."""
    return _model is not None


def load_error() -> Optional[str]:
    """Error message if model failed to load, or None."""
    return _load_error


def load_model() -> None:
    """Load the GLiNER model in a background thread.

    Safe to call multiple times — subsequent calls are no-ops.
    Sets the module-level _model reference on success.
    """
    global _model, _load_attempted, _load_error

    with _model_lock:
        if _load_attempted:
            return
        _load_attempted = True

    logger.info("Loading GLiNER model", extra={"model": GLINER_MODEL})

    last_error: Optional[str] = None
    for attempt in range(1, 4):
        try:
            from gliner import GLiNER

            start = time.monotonic()
            model = GLiNER.from_pretrained(GLINER_MODEL)
            elapsed = time.monotonic() - start

            with _model_lock:
                _model = model

            logger.info("GLiNER model loaded", extra={
                "model": GLINER_MODEL,
                "load_time_seconds": round(elapsed, 1),
                "attempt": attempt,
            })
            return

        except Exception as exc:
            last_error = str(exc)
            logger.warning("GLiNER model load failed", extra={
                "model": GLINER_MODEL,
                "attempt": attempt,
                "error": last_error,
            })
            if attempt < 3:
                delay = 2 ** attempt
                logger.info("Retrying GLiNER load", extra={"delay_seconds": delay})
                time.sleep(delay)

    with _model_lock:
        _load_error = f"Failed to load GLiNER model after 3 attempts: {last_error or 'unknown'}"
    logger.error(_load_error)


def extract_entities(text: str, labels: list[str], min_confidence: float = 0.4) -> list[dict]:
    """Extract entities from text using GLiNER.

    Args:
        text: Raw text to extract entities from.
        labels: Entity type labels for zero-shot extraction.
        min_confidence: Minimum confidence threshold (0.0–1.0).

    Returns:
        List of entity dicts with keys: text, type, confidence, context.
        Returns empty list if model is not loaded.
    """
    model = _model
    if model is None:
        return []

    if not text or not text.strip():
        return []

    try:
        raw_entities = model.predict_entities(text, labels, threshold=min_confidence)
    except Exception as exc:
        logger.warning("GLiNER extraction error", extra={"error": str(exc), "text_length": len(text)})
        return []

    results: list[dict] = []
    for ent in raw_entities:
        name = ent.get("text", "").strip()
        etype = ent.get("label", "")
        confidence = float(ent.get("score", 0.0))

        if not name or confidence < min_confidence:
            continue

        results.append({
            "text": name,
            "type": etype,
            "confidence": confidence,
            "context": extract_context(text, name),
        })

    return results
