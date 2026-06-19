"""Tests for ensemble_merge.py — Stage 2 merge logic."""

import pytest
import ner_pb2

# Import the module under test — need to set up proto stubs first
from ensemble_merge import merge, MergedEntity, TYPE_RESOLUTION


def make_gliner(text: str, etype: str, confidence: float = 0.8, context: str = "") -> dict:
    return {"text": text, "type": etype, "confidence": confidence, "context": context or f"context for {text}"}


def make_flair(text: str, flair_tag: str, confidence: float = 0.9, context: str = "") -> dict:
    from flair_stage import FLAIR_TYPE_MAP
    return {
        "text": text,
        "type": FLAIR_TYPE_MAP.get(flair_tag, flair_tag),
        "confidence": confidence,
        "context": context or f"context for {text}",
        "_flair_tag": flair_tag,
    }


class TestMergeConfirmed:
    """Both models agree on span and type."""

    def test_person_confirmed(self):
        gliner = [make_gliner("Zelensky", "Person", 0.85)]
        flair = [make_flair("Zelensky", "PER", 1.0)]
        merged, conflicts = merge(gliner, flair)
        assert conflicts == 0
        assert len(merged) == 1
        assert merged[0].status == ner_pb2.ENTITY_STATUS_CONFIRMED
        assert merged[0].type == "Person"
        assert merged[0].confidence == 1.0  # max of 0.85 and 1.0
        assert merged[0].text == "Zelensky"

    def test_org_confirmed(self):
        gliner = [make_gliner("NATO", "Organization", 0.9)]
        flair = [make_flair("NATO", "ORG", 0.95)]
        merged, conflicts = merge(gliner, flair)
        assert conflicts == 0
        assert len(merged) == 1
        assert merged[0].status == ner_pb2.ENTITY_STATUS_CONFIRMED
        assert merged[0].type == "Organization"

    def test_location_confirmed(self):
        gliner = [make_gliner("Bakhmut", "Location", 0.92)]
        flair = [make_flair("Bakhmut", "LOC", 0.99)]
        merged, conflicts = merge(gliner, flair)
        assert conflicts == 0
        assert merged[0].status == ner_pb2.ENTITY_STATUS_CONFIRMED
        assert merged[0].type == "Location"


class TestGlinerEnriched:
    """Flair says MISC, GLiNER has specific type."""

    def test_equipment_enriches_misc(self):
        gliner = [make_gliner("T-90M", "Equipment", 0.88)]
        flair = [make_flair("T-90M", "MISC", 0.99)]
        merged, conflicts = merge(gliner, flair)
        assert conflicts == 0
        assert len(merged) == 1
        assert merged[0].status == ner_pb2.ENTITY_STATUS_GLINER_ENRICHED
        assert merged[0].type == "Equipment"
        assert merged[0].confidence == 0.99

    def test_weaponsystem_enriches_misc(self):
        gliner = [make_gliner("HIMARS", "WeaponSystem", 0.86)]
        flair = [make_flair("HIMARS", "MISC", 0.95)]
        merged, conflicts = merge(gliner, flair)
        assert merged[0].type == "WeaponSystem"
        assert merged[0].status == ner_pb2.ENTITY_STATUS_GLINER_ENRICHED

    def test_militaryunit_subtypes_org(self):
        gliner = [make_gliner("4th Guards Tank Division", "MilitaryUnit", 0.91)]
        flair = [make_flair("4th Guards Tank Division", "ORG", 0.96)]
        merged, conflicts = merge(gliner, flair)
        assert merged[0].type == "MilitaryUnit"
        assert merged[0].status == ner_pb2.ENTITY_STATUS_GLINER_ENRICHED

    def test_conflictzone_enriches_loc(self):
        gliner = [make_gliner("Donbas", "ConflictZone", 0.85)]
        flair = [make_flair("Donbas", "LOC", 0.92)]
        merged, conflicts = merge(gliner, flair)
        assert merged[0].type == "ConflictZone"
        assert merged[0].status == ner_pb2.ENTITY_STATUS_GLINER_ENRICHED


