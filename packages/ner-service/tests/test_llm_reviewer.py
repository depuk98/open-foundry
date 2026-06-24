"""Tests for llm_reviewer.py — Stage 3 LLM verification."""

import json

import pytest
from ner_service.proto import ner_pb2
from unittest.mock import patch, MagicMock

from ner_service.llm.reviewer import (
    review, apply_review, should_review,
    _parse_llm_response, _build_prompt, _build_candidates_text,
)


def make_candidate(text: str, etype: str, confidence: float = 0.8,
                   gliner_conf: float = 0.0, flair_conf: float = 0.0,
                   status_name: str = "CONFIRMED") -> dict:
    return {
        "text": text,
        "type": etype,
        "confidence": confidence,
        "gliner_confidence": gliner_conf,
        "flair_confidence": flair_conf,
        "status_name": status_name,
    }


class TestParseResponse:
    """JSON parsing from LLM output."""

    def test_valid_json_array(self):
        raw = json.dumps([
            {"text": "Putin", "type": "Person", "confidence": 0.95, "action": "confirm", "reasoning": "ok"}
        ])
        result = _parse_llm_response(raw)
        assert len(result) == 1
        assert result[0]["text"] == "Putin"

    def test_json_in_markdown_block(self):
        raw = '```json\n[{"text": "Bakhmut", "type": "Location", "confidence": 0.9, "action": "confirm", "reasoning": "city"}]\n```'
        result = _parse_llm_response(raw)
        assert len(result) == 1
        assert result[0]["text"] == "Bakhmut"

    def test_json_with_text_before_after(self):
        raw = 'Here is the review:\n[{"text": "NATO", "type": "Organization", "confidence": 0.88, "action": "confirm", "reasoning": "ok"}]\nDone.'
        result = _parse_llm_response(raw)
        assert len(result) == 1

    def test_malformed_json(self):
        result = _parse_llm_response("not json at all")
        assert result == []

    def test_empty_string(self):
        result = _parse_llm_response("")
        assert result == []


class TestShouldReview:
    """Should Stage 3 LLM be invoked?"""

    def test_no_conflicts_high_confidence_skips(self):
        candidates = [
            make_candidate("Putin", "Person", 0.9, status_name="CONFIRMED"),
        ]
        assert not should_review(candidates, 0, True)

    def test_conflicts_triggers_review(self):
        candidates = []
        assert should_review(candidates, 1, True)

    def test_llm_disabled_skips(self):
        assert not should_review([], 1, False)

    def test_config_disabled_skips(self):
        should_review_val = should_review
        from unittest.mock import patch
        with patch("ner_service.llm.reviewer.ENABLE_LLM", False):
            assert not should_review([], 1, True)

    def test_low_confidence_triggers(self):
        candidates = [
            make_candidate("Something", "Person", 0.5, status_name="SINGLE_SOURCE"),
        ]
        assert should_review(candidates, 0, True)

    def test_entity_status_conflict_triggers(self):
        candidates = [
            {"status": 4, "confidence": 0.8, "text": "Test"},
        ]
        assert should_review(candidates, 0, True)


