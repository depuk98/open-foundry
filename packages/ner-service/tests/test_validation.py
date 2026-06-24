"""Tests for validation.py — gRPC input validation."""

import pytest
from ner_service.proto import ner_pb2
from ner_service.input.request import validate_extract_request, MAX_TEXT_LENGTH, ALLOWED_LABELS


def _make_request(text="test text", labels=None, min_confidence=0.0, max_entities=0, enable_llm=False):
    req = ner_pb2.ExtractRequest()
    req.text = text
    if labels:
        req.labels.extend(labels)
    req.min_confidence = min_confidence
    req.max_entities = max_entities
    req.enable_llm_review = enable_llm
    return req


class TestValidateExtractRequest:
    def test_valid_request_passes(self):
        req = _make_request("Hello world", labels=["Person"], min_confidence=0.5, max_entities=10)
        validate_extract_request(req)  # should not raise

    def test_empty_text_raises(self):
        req = _make_request("")
        with pytest.raises(ValueError, match="text must be non-empty"):
            validate_extract_request(req)

    def test_whitespace_only_text_raises(self):
        req = _make_request("   ")
        with pytest.raises(ValueError, match="text must be non-empty"):
            validate_extract_request(req)

    def test_oversized_text_raises(self):
        req = _make_request("x" * (MAX_TEXT_LENGTH + 1))
        with pytest.raises(ValueError, match="text exceeds maximum length"):
            validate_extract_request(req)

    def test_invalid_labels_raises(self):
        req = _make_request("test", labels=["Person", "InvalidType"])
        with pytest.raises(ValueError, match="unknown entity types"):
            validate_extract_request(req)

    def test_empty_labels_are_allowed(self):
        req = _make_request("test", labels=[])
        validate_extract_request(req)  # should not raise — defaults used

    def test_confidence_below_range_raises(self):
        req = _make_request("test", min_confidence=-0.1)
        with pytest.raises(ValueError, match="min_confidence must be between"):
            validate_extract_request(req)

    def test_confidence_above_range_raises(self):
        req = _make_request("test", min_confidence=1.5)
        with pytest.raises(ValueError, match="min_confidence must be between"):
            validate_extract_request(req)

    def test_max_entities_zero_uses_default(self):
        req = _make_request("test", max_entities=0)
        validate_extract_request(req)  # 0 = use default, should not raise

    def test_max_entities_negative_raises(self):
        req = _make_request("test", max_entities=-1)
        with pytest.raises(ValueError, match="max_entities must be >= 1"):
            validate_extract_request(req)

    def test_max_entities_exceeds_cap_raises(self):
        req = _make_request("test", max_entities=101)
        with pytest.raises(ValueError, match="max_entities must be <= 100"):
            validate_extract_request(req)


def test_allowed_labels_contains_all_nine():
    """Ensure the allowed label set matches the 9 entity types."""
    expected = {"Person", "Organization", "Location", "Equipment",
                "WeaponSystem", "MilitaryUnit", "ArmedGroup",
                "ConflictZone", "Event"}
    assert ALLOWED_LABELS == frozenset(expected)
