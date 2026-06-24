"""Configuration, constants, and structured logging for the NER service.

All settings read from environment variables with sensible defaults.
Shared constants for type mappings and LLM action strings.
JSON-structured logging compatible with pino format.
"""

import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any


# ============================================================================
# Environment helpers
# ============================================================================

def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


def _env_bool(key: str, default: bool) -> bool:
    val = os.environ.get(key, "").lower()
    if val in ("1", "true", "yes", "on"):
        return True
    if val in ("0", "false", "no", "off"):
        return False
    return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ[key])
    except (KeyError, ValueError):
        return default


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ[key])
    except (KeyError, ValueError):
        return default


# ============================================================================
# Model selection
# ============================================================================

GLINER_MODEL = _env("GLINER_MODEL", "gliner-community/gliner_small-v2.5")
"""HuggingFace model ID for GLiNER zero-shot NER."""

FLAIR_MODEL = _env("FLAIR_MODEL", "ner-large")
"""Flair model name for standard PER/ORG/LOC NER."""


# ============================================================================
# Ollama / LLM
# ============================================================================

OLLAMA_HOST = _env("OLLAMA_HOST", "host.docker.internal:11434")
"""Ollama API base URL (host:port)."""

OLLAMA_MODEL = _env("OLLAMA_MODEL", "phi4-mini")
"""Ollama model name for Stage 3 LLM review."""


# ============================================================================
# gRPC server
# ============================================================================

GRPC_PORT = _env("GRPC_PORT", "50052")
"""Port the gRPC server listens on."""

GRPC_MAX_WORKERS = _env_int("GRPC_MAX_WORKERS", 10)
"""Maximum concurrent gRPC request handlers."""


# ============================================================================
# Extraction defaults
# ============================================================================

MIN_CONFIDENCE = _env_float("MIN_CONFIDENCE", 0.4)
"""Default minimum confidence threshold for entity acceptance."""

MAX_ENTITIES = _env_int("MAX_ENTITIES", 20)
"""Maximum entities returned per extraction request."""


# ============================================================================
# Feature flags
# ============================================================================

ENABLE_FLAIR = _env_bool("ENABLE_FLAIR", True)
"""Whether to load and use Flair (may be disabled for lighter deployments)."""

ENABLE_LLM = _env_bool("ENABLE_LLM", True)
"""Whether the Stage 3 LLM reviewer is available."""

LLM_TIMEOUT_SECONDS = _env_float("LLM_TIMEOUT_SECONDS", 3.0)
"""HTTP timeout for Ollama API calls."""

LLM_MAX_RETRIES = _env_int("LLM_MAX_RETRIES", 1)
"""Retries for Ollama API calls on transient failures."""


# ============================================================================
# Observability
# ============================================================================

LOG_LEVEL = _env("LOG_LEVEL", "INFO")
"""Python logging level (DEBUG, INFO, WARNING, ERROR)."""

EXTRACTION_TIMEOUT = _env_float("EXTRACTION_TIMEOUT", 10.0)
"""Maximum seconds to wait for a Stage 1 model to complete."""


# ============================================================================
# Model cache directories
# ============================================================================

HF_HOME = _env("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
"""HuggingFace cache directory for downloaded models."""

FLAIR_CACHE_ROOT = _env("FLAIR_CACHE_ROOT", os.path.expanduser("~/.flair"))
"""Flair cache directory for downloaded models."""


# ============================================================================
# Default entity labels
# ============================================================================

DEFAULT_LABELS = [
    "Person",
    "Organization",
    "Location",
    "Equipment",
    "WeaponSystem",
    "MilitaryUnit",
    "ArmedGroup",
    "ConflictZone",
    "Event",
]
"""Default entity types extracted when the gRPC request does not specify labels."""


# ============================================================================
# Constants — type mappings and action strings
# ============================================================================

FLAIR_TAG_MAP = {
    "PER": "Person",
    "ORG": "Organization",
    "LOC": "Location",
    "MISC": "Miscellaneous",
}
"""Flair tag to internal entity type mapping."""

LLM_ACTION_CONFIRM = "confirm"
LLM_ACTION_CORRECT = "correct"
LLM_ACTION_ADD = "add"
LLM_ACTION_REJECT = "reject"
"""LLM review action strings."""


# ============================================================================
# Structured JSON logging
# ============================================================================

class JsonFormatter(logging.Formatter):
    """Formats log records as JSON lines compatible with pino format."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry: dict[str, Any] = {
            "level": record.levelno,
            "time": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "msg": record.getMessage(),
        }

        for key, value in record.__dict__.items():
            if key not in {
                "args", "asctime", "created", "exc_info", "exc_text",
                "filename", "funcName", "levelname", "levelno", "lineno",
                "module", "msecs", "message", "msg", "name", "pathname",
                "process", "processName", "relativeCreated", "stack_info",
                "thread", "threadName",
            }:
                log_entry[key] = value

        if record.exc_info and record.exc_info[1]:
            log_entry["err"] = str(record.exc_info[1])

        return json.dumps(log_entry, default=str)


def setup_logging(level: str = "INFO") -> None:
    """Configure root logger with JSON formatting."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    root.handlers.clear()
    root.addHandler(handler)


def get_logger(name: str) -> logging.Logger:
    """Get a structured JSON logger for the given module name."""
    return logging.getLogger(name)