class TestSingleSource:
    """Only one model found the entity."""

    def test_gliner_only(self):
        gliner = [make_gliner("Bayraktar TB2", "Equipment", 0.85)]
        flair = []
        merged, conflicts = merge(gliner, flair)
        assert conflicts == 0
        assert len(merged) == 1
        assert merged[0].status == ner_pb2.ENTITY_STATUS_SINGLE_SOURCE
        assert merged[0].gliner_confidence == 0.85
        assert merged[0].flair_confidence == 0.0

    def test_flair_only(self):
        gliner = []
        flair = [make_flair("Washington", "LOC", 0.97)]
        merged, conflicts = merge(gliner, flair)
        assert len(merged) == 1
        assert merged[0].status == ner_pb2.ENTITY_STATUS_SINGLE_SOURCE

    def test_below_min_confidence_discarded(self):
        gliner = [make_gliner("something", "Person", 0.3)]
        flair = []
        merged, conflicts = merge(gliner, flair, min_confidence=0.4)
        assert len(merged) == 0

    def test_flair_only_below_threshold_discarded(self):
        gliner = []
        flair = [make_flair("noise", "MISC", 0.3)]
        merged, conflicts = merge(gliner, flair, min_confidence=0.5)
        assert len(merged) == 0


class TestConflict:
    """Same span, different types between models."""

    def test_different_types_conflict(self):
        gliner = [make_gliner("Wagner", "Person", 0.7)]
        flair = [make_flair("Wagner", "ORG", 0.85)]
        merged, conflicts = merge(gliner, flair)
        assert conflicts == 1
        assert len(merged) == 1
        # Conflict resolves to ENTITY_STATUS_CONFLICT (needs LLM)
        assert merged[0].status == ner_pb2.ENTITY_STATUS_CONFLICT

    def test_multiple_entities_mixed(self):
        gliner = [
            make_gliner("Putin", "Person", 0.9),
            make_gliner("Russia", "Organization", 0.88),
            make_gliner("T-90M", "Equipment", 0.91),
        ]
        flair = [
            make_flair("Putin", "PER", 1.0),
            make_flair("Russia", "ORG", 0.95),
            make_flair("T-90M", "MISC", 0.99),
            make_flair("Kyiv", "LOC", 0.97),  # Flair-only
        ]
        merged, conflicts = merge(gliner, flair)
        assert conflicts == 0
        assert len(merged) == 4
        statuses = {e.status: e.type for e in merged}
        assert ner_pb2.ENTITY_STATUS_CONFIRMED in statuses  # Putin
        assert ner_pb2.ENTITY_STATUS_CONFIRMED in statuses  # Russia
        assert ner_pb2.ENTITY_STATUS_GLINER_ENRICHED in statuses  # T-90M
        assert ner_pb2.ENTITY_STATUS_SINGLE_SOURCE in statuses  # Kyiv


class TestEdgeCases:
    """Edge cases."""

    def test_empty_inputs(self):
        merged, conflicts = merge([], [])
        assert conflicts == 0
        assert len(merged) == 0

    def test_no_gliner_available(self):
        """When Flair runs but GLiNER isn't loaded — all SINGLE_SOURCE."""
        flair = [make_flair("Moscow", "LOC", 0.95)]
        merged, conflicts = merge([], flair)
        assert len(merged) == 1
        assert merged[0].status == ner_pb2.ENTITY_STATUS_SINGLE_SOURCE

    def test_no_flair_available(self):
        """When GLiNER runs but Flair isn't loaded."""
        gliner = [make_gliner("UAE", "Location", 0.8)]
        merged, conflicts = merge(gliner, [])
        assert len(merged) == 1
        assert merged[0].status == ner_pb2.ENTITY_STATUS_SINGLE_SOURCE

    def test_duplicate_spans_same_type(self):
        gliner = [make_gliner("Putin", "Person", 0.9)]
        flair = [make_flair("Putin", "PER", 0.95)]
        merged, conflicts = merge(gliner, flair)
        assert len(merged) == 1  # deduped

    def test_case_insensitive_span_matching(self):
        gliner = [make_gliner("putin", "Person", 0.9)]
        flair = [make_flair("Putin", "PER", 0.95)]
        merged, conflicts = merge(gliner, flair)
        assert len(merged) == 1
        assert merged[0].status == ner_pb2.ENTITY_STATUS_CONFIRMED
