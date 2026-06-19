"""NER Service gRPC server.

Three-stage entity extraction pipeline:
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

import config
import ensemble_merge
import flair_stage
import gliner_stage
import llm_reviewer
import llm_validation
import logging_config
import validation
import ner_pb2
import ner_pb2_grpc

logger = logging_config.get_logger(__name__)


def _build_proto_entity(me: ensemble_merge.MergedEntity) -> ner_pb2.Entity:
    """Convert a MergedEntity to a protobuf Entity."""
    return ner_pb2.Entity(
        text=me.text,
        type=me.type,
        confidence=me.confidence,
        context=me.context,
        status=me.status,
    )


def _build_proto_entity_from_dict(d: dict) -> ner_pb2.Entity:
    """Convert a review result dict to a protobuf Entity."""
    action = d.get("action", "confirm")
    if action == "correct":
        status = ner_pb2.ENTITY_STATUS_LLM_CORRECTED
    elif action == "add":
        status = ner_pb2.ENTITY_STATUS_LLM_ADDED
    else:
        status = ner_pb2.ENTITY_STATUS_LLM_VERIFIED

    return ner_pb2.Entity(
        text=d.get("text", ""),
        type=d.get("type", ""),
        confidence=float(d.get("confidence", 0.0)),
        context=d.get("context", ""),
        status=status,
    )


class NerService(ner_pb2_grpc.NerServiceServicer):
    """gRPC service implementing the three-stage NER extraction pipeline."""

    def __init__(self, health_servicer: health.HealthServicer) -> None:
        self._health = health_servicer

    def _update_health(self) -> None:
        if gliner_stage.is_available() or flair_stage.is_available():
            self._health.set("ner.v1.NerService", health_pb2.HealthCheckResponse.SERVING)
            self._health.set("", health_pb2.HealthCheckResponse.SERVING)

    def ExtractEntities(self, request: ner_pb2.ExtractRequest, context: grpc.ServicerContext) -> ner_pb2.ExtractResponse:
        """Extract entities through the full three-stage pipeline."""
        # Input validation — reject bad requests before any processing
        try:
            validation.validate_extract_request(request)
        except ValueError as exc:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))
            return ner_pb2.ExtractResponse()  # unreachable, satisfies type checker

        total_start = time.monotonic()
        labels = list(request.labels) if request.labels else config.DEFAULT_LABELS
        min_conf = request.min_confidence or config.MIN_CONFIDENCE
        max_entities = request.max_entities or config.MAX_ENTITIES

        logger.info("ExtractEntities", extra={
            "text_length": len(request.text),
            "label_count": len(labels),
            "min_confidence": min_conf,
            "enable_llm": request.enable_llm_review,
        })

        # ---- Stage 1: Parallel GLiNER + Flair ----
        gliner_results: list[dict] = []
        flair_results: list[dict] = []

        stage1_start = time.monotonic()

        def run_gliner() -> None:
            nonlocal gliner_results
            gliner_results = gliner_stage.extract_entities(request.text, labels, min_conf)

        def run_flair() -> None:
            nonlocal flair_results
            flair_results = flair_stage.extract_entities(request.text)

        threads: list[threading.Thread] = []
        if gliner_stage.is_available():
            threads.append(threading.Thread(target=run_gliner, name="stage1-gliner"))
        if flair_stage.is_available():
            threads.append(threading.Thread(target=run_flair, name="stage1-flair"))
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        stage1_latency = round((time.monotonic() - stage1_start) * 1000, 2)

        # ---- Stage 2: Ensemble merge ----
        merged, conflict_count = ensemble_merge.merge(gliner_results, flair_results, min_conf)
        merged = merged[:max_entities]

        # ---- Stage 3: LLM verification (conflicts only) ----
        llm_invoked = False
        stage3_latency = 0.0
        llm_reviewed = 0

        if llm_reviewer.should_review(
            [{"text": e.text, "type": e.type, "confidence": e.confidence,
              "gliner_confidence": e.gliner_confidence, "flair_confidence": e.flair_confidence,
              "status": e.status,
              "status_name": ner_pb2.EntityStatus.Name(e.status)}
             for e in merged],
            conflict_count,
            request.enable_llm_review,
        ):
            llm_invoked = True
            stage3_start = time.monotonic()

            candidates = [
                {"text": e.text, "type": e.type, "confidence": e.confidence,
                 "gliner_confidence": e.gliner_confidence, "flair_confidence": e.flair_confidence,
                 "status_name": ner_pb2.EntityStatus.Name(e.status)}
                for e in merged
            ]

            reviewed = llm_reviewer.review(request.text, candidates)

            # Validate LLM output against source text and allowed types
            if reviewed and reviewed != candidates:
                candidate_spans = {c["text"].strip().lower() for c in candidates}
                reviewed = llm_validation.validate_llm_output(
                    reviewed, request.text, candidate_spans,
                )

            if reviewed and reviewed != candidates:
                # LLM produced a different result — apply review
                verified = llm_reviewer.apply_review(
                    [{"text": e.text, "type": e.type, "confidence": e.confidence,
                      "gliner_confidence": e.gliner_confidence, "flair_confidence": e.flair_confidence,
                      "context": e.context}
                     for e in merged],
                    reviewed,
                    request.text,
                )

                # Build final entities from LLM output
                final_entities: list[ner_pb2.Entity] = []
                for v in verified:
                    # Find original MergedEntity to preserve context
                    orig = next((e for e in merged if e.text.lower() == v.get("text", "").lower()), None)
                    if orig:
                        final_entities.append(ner_pb2.Entity(
                            text=v.get("text", orig.text),
                            type=v.get("type", orig.type),
                            confidence=float(v.get("confidence", orig.confidence)),
                            context=orig.context,
                            status=ner_pb2.ENTITY_STATUS_LLM_VERIFIED,
                        ))
                    else:
                        final_entities.append(_build_proto_entity_from_dict(v))
                entities = final_entities[:max_entities]
                llm_reviewed = len(reviewed)
            else:
                entities = [_build_proto_entity(e) for e in merged]
                llm_reviewed = 0
            stage3_latency = round((time.monotonic() - stage3_start) * 1000, 2)
        else:
            entities = [_build_proto_entity(e) for e in merged]

        total_ms = round((time.monotonic() - total_start) * 1000, 2)

        metadata = ner_pb2.PipelineMetadata(
            gliner_count=len(gliner_results),
            flair_count=len(flair_results),
            conflicts=conflict_count,
            llm_reviewed=llm_reviewed,
            final_count=len(entities),
            stage1_latency_ms=stage1_latency,
            stage3_latency_ms=stage3_latency,
            llm_invoked=llm_invoked,
            gliner_available=gliner_stage.is_available(),
            flair_available=flair_stage.is_available(),
        )

        logger.info("ExtractEntities complete", extra={
            "gliner_count": len(gliner_results),
            "flair_count": len(flair_results),
            "conflicts": conflict_count,
            "llm_invoked": llm_invoked,
            "llm_reviewed": llm_reviewed,
            "final_count": len(entities),
            "stage1_latency_ms": stage1_latency,
            "stage3_latency_ms": stage3_latency,
            "total_ms": total_ms,
        })

        return ner_pb2.ExtractResponse(entities=entities, metadata=metadata)


def _start_model_loading(ns: NerService) -> None:
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
    logging_config.setup_logging(config.LOG_LEVEL)

    health_servicer = health.HealthServicer()
    health_servicer.set("ner.v1.NerService", health_pb2.HealthCheckResponse.NOT_SERVING)
    health_servicer.set("", health_pb2.HealthCheckResponse.NOT_SERVING)

    server = grpc.server(futures.ThreadPoolExecutor(max_workers=config.GRPC_MAX_WORKERS))
    ner_service = NerService(health_servicer)

    ner_pb2_grpc.add_NerServiceServicer_to_server(ner_service, server)
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)

    address = f"[::]:{config.GRPC_PORT}"
    server.add_insecure_port(address)
    server.start()

    logger.info("NER service started", extra={
        "address": address,
        "gliner_model": config.GLINER_MODEL,
        "flair_model": config.FLAIR_MODEL,
        "enable_flair": config.ENABLE_FLAIR,
        "enable_llm": config.ENABLE_LLM,
        "ollama_host": config.OLLAMA_HOST,
        "ollama_model": config.OLLAMA_MODEL,
    })

    _start_model_loading(ner_service)

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        logger.info("Shutting down NER service")
        server.stop(grace=5)


if __name__ == "__main__":
    serve()