class TestApplyReview:
    """Applying LLM review actions to merged entities."""

    def test_confirm_action_preserves_entity(self):
        merged = [
            {"text": "Biden", "type": "Person", "confidence": 0.9, "context": "Biden announced..."},
        ]
        reviewed = [
            {"text": "Biden", "type": "Person", "confidence": 0.95, "action": "confirm", "reasoning": "correct"},
        ]
        result = apply_review(merged, reviewed, "President Biden announced new sanctions.")
        assert len(result) == 1
        assert result[0]["text"] == "Biden"
        assert result[0]["context"] == "Biden announced..."
        assert result[0]["action"] == "confirm"

    def test_reject_removes_entity(self):
        merged = [
            {"text": "today", "type": "Person", "confidence": 0.4, "context": "..."},
        ]
        reviewed = [
            {"text": "today", "type": "Person", "confidence": 0.1, "action": "reject", "reasoning": "not a person"},
        ]
        result = apply_review(merged, reviewed)
        assert len(result) == 0

    def test_correct_action_updates_entity(self):
        merged = [
            {"text": "President", "type": "Person", "confidence": 0.6, "context": "President Biden spoke"},
        ]
        reviewed = [
            {"text": "Biden", "type": "Person", "confidence": 0.9, "action": "correct", "reasoning": "Full name is Biden"},
        ]
        result = apply_review(merged, reviewed, "President Biden spoke today.")
        assert len(result) == 1
        assert result[0]["text"] == "Biden"
        assert result[0]["action"] == "correct"

    def test_context_recovered_from_merged(self):
        merged = [
            {"text": "Bakhmut", "type": "Location", "confidence": 0.95, "context": "near Bakhmut, Ukraine"},
        ]
        reviewed = [
            {"text": "Bakhmut", "type": "Location", "confidence": 0.97, "action": "confirm", "reasoning": "correct"},
        ]
        result = apply_review(merged, reviewed)
        assert result[0]["context"] == "near Bakhmut, Ukraine"

    def test_context_fallback_to_source_text(self):
        merged = []
        reviewed = [
            {"text": "HIMARS", "type": "Equipment", "confidence": 0.85, "action": "add", "reasoning": "missed by both"},
        ]
        result = apply_review(merged, reviewed, "HIMARS strike in Kherson.")
        assert len(result) == 1
        assert result[0]["text"] == "HIMARS"
        assert "HIMARS" in result[0]["context"]  # extracted from source text

    def test_add_action(self):
        merged = []
        reviewed = [
            {"text": "Sudan", "type": "Location", "confidence": 0.85, "action": "add", "reasoning": "missed"},
        ]
        result = apply_review(merged, reviewed, "Fighting in Sudan continues.")
        assert len(result) == 1
        assert result[0]["action"] == "add"


class TestPromptBuilding:
    """Prompt construction for LLM."""

    def test_candidates_text_formatting(self):
        candidates = [
            make_candidate("Putin", "Person", 0.9, 0.85, 0.95, "CONFIRMED"),
            make_candidate("T-90M", "Equipment", 0.88, 0.88, 0.0, "GLINER_ENRICHED"),
        ]
        text = _build_candidates_text(candidates)
        assert "Putin" in text
        assert "T-90M" in text
        assert "CONFIRMED" in text
        assert "GLINER_ENRICHED" in text
        assert "0.85" in text
        assert "0.95" in text

    def test_full_prompt_includes_text_and_candidates(self):
        prompt = _build_prompt("Russian tanks near Bakhmut", [
            make_candidate("Bakhmut", "Location", 0.95),
        ])
        assert "Russian tanks near Bakhmut" in prompt
        assert "Bakhmut" in prompt
        assert "JSON" in prompt


class TestReviewIntegration:
    """Integration tests with mocked httpx."""

    @patch("ner_service.llm.reviewer.httpx")
    def test_successful_review(self, mock_httpx):
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.json.return_value = {
            "message": {
                "content": json.dumps([
                    {"text": "Putin", "type": "Person", "confidence": 0.95, "action": "confirm", "reasoning": "ok"}
                ])
            }
        }
        mock_httpx.post.return_value = mock_response

        candidates = [
            make_candidate("Putin", "Person", 0.9, 0.85, 0.95, "CONFIRMED"),
        ]
        result = review("Putin spoke today.", candidates, timeout=1.0)
        assert len(result) == 1
        assert result[0]["text"] == "Putin"

    @patch("ner_service.llm.reviewer.httpx")
    def test_timeout_returns_candidates_unchanged(self, mock_httpx):
        class FakeTimeout(Exception):
            pass
        mock_httpx.post.side_effect = FakeTimeout("timeout")
        # Make the mocked module's TimeoutException resolve to our fake class
        # so the except clause catches it
        mock_httpx.TimeoutException = FakeTimeout

        candidates = [make_candidate("Test", "Person", 0.8)]
        result = review("Test text", candidates, timeout=1.0)
        assert result == candidates

    @patch("ner_service.llm.reviewer.httpx")
    def test_empty_candidates_returns_empty(self, mock_httpx):
        result = review("Text", [], timeout=1.0)
        assert result == []
        mock_httpx.post.assert_not_called()
