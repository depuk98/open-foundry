"""Shared constants for the NER service pipeline.

Single source of truth for type mappings and action strings used
across flair_stage, ensemble_merge, llm_reviewer, and server.
"""

# Flair tag -> internal entity type mapping.
# Used by flair_stage to map Flair output labels and by ensemble_merge
# to resolve conflicts between GLiNER zero-shot and Flair-standard tags.
FLAIR_TAG_MAP = {
    "PER": "Person",
    "ORG": "Organization",
    "LOC": "Location",
    "MISC": "Miscellaneous",
}

# LLM review action strings.
# llm_reviewer uses these as output labels; server uses them to map
# to protobuf EntityStatus values.
LLM_ACTION_CONFIRM = "confirm"
LLM_ACTION_CORRECT = "correct"
LLM_ACTION_ADD = "add"
LLM_ACTION_REJECT = "reject"
