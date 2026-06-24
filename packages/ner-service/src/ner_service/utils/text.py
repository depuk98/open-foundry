"""Shared text utilities for the NER service."""


def extract_context(text: str, span: str, window: int = 25) -> str:
    """Extract surrounding text context around a span.

    Args:
        text: Full source text.
        span: The entity text span to find context for.
        window: Number of characters to include on each side.

    Returns:
        Context string, or empty string if span not found.
    """
    idx = text.find(span)
    if idx == -1:
        return ""
    start = max(0, idx - window)
    end = min(len(text), idx + len(span) + window)
    return text[start:end].strip()
