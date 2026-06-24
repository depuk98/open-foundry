"""NER Service — Three-stage entity extraction pipeline."""

from ner_service.config import (
    DEFAULT_LABELS,
    EXTRACTION_TIMEOUT,
    FLAIR_TAG_MAP,
    FLAIR_CACHE_ROOT,
    GLINER_MODEL,
    HF_HOME,
    LLM_ACTION_ADD,
    LLM_ACTION_CONFIRM,
    LLM_ACTION_CORRECT,
    LLM_ACTION_REJECT,
    LOG_LEVEL,
    MAX_ENTITIES,
    MIN_CONFIDENCE,
    get_logger,
    setup_logging,
)

from ner_service.input.request import (
    ALLOWED_LABELS,
    MAX_TEXT_LENGTH,
    validate_extract_request,
)

from ner_service.pipeline.ensemble import MergedEntity, merge

__all__ = [
    "get_logger",
    "setup_logging",
    "merge",
    "MergedEntity",
    "ALLOWED_LABELS",
    "DEFAULT_LABELS",
    "FLAIR_TAG_MAP",
]
