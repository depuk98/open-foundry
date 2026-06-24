# Build stage: install grpc-health-probe
FROM golang:1.25.11-alpine AS health-probe
RUN CGO_ENABLED=0 GOOS=linux go install github.com/grpc-ecosystem/grpc-health-probe@v0.4.50

# Runtime stage
FROM python:3.12-slim

ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision="${GIT_REVISION}"

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=health-probe /go/bin/grpc-health-probe /usr/local/bin/grpc-health-probe

RUN useradd --create-home --shell /bin/bash --uid 1000 neruser

WORKDIR /app

# Install Python deps directly with pip (uv lockfile has platform-specific wheels)
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch

COPY packages/ner-service/pyproject.toml .
RUN pip install --no-cache-dir \
    grpcio \
    grpcio-tools \
    grpcio-health-checking \
    gliner \
    flair \
    httpx \
    python-json-logger \
    pyyaml

# Copy source code
COPY packages/ner-service/proto/ proto/
COPY packages/ner-service/src/ ./src/

# Generate gRPC stubs
RUN mkdir -p src/ner_service/proto \
    && python -m grpc_tools.protoc \
    -Iproto \
    --python_out=src/ner_service/proto \
    --grpc_python_out=src/ner_service/proto \
    proto/ner.proto

RUN mkdir -p /home/neruser/.cache/huggingface /home/neruser/.flair \
    && chown -R neruser:neruser /home/neruser /app

USER neruser

ENV HF_HOME=/home/neruser/.cache/huggingface
ENV FLAIR_CACHE_ROOT=/home/neruser/.flair
ENV PYTHONPATH=/app/src

EXPOSE 50052

HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=420s \
    CMD ["grpc-health-probe", "-addr=:50052"]

ENTRYPOINT ["python", "-m", "ner_service.server"]
