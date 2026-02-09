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

RUN apk --no-cache add ca-certificates

COPY --from=builder /cel-evaluator /usr/local/bin/cel-evaluator

EXPOSE 50051

ENTRYPOINT ["cel-evaluator"]
