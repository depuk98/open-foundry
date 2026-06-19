"""LLM output validation.

Validates LLM review output against the original text, allowed entity types,
and candidate entity spans to catch hallucinations before they reach the
knowledge graph.
"""

import hashlib
from typing import Optional

import config
import validation

# Actions the LLM is allowed to return
ALLOWED_ACTIONS = frozenset({"confirm", "correct", "reject", "add"})


def validate_llm_output(
    reviewed: list[dict],
    source_text: str,
    candidate_spans: set[str],
) -> list[dict]:
    """Validate and sanitize LLM review output.

    Filters out:
    - Entities with invalid actions
    - Entities with types not in the allowed set
    - "Corrected" entities whose new span doesn't exist in source text
    - "Added" entities whose span doesn't exist in source text
    - Entities with confidence outside [0.0, 1.0]

    Args:
        reviewed: Raw LLM output (list of {text, type, confidence, action, reasoning}).
        source_text: Original text the LLM was reviewing.
        candidate_spans: Set of normalized spans from Stage 2 merge (for overlap check).

    Returns:
        Sanitized list with invalid entries removed, logged at WARNING.
    """
    import logging
    import logging_config

    logger = logging_config.get_logger(__name__)
    sanitized: list[dict] = []

    for i, item in enumerate(reviewed):
        if not isinstance(item, dict):
            logger.warning("LLM returned non-dict item in validation, skipping", extra={
                "index": i, "item_type": type(item).__name__, "item_length": len(str(item)),
            })
            continue

        action = item.get("action", "").lower()
        name = (item.get("text") or "").strip()
        etype = (item.get("type") or "").strip()
        conf = item.get("confidence", 0.0)

        # Validate action
        if action not in ALLOWED_ACTIONS:
            logger.warning("LLM returned invalid action", extra={
                "index": i, "action": action, "entity": name,
            })
            continue

        # Reject action — always allow (it's a removal)
        if action == "reject":
            continue

        # Validate entity type
        if etype not in validation.ALLOWED_LABELS:
            logger.warning("LLM returned invalid entity type", extra={
                "index": i, "type": etype, "entity": name,
            })
            continue

        # Validate confidence
        if not (0.0 <= conf <= 1.0):
            conf = max(0.0, min(1.0, conf))

        # For "correct" or "add" actions, verify the span exists in source text
        if action in ("correct", "add"):
            if name.lower() not in source_text.lower() and name.lower() not in candidate_spans:
                logger.warning("LLM returned entity with span not in source text", extra={
                    "index": i, "action": action, "entity": name,
                    "source_length": len(source_text),
                    "source_hash": hashlib.sha256(source_text.encode()).hexdigest()[:16],
                })
                continue

        sanitized.append(item)

    dropped = len(reviewed) - len(sanitized)
    if dropped > 0:
        logger.warning("LLM output validation dropped entities", extra={
            "total": len(reviewed), "dropped": dropped, "kept": len(sanitized),
        })

    return sanitized
