"""Tests for llm_validation.py — LLM output sanitization."""

import pytest
from ner_service.llm.validation import validate_llm_output


class TestValidateLlmOutput:
    def test_valid_confirm_passes(self):
        reviewed = [
            {"text": "Biden", "type": "Person", "confidence": 0.9, "action": "confirm", "reasoning": "correct"},
        ]
        result = validate_llm_output(reviewed, "President Biden spoke", {"biden"})
        assert len(result) == 1

    def test_valid_correct_action(self):
        reviewed = [
            {"text": "Biden", "type": "Person", "confidence": 0.9, "action": "correct", "reasoning": "fix span"},
        ]
        source = "President Biden spoke today"
        result = validate_llm_output(reviewed, source, {"president"})
        assert len(result) == 1
        assert result[0]["action"] == "correct"

    def test_reject_action_is_dropped(self):
        reviewed = [
            {"text": "today", "type": "Person", "confidence": 0.3, "action": "reject", "reasoning": "not a person"},
        ]
        result = validate_llm_output(reviewed, "today is Monday", {"today"})
        assert len(result) == 0

    def test_invalid_action_rejected(self):
        reviewed = [
            {"text": "Test", "type": "Person", "confidence": 0.9, "action": "delete", "reasoning": "invalid"},
        ]
        result = validate_llm_output(reviewed, "Test text", {"test"})
        assert len(result) == 0

    def test_invalid_entity_type_rejected(self):
        reviewed = [
            {"text": "Bakhmut", "type": "City", "confidence": 0.9, "action": "confirm", "reasoning": "ok"},
        ]
        result = validate_llm_output(reviewed, "Bakhmut is under attack", {"bakhmut"})
        assert len(result) == 0

    def test_corrected_span_not_in_source_rejected(self):
        reviewed = [
            {"text": "HallucinatedName", "type": "Person", "confidence": 0.9, "action": "correct", "reasoning": "made up"},
        ]
        result = validate_llm_output(reviewed, "The president spoke.", {"president"})
        assert len(result) == 0

    def test_added_span_not_in_source_rejected(self):
        reviewed = [
            {"text": "Nowhere", "type": "Location", "confidence": 0.85, "action": "add", "reasoning": "missed"},
        ]
        result = validate_llm_output(reviewed, "Normal text about politics.", {"politics"})
        assert len(result) == 0

    def test_added_span_in_source_passes(self):
        reviewed = [
            {"text": "Sudan", "type": "Location", "confidence": 0.85, "action": "add", "reasoning": "missed"},
        ]
        result = validate_llm_output(reviewed, "Fighting continues in Sudan.", {"fighting"})
        assert len(result) == 1

    def test_confidence_clamped(self):
        reviewed = [
            {"text": "Test", "type": "Person", "confidence": 2.5, "action": "confirm", "reasoning": "ok"},
        ]
        result = validate_llm_output(reviewed, "Test text here", {"test"})
        assert len(result) == 1

    def test_non_dict_item_skipped(self):
        reviewed = [
            "not a dict",
            {"text": "Biden", "type": "Person", "confidence": 0.9, "action": "confirm", "reasoning": "ok"},
        ]
        result = validate_llm_output(reviewed, "President Biden spoke", {"biden"})
        assert len(result) == 1
        assert result[0]["text"] == "Biden"

    def test_confirm_span_not_in_source_still_passes(self):
        """Confirm action does NOT require span in source — LLM is confirming what models found."""
        reviewed = [
            {"text": "Putin", "type": "Person", "confidence": 0.95, "action": "confirm", "reasoning": "correct"},
        ]
        # "Putin" in source text — confirm always allowed for any span
        result = validate_llm_output(reviewed, "Putin addressed the nation", {"putin"})
        assert len(result) == 1
