"""NER Service gRPC server — lifecycle and model loading.

Three-stage entity extraction:
  Stage 1: GLiNER + Flair parallel extraction (background threads)
  Stage 2: Ensemble merge (confidence-weighted union, conflict detection)
  Stage 3: LLM verification via phi4-mini on Ollama (conflicts only)

Health check flips to SERVING once at least one model is ready.
"""

import logging
import threading
import time
from concurrent import futures

import grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc

from ner_service.config import (
    GLINER_MODEL,
    FLAIR_MODEL,
    ENABLE_FLAIR,
    ENABLE_LLM,
    OLLAMA_HOST,
    OLLAMA_MODEL,
    GRPC_MAX_WORKERS,
    GRPC_PORT,
    LOG_LEVEL,
    get_logger,
    setup_logging,
)
from ner_service.pipeline import gliner as gliner_stage
from ner_service.pipeline import flair as flair_stage
from ner_service.handler import NerServiceHandler
from ner_service.proto import ner_pb2_grpc

logger = get_logger(__name__)


def _start_model_loading(ns: NerServiceHandler) -> None:
    """Load GLiNER and Flair models in background threads."""

    def load_gliner() -> None:
        gliner_stage.load_model()
        ns._update_health()

    def load_flair() -> None:
        flair_stage.load_model()
        ns._update_health()

    threading.Thread(target=load_gliner, daemon=True, name="gliner-loader").start()
    threading.Thread(target=load_flair, daemon=True, name="flair-loader").start()


def serve() -> None:
    """Start the gRPC server and block until termination."""
    setup_logging(LOG_LEVEL)

    health_servicer = health.HealthServicer()
    health_servicer.set("ner.v1.NerService", health_pb2.HealthCheckResponse.NOT_SERVING)
    health_servicer.set("", health_pb2.HealthCheckResponse.NOT_SERVING)

    server = grpc.server(futures.ThreadPoolExecutor(max_workers=GRPC_MAX_WORKERS))
    ner_handler = NerServiceHandler(health_servicer)

    ner_pb2_grpc.add_NerServiceServicer_to_server(ner_handler, server)
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)

    address = f"[::]:{GRPC_PORT}"
    # Internal Docker network only — TLS not required for gRPC
    server.add_insecure_port(address)
    server.start()

    logger.info("NER service started", extra={
        "address": address,
        "gliner_model": GLINER_MODEL,
        "flair_model": FLAIR_MODEL,
        "enable_flair": ENABLE_FLAIR,
        "enable_llm": ENABLE_LLM,
        "ollama_host": OLLAMA_HOST,
        "ollama_model": OLLAMA_MODEL,
    })

    _start_model_loading(ner_handler)

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        logger.info("Shutting down NER service")
        server.stop(grace=5)


if __name__ == "__main__":
    serve()
