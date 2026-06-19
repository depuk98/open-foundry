#!/usr/bin/env python3
"""
E2E test: fetches real tweets from the OSINT database and runs them through
the NER gRPC service. Prints per-tweet entities with pipeline metadata.

Usage: python tools/test-ner-through-grpc.py
"""

import sys
import time
import json

import grpc
import psycopg2

# Generated proto stubs
sys.path.insert(0, "packages/ner-service")
import ner_pb2
import ner_pb2_grpc

DB_CONFIG = {
    "host": "localhost",
    "port": 5433,
    "dbname": "openfoundry",
    "user": "openfoundry",
    "password": "changeme",
}

NER_ADDRESS = "localhost:50052"
ALL_LABELS = [
    "Person", "Organization", "Location", "Equipment",
    "WeaponSystem", "MilitaryUnit", "ArmedGroup", "ConflictZone", "Event",
]


def get_tweets(limit=20):
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()
    cur.execute("""
        SELECT content, source_channel
        FROM intel_report
        WHERE content IS NOT NULL
          AND length(content) > 30
          AND source_channel NOT LIKE '%%twitter.com%%'
        ORDER BY retrieved_at DESC
        LIMIT %s
    """, (limit,))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows


def extract_entities(stub, text, labels):
    request = ner_pb2.ExtractRequest(
        text=text,
        labels=labels,
        min_confidence=0.4,
        max_entities=20,
        enable_llm_review=True,
    )
    return stub.ExtractEntities(request, timeout=10)


def main():
    print("=" * 70)
    print("  NER Three-Stage Pipeline — E2E Test")
    print("=" * 70)

    print("\nFetching tweets from DB...")
    tweets = get_tweets(20)
    print(f"  Fetched {len(tweets)} tweets.\n")

    print(f"Connecting to NER service at {NER_ADDRESS}...")
    channel = grpc.insecure_channel(NER_ADDRESS)
    stub = ner_pb2_grpc.NerServiceStub(channel)

    total_entities = 0
    total_persons = 0
    total_orgs = 0
    total_locs = 0
    total_equip = 0
    total_other = 0
    tweets_with_entities = 0
    tweets_without = 0
    total_llm_invoked = 0

    for i, (content, source) in enumerate(tweets, 1):
        text = content[:500]
        try:
            start = time.monotonic()
            response = extract_entities(stub, text, ALL_LABELS)
            latency = (time.monotonic() - start) * 1000
        except grpc.RpcError as exc:
            status = exc.code()
            print(f"  [{i:2d}] gRPC ERROR: {status} — {exc.details()}")
            continue

        entities = response.entities
        meta = response.metadata

        type_counts = {}
        for e in entities:
            type_counts[e.type] = type_counts.get(e.type, 0) + 1

        if len(entities) > 0:
            tweets_with_entities += 1
            status_name = ner_pb2.EntityStatus.Name(entities[0].status) if entities else ""
        else:
            tweets_without += 1

        total_entities += len(entities)
        total_persons += type_counts.get("Person", 0)
        total_orgs += type_counts.get("Organization", 0) + type_counts.get("MilitaryUnit", 0) + type_counts.get("ArmedGroup", 0)
        total_locs += type_counts.get("Location", 0) + type_counts.get("ConflictZone", 0)
        total_equip += type_counts.get("Equipment", 0) + type_counts.get("WeaponSystem", 0)
        total_other += type_counts.get("Event", 0)
        if meta.llm_invoked:
            total_llm_invoked += 1

        preview = text[:100] + "..." if len(text) > 100 else text
        print(f"\n  [{i:2d}] @{source or 'unknown'} | {latency:.0f}ms")
        print(f"       {preview}")
        if entities:
            for e in entities[:5]:
                status_str = ner_pb2.EntityStatus.Name(e.status)
                print(f"       [{e.type}] {e.text} ({e.confidence:.2f}) — {status_str}")
            if len(entities) > 5:
                print(f"       ... and {len(entities) - 5} more")
        else:
            print("       (no entities)")

    print(f"\n{'=' * 70}")
    print(f"  RESULTS: {len(tweets)} tweets processed")
    print(f"  Tweets with entities:    {tweets_with_entities}")
    print(f"  Tweets without entities: {tweets_without}")
    print(f"  Total entities:          {total_entities}")
    print(f"  Persons:       {total_persons}")
    print(f"  Organizations: {total_orgs}")
    print(f"  Locations:     {total_locs}")
    print(f"  Equipment:     {total_equip}")
    print(f"  Events:        {total_other}")
    print(f"  LLM invoked:   {total_llm_invoked}/{len(tweets)}")
    print(f"{'=' * 70}")

    channel.close()


if __name__ == "__main__":
    main()
