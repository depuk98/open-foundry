"""Stage 1b: Flair standard entity extraction.

Loads the Flair ner-large model once at module initialization and exposes
a thread-safe extract function. Flair classifies PER/ORG/LOC/MISC with
very high confidence (94.1% F1 on CoNLL-03).

Flair's Classifier.predict() may not be thread-safe in all versions.
This module uses a lock to serialize calls.
"""

import logging
import threading
import time
from typing import Optional

import config
import constants
import logging_config
import text_utils

logger = logging_config.get_logger(__name__)

# Module-level model reference (loaded once, read-only after load)
_tagger: Optional[object] = None
_tagger_lock = threading.Lock()
_predict_lock = threading.Lock()
_load_attempted = False
_load_error: Optional[str] = None

# Flair tag -> our internal type mapping (imported from shared constants)
# noqa — imported for module-level access by tests
from constants import FLAIR_TAG_MAP as FLAIR_TYPE_MAP  # noqa: F401


def is_available() -> bool:
    """Whether Flair model is loaded and ready."""
    return _tagger is not None


def load_error() -> Optional[str]:
    """Error message if model failed to load, or None."""
    return _load_error


def load_model() -> None:
    """Load the Flair NER model in a background thread.

    Safe to call multiple times — subsequent calls are no-ops.
    """
    global _tagger, _load_attempted, _load_error

    if not config.ENABLE_FLAIR:
        logger.info("Flair disabled via ENABLE_FLAIR config")
        _load_attempted = True
        return

    with _tagger_lock:
        if _load_attempted:
            return
        _load_attempted = True

    logger.info("Loading Flair model", extra={"model": config.FLAIR_MODEL})

    last_error: Optional[str] = None
    for attempt in range(1, 4):
        try:
            from flair.data import Sentence
            from flair.nn import Classifier

            start = time.monotonic()
            tagger = Classifier.load(config.FLAIR_MODEL)
            elapsed = time.monotonic() - start

            with _tagger_lock:
                _tagger = tagger

            logger.info("Flair model loaded", extra={
                "model": config.FLAIR_MODEL,
                "load_time_seconds": round(elapsed, 1),
                "attempt": attempt,
            })
            return

        except Exception as exc:
            last_error = str(exc)
            logger.warning("Flair model load failed", extra={
                "model": config.FLAIR_MODEL,
                "attempt": attempt,
                "error": last_error,
            })
            if attempt < 3:
                delay = 2 ** attempt
                logger.info("Retrying Flair load", extra={"delay_seconds": delay})
                time.sleep(delay)

    with _tagger_lock:
        _load_error = f"Failed to load Flair model after 3 attempts: {last_error or 'unknown'}"
    logger.error(_load_error)


def extract_entities(text: str) -> list[dict]:
    """Extract entities from text using Flair.

    Args:
        text: Raw text to extract entities from.

    Returns:
        List of entity dicts with keys: text, type, confidence, context.
        Returns empty list if model is not loaded.
    """
    tagger = _tagger
    if tagger is None:
        return []

    if not text or not text.strip():
        return []

    try:
        from flair.data import Sentence

        sentence = Sentence(text)

        with _predict_lock:
            tagger.predict(sentence)

        results: list[dict] = []
        for entity in sentence.get_spans("ner"):
            name = entity.text.strip()
            flair_type = entity.tag
            confidence = float(entity.score)

            if not name:
                continue

            results.append({
                "text": name,
                "type": FLAIR_TYPE_MAP.get(flair_type, flair_type),
                "confidence": confidence,
                "context": text_utils.extract_context(text, name),
                "_flair_tag": flair_type,
            })

        return results

    except Exception as exc:
        logger.warning("Flair extraction error", extra={"error": str(exc), "text_length": len(text)})
        return []

