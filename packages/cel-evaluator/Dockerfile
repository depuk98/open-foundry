# Build stage
FROM golang:1.24-alpine AS builder

WORKDIR /app

# Cache dependency downloads
COPY go.mod go.sum ./
RUN go mod download

# Copy source and build
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /cel-evaluator .

# Runtime stage
FROM alpine:3.20

ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision="${GIT_REVISION}"

RUN apk --no-cache add ca-certificates \
    && adduser -D -u 1000 cel

# Install grpc-health-probe from Go (alpine edge no longer packages it)
COPY --from=builder /usr/local/go /usr/local/go
RUN /usr/local/go/bin/go install github.com/grpc-ecosystem/grpc-health-probe@latest \
    && mv /root/go/bin/grpc-health-probe /usr/local/bin/ \
    && rm -rf /usr/local/go /root/go

COPY --from=builder /cel-evaluator /usr/local/bin/cel-evaluator

USER cel

EXPOSE 50051

ENTRYPOINT ["cel-evaluator"]
