"""Input validation for the NER gRPC service.

Validates all gRPC request fields at the handler boundary to prevent
bad requests from crashing the Python process.
"""

import ner_pb2

# Maximum text length (280 chars is a tweet, 10KB generous buffer for long articles)
MAX_TEXT_LENGTH = 10_240

# Allowed entity type labels
ALLOWED_LABELS = frozenset({
    "Person", "Organization", "Location",
    "Equipment", "WeaponSystem", "MilitaryUnit",
    "ArmedGroup", "ConflictZone", "Event",
})


def validate_extract_request(request: ner_pb2.ExtractRequest) -> None:
    """Validate an ExtractEntities gRPC request.

    Raises ValueError with a descriptive message on validation failure.
    """
    # Text: must be non-empty, within size limit
    text = request.text
    if not text or not text.strip():
        raise ValueError("text must be non-empty")
    if len(text) > MAX_TEXT_LENGTH:
        raise ValueError(f"text exceeds maximum length of {MAX_TEXT_LENGTH} characters")

    # Labels: if provided, must be from the allowed set. Empty = use defaults.
    if request.labels:
        unknown = [l for l in request.labels if l not in ALLOWED_LABELS]
        if unknown:
            raise ValueError(f"unknown entity types: {', '.join(sorted(unknown))}. Allowed: {', '.join(sorted(ALLOWED_LABELS))}")

    # min_confidence: must be in [0.0, 1.0]
    if request.min_confidence != 0.0:  # proto default is 0.0 -> use server default
        mc = request.min_confidence
        if mc < 0.0 or mc > 1.0:
            raise ValueError(f"min_confidence must be between 0.0 and 1.0, got {mc}")

    # max_entities: must be positive, reasonably bounded
    if request.max_entities != 0:  # proto default is 0 -> use server default
        me = request.max_entities
        if me < 1:
            raise ValueError(f"max_entities must be >= 1, got {me}")
        if me > 100:
            raise ValueError(f"max_entities must be <= 100, got {me}")
