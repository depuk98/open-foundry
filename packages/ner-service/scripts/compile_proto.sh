#!/usr/bin/env bash
# Compile ner.proto to Python gRPC stubs.
# Run from packages/ner-service/ directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROTO_DIR="${PACKAGE_DIR}/proto"
OUT_DIR="${PACKAGE_DIR}/src/ner_service/proto"

python3 -m grpc_tools.protoc \
  -I"${PROTO_DIR}" \
  --python_out="${OUT_DIR}" \
  --grpc_python_out="${OUT_DIR}" \
  "${PROTO_DIR}/ner.proto"

# Fix relative imports in generated grpc file (grpc_tools uses absolute imports)
if [ -f "${OUT_DIR}/ner_pb2_grpc.py" ]; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's/import ner_pb2 as ner__pb2/from . import ner_pb2 as ner__pb2/' "${OUT_DIR}/ner_pb2_grpc.py"
  else
    sed -i 's/import ner_pb2 as ner__pb2/from . import ner_pb2 as ner__pb2/' "${OUT_DIR}/ner_pb2_grpc.py"
  fi
fi

echo "Proto compilation complete: ${OUT_DIR}/ner_pb2.py, ${OUT_DIR}/ner_pb2_grpc.py"
