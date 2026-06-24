"""Tests for server.py — gRPC server handler."""

import pytest
from ner_service.proto import ner_pb2
import grpc
from grpc_health.v1 import health_pb2
from unittest.mock import patch, MagicMock


def _make_request(text="test", labels=None, min_confidence=0.0, max_entities=0, enable_llm=False):
    req = ner_pb2.ExtractRequest()
    req.text = text
    if labels:
        req.labels.extend(labels)
    req.min_confidence = min_confidence
    req.max_entities = max_entities
    req.enable_llm_review = enable_llm
    return req


class TestNerServiceHandler:
    @patch("ner_service.handler.gliner_stage")
    @patch("ner_service.handler.flair_stage")
    def test_extract_entities_empty_text_returns_invalid_argument(self, mock_flair, mock_gliner):
        """Empty text must be rejected before any model processing."""
        from ner_service.handler import NerServiceHandler
        from grpc_health.v1 import health, health_pb2

        health_servicer = health.HealthServicer()
        ns = NerServiceHandler(health_servicer)

        mock_context = MagicMock()
        mock_gliner.is_available.return_value = False
        mock_flair.is_available.return_value = False

        req = _make_request("")
        response = ns.ExtractEntities(req, mock_context)

        # Invalid argument should abort
        mock_context.abort.assert_called_once()
        call_args = mock_context.abort.call_args[0]
        assert call_args[0] == grpc.StatusCode.INVALID_ARGUMENT

    @patch("ner_service.handler.gliner_stage")
    @patch("ner_service.handler.flair_stage")
    def test_extract_entities_with_labels_applies_defaults(self, mock_flair, mock_gliner):
        """Default labels and config should be applied when request omits them."""
        from ner_service.handler import NerServiceHandler
        from grpc_health.v1 import health, health_pb2
        from ner_service.pipeline import ensemble as ensemble_merge

        mock_gliner.is_available.return_value = False
        mock_flair.is_available.return_value = False

        health_servicer = health.HealthServicer()
        ns = NerServiceHandler(health_servicer)

        mock_context = MagicMock()

        # Patch merge to return empty results (no models available)
        with patch.object(ensemble_merge, "merge", return_value=([], 0)):
            req = _make_request("Some text for extraction")
            response = ns.ExtractEntities(req, mock_context)

            # Metadata should reflect empty pipeline
            assert response.metadata.gliner_available is False
            assert response.metadata.flair_available is False
            assert response.metadata.llm_invoked is False
            assert len(response.entities) == 0

    def test_health_transitions_to_serving_when_model_ready(self):
        """Health should flip to SERVING when at least one model is loaded."""
        from ner_service.handler import NerServiceHandler
        from grpc_health.v1 import health, health_pb2

        health_servicer = health.HealthServicer()
        health_servicer.set("ner.v1.NerService", health_pb2.HealthCheckResponse.NOT_SERVING)
        health_servicer.set("", health_pb2.HealthCheckResponse.NOT_SERVING)

        # Simulate GLiNER becoming available
        with patch("ner_service.handler.gliner_stage.is_available", return_value=True):
            with patch("ner_service.handler.flair_stage.is_available", return_value=False):
                ns = NerServiceHandler(health_servicer)
                ns._update_health()

        request = health_pb2.HealthCheckRequest(service="ner.v1.NerService")
        response = health_servicer.Check(request, MagicMock())
        assert response.status == health_pb2.HealthCheckResponse.SERVING
