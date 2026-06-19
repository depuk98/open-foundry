# Build stage: install grpc-health-probe (same as cel-evaluator Dockerfile)
FROM golang:1.25.11-alpine AS health-probe
RUN CGO_ENABLED=0 GOOS=linux go install github.com/grpc-ecosystem/grpc-health-probe@v0.4.50

# Runtime stage
FROM python:3.12-slim

ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision="${GIT_REVISION}"

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy grpc-health-probe from builder
COPY --from=health-probe /go/bin/grpc-health-probe /usr/local/bin/grpc-health-probe

# Create non-root user
RUN useradd --create-home --shell /bin/bash --uid 1000 neruser

WORKDIR /app

# Install Python dependencies (layer cached unless requirements change)
# Install torch separately with CPU-only index to avoid ~2GB CUDA download
COPY packages/ner-service/requirements.txt .
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
    && pip install --no-cache-dir -r requirements.txt

# Copy proto and source
COPY packages/ner-service/proto/ proto/
COPY packages/ner-service/*.py ./
COPY packages/ner-service/compile_proto.sh .

# Generate gRPC stubs
RUN python -m grpc_tools.protoc \
    -Iproto \
    --python_out=. \
    --grpc_python_out=. \
    proto/ner.proto

# Ensure cache directories exist with correct ownership
RUN mkdir -p /home/neruser/.cache/huggingface /home/neruser/.flair \
    && chown -R neruser:neruser /home/neruser /app

USER neruser

ENV HF_HOME=/home/neruser/.cache/huggingface
ENV FLAIR_CACHE_ROOT=/home/neruser/.flair

EXPOSE 50052

HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=420s \
    CMD ["grpc-health-probe", "-addr=:50052"]

ENTRYPOINT ["python", "server.py"]
