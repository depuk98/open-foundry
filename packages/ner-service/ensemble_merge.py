"""Stage 2: Ensemble merge of GLiNER and Flair outputs.

Merges entity lists using confidence-weighted union with conflict detection.
Implements type mapping (GLiNER label + Flair tag -> resolved type) and
conflict resolution rules.

Output statuses:
  CONFIRMED       — Both models agree on span AND type
  SINGLE_SOURCE   — Only one model found the span
  GLINER_ENRICHED — Flair says MISC, GLiNER has a specific type
  CONFLICT        — Same span, different types between models (routed to Stage 3)
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

import constants
import ner_pb2
import logging_config

logger = logging_config.get_logger(__name__)

# Flair tag -> our internal type mapping (repeated from flair_stage for
# independence — merge module shouldn't import flair_stage directly).
# Flair tag -> internal type mapping (from shared constants)
FLAIR_TAG_MAP = constants.FLAIR_TAG_MAP

# GLiNER label + Flair tag -> resolved type mapping.
# When both give specific types and they match, it's CONFIRMED.
# When Flair says MISC and GLiNER has a specific type, it's GLINER_ENRICHED.
# When both give different specific types, it's a CONFLICT.
TYPE_RESOLUTION: dict[tuple[str, str], tuple[str, bool]] = {
    ("Person", "PER"): ("Person", True),
    ("Organization", "ORG"): ("Organization", True),
    ("Location", "LOC"): ("Location", True),
    ("Equipment", "MISC"): ("Equipment", False),
    ("WeaponSystem", "MISC"): ("WeaponSystem", False),
    ("MilitaryUnit", "ORG"): ("MilitaryUnit", False),
    ("MilitaryUnit", "MISC"): ("MilitaryUnit", False),
    ("ArmedGroup", "ORG"): ("ArmedGroup", False),
    ("ArmedGroup", "MISC"): ("ArmedGroup", False),
    ("ConflictZone", "LOC"): ("ConflictZone", False),
    ("ConflictZone", "MISC"): ("ConflictZone", False),
    ("Event", "MISC"): ("Event", False),
    ("Event", "ORG"): ("Event", False),
    ("Event", "LOC"): ("Event", False),
}


@dataclass
class MergedEntity:
    """A merged entity with its pipeline status."""

    text: str
    type: str
    confidence: float
    context: str = ""
    status: int = ner_pb2.ENTITY_STATUS_UNSPECIFIED
    gliner_confidence: float = 0.0
    flair_confidence: float = 0.0


def merge(
    gliner_entities: list[dict],
    flair_entities: list[dict],
    min_confidence: float = 0.4,
) -> tuple[list[MergedEntity], int]:
    """Merge GLiNER and Flair entity lists.

    Args:
        gliner_entities: GLiNER output dicts (text, type, confidence, context).
        flair_entities: Flair output dicts (text, type, confidence, context, _flair_tag).
        min_confidence: Entities below this threshold from single-source models are discarded.

    Returns:
        Tuple of (merged entity list, conflict count).
    """
    merged: dict[str, MergedEntity] = {}
    conflicts = 0

    # Index Flair entities by normalized span for lookup.
    # Also track original lengths so we can avoid case-only collisions
    # where a short span (e.g. "us" Flair MISC) collides with a longer
    # span (e.g. "U.S." GLiNER Location) that share the same normalized key.
    flair_by_span: dict[str, dict] = {}
    flair_orig_text: dict[str, str] = {}
    for fe in flair_entities:
        key = fe["text"].strip().lower()
        if key:
            flair_by_span[key] = fe
            flair_orig_text[key] = fe["text"].strip()

    # ---- Pass 1: GLiNER entities ----
    for ge in gliner_entities:
        name = ge.get("text", "").strip()
        etype = ge.get("type", "")
        conf = float(ge.get("confidence", 0.0))

        if not name or conf < min_confidence:
            continue

        norm = name.lower()
        flair_match = flair_by_span.get(norm)

        if flair_match is None:
            # Only GLiNER found it — accept if confidence is sufficient
            merged[norm] = MergedEntity(
                text=name,
                type=etype,
                confidence=conf,
                context=ge.get("context", ""),
                status=ner_pb2.ENTITY_STATUS_SINGLE_SOURCE,
                gliner_confidence=conf,
            )
            continue

        # Both found this span — check for case-only collision.
        # If the original texts have materially different lengths,
        # they're likely different entities. Treat as separate to
        # avoid false merges (e.g. "U.S." Location vs "us" pronoun).
        flair_orig = flair_orig_text.get(norm, "")
        len_diff = abs(len(name) - len(flair_orig))
        is_length_collision = (len(name) <= 3 and len(flair_orig) > 3) or \
                              (len(flair_orig) <= 3 and len(name) > 3) or \
                              len_diff > max(len(name), len(flair_orig))

        if is_length_collision:
            merged[norm] = MergedEntity(
                text=name,
                type=etype,
                confidence=conf,
                context=ge.get("context", ""),
                status=ner_pb2.ENTITY_STATUS_SINGLE_SOURCE,
                gliner_confidence=conf,
            )
            continue

        # Both found this span — resolve type
        flair_type = flair_match.get("type", "")
        flair_tag = flair_match.get("_flair_tag", flair_match.get("type", ""))
        flair_conf = float(flair_match.get("confidence", 0.0))

        resolution = TYPE_RESOLUTION.get((etype, flair_tag))

        if resolution is not None:
            resolved_type, is_confirmed = resolution
            status = ner_pb2.ENTITY_STATUS_CONFIRMED if is_confirmed else ner_pb2.ENTITY_STATUS_GLINER_ENRICHED
            merged[norm] = MergedEntity(
                text=name,
                type=resolved_type,
                confidence=max(conf, flair_conf),
                context=ge.get("context", flair_match.get("context", "")),
                status=status,
                gliner_confidence=conf,
                flair_confidence=flair_conf,
            )
        elif etype == flair_type:
            # Same type, not in resolution table — still confirmed
            merged[norm] = MergedEntity(
                text=name,
                type=etype,
                confidence=max(conf, flair_conf),
                context=ge.get("context", flair_match.get("context", "")),
                status=ner_pb2.ENTITY_STATUS_CONFIRMED,
                gliner_confidence=conf,
                flair_confidence=flair_conf,
            )
        else:
            # Different types, no resolution mapping — CONFLICT
            # Prefer GLiNER's type for domain entities, Flair for standard
            if etype in ("Equipment", "WeaponSystem", "MilitaryUnit", "ArmedGroup", "ConflictZone", "Event"):
                resolved_type = etype
            else:
                resolved_type = flair_type
            conflicts += 1
            merged[norm] = MergedEntity(
                text=name,
                type=resolved_type,
                confidence=max(conf, flair_conf),
                context=ge.get("context", flair_match.get("context", "")),
                status=ner_pb2.ENTITY_STATUS_CONFLICT,
                gliner_confidence=conf,
                flair_confidence=flair_conf,
            )

    # ---- Pass 2: Flair-only entities ----
    gliner_spans = {e["text"].strip().lower() for e in gliner_entities}
    for fe in flair_entities:
        name = fe.get("text", "").strip()
        flair_type = fe.get("type", "Miscellaneous")
        flair_conf = float(fe.get("confidence", 0.0))

        if not name or name.lower() in gliner_spans:
            continue

        if flair_conf < min_confidence:
            continue

        if name.lower() not in merged:
            merged[name.lower()] = MergedEntity(
                text=name,
                type=flair_type,
                confidence=flair_conf,
                context=fe.get("context", ""),
                status=ner_pb2.ENTITY_STATUS_SINGLE_SOURCE,
                flair_confidence=flair_conf,
            )

    merged_list = sorted(merged.values(), key=lambda e: e.confidence, reverse=True)

    logger.debug("Merge complete", extra={
        "gliner_count": len(gliner_entities),
        "flair_count": len(flair_entities),
        "merged_count": len(merged_list),
        "conflicts": conflicts,
    })

    return merged_list, conflicts
