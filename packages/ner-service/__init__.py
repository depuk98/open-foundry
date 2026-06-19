"""NER Service — Three-stage entity extraction pipeline.

Provides gRPC-based named entity recognition using GLiNER (zero-shot),
Flair (94.1% F1 standard NER), and optional phi4-mini LLM verification
via Ollama.
"""

__all__ = [
    "config",
    "logging_config",
]
