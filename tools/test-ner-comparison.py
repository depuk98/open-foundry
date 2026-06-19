#!/usr/bin/env python3
"""
Comprehensive NER comparison: GLiNER vs Flair vs compromise
Tests both libraries against real tweets from the OSINT database.

Tests cover:
  1. General entity extraction (Person, Org, Location)
  2. Military equipment detection (T-90M, HIMARS, Bayraktar TB2, etc.)
  3. Military unit detection (4th Guards Tank Division, Wagner Group, etc.)
  4. Informal tweet text (hashtags, @mentions, URLs, abbreviations)
  5. Non-English text handling
  6. Edge cases: empty text, very short text, numbers, dates
  7. Performance/latency comparison
  8. Confidence score distribution
"""

import sys
import time
import json
import re
from collections import defaultdict
from dataclasses import dataclass, field

# ── Database ──
import psycopg2

DB_CONFIG = {
    "host": "localhost",
    "port": 5433,
    "dbname": "openfoundry",
    "user": "openfoundry",
    "password": "changeme",
}

# ── Entity types for GLiNER ──
GLINER_LABELS_GENERAL = ["Person", "Organization", "Location"]
GLINER_LABELS_EXTENDED = [
    "Person", "Organization", "Location",
    "Equipment", "MilitaryUnit", "WeaponSystem",
    "ArmedGroup", "ConflictZone", "Event",
]

# ── Equipment test cases ──
EQUIPMENT_TEST_CASES = [
    "Russian T-90M tanks from the 4th Guards Tank Division were spotted near Bakhmut by Ukrainian drone operators.",
    "HIMARS strikes destroyed a Russian ammo depot in Kherson.",
    "Bayraktar TB2 drone destroyed a Russian Buk-M1 air defense system near Kupyansk.",
    "Shahed-136 suicide drones intercepted over Kyiv last night.",
    "Lancet-3 loitering munition struck a Ukrainian M777 howitzer in Donetsk.",
    "The S-400 air defense system failed to intercept ATACMS missiles in Crimea.",
    "Ka-52 Alligator attack helicopters provided close air support near Avdiivka.",
    "Russian Su-35 fighter jets dropped glide bombs on Sumy region.",
    "Ukrainian Leopard 2A6 tanks breached Russian defensive lines in Zaporizhzhia.",
    "A Russian Kh-101 cruise missile was shot down by a Patriot PAC-3 system.",
    "The 155th Naval Infantry Brigade advanced with BMP-3 IFVs and T-80BV tanks.",
    "NASAMS air defense system deployed near the Polish border.",
]

# ── Military unit test cases ──
MILITARY_UNIT_TEST_CASES = [
    "Elements of the 1st Guards Tank Army were observed regrouping near Belgorod.",
    "Wagner Group mercenaries have been deployed to the Bakhmut axis.",
    "The 155th Naval Infantry Brigade took heavy losses near Vuhledar.",
    "Russian VDV (Airborne Forces) units conducted a heliborne assault on Hostomel.",
    "Ukrainian 93rd Mechanized Brigade 'Kholodnyi Yar' repelled Russian advances.",
    "Russian Spetsnaz GRU units have been operating behind Ukrainian lines.",
    "The Georgian Legion is fighting alongside Ukrainian forces.",
    "Chechen Kadyrovtsy units are present in the Mariupol sector.",
    "The Azov Brigade defended the Azovstal steel plant.",
    "Russian 76th Guards Air Assault Division deployed to the Kreminna front.",
]

# ── Edge cases ──
EDGE_CASES = [
    # Informal tweet text
    ("Tweet with @mentions and #hashtags",
     "BREAKING: @sentdefender reports large #Russian convoy of T-90M tanks moving toward #Bakhmut. 🚨 #UkraineWar #OSINT"),
    ("Retweet with RT prefix",
     "RT @DefMon3: New satellite imagery shows Russian Su-34 bombers at Engels Air Base. Note the unusual dispersal pattern"),
    ("Tweet with only URL and emoji",
     "⚠️ https://t.co/abc123"),
    ("Tweet with emoji and minimal text",
     "🔥🇺🇦 Ukrainian forces advancing! 🔥"),
    ("Tweet with abbreviations",
     "RU MoD claims AFU Bde near Kherson repelled. IDF reports contradict. SMH at the propaganda."),
    # Non-English
    ("Ukrainian tweet",
     "Російські танки Т-90М обстрілюють позиції ЗСУ біля Бахмута. Працює артилерія."),
    ("Russian tweet",
     "Танки Т-90М 4-й гвардейской танковой дивизии замечены под Харьковом."),
    ("Arabic tweet",
     "الدبابات الروسية T-90M قصفت مواقع في باخموت. الطيران الحربي يقصف المنطقة."),
    # Edge cases
    ("Empty text", ""),
    ("Very short text", "OK"),
    ("Only numbers", "43 0.5 1,234 -500"),
    ("URL only", "https://t.co/abc123def456"),
    ("Single word", "HIMARS"),
    ("Punctuation only", "..."),
]

# ── Synthetic OSINT test cases (curated for known ground truth) ──
SYNTHETIC_TEST_CASES = [
    {
        "text": "President Zelensky met with NATO Secretary General Stoltenberg in Brussels today.",
        "expected_person": ["Zelensky", "Stoltenberg"],
        "expected_org": ["NATO"],
        "expected_location": ["Brussels"],
    },
    {
        "text": "Russian T-90M tanks from the 4th Guards Tank Division were spotted by Ukrainian forces near Bakhmut.",
        "expected_person": [],
        "expected_org": ["Russian", "4th Guards Tank Division", "Ukrainian forces"],
        "expected_location": ["Bakhmut"],
        "expected_equipment": ["T-90M"],
    },
    {
        "text": "The United Nations Security Council will meet in New York to discuss the situation in Gaza.",
        "expected_person": [],
        "expected_org": ["United Nations", "Security Council"],
        "expected_location": ["New York", "Gaza"],
    },
    {
        "text": "HIMARS strikes destroyed a Russian S-400 system in Belgorod, according to Ukrainian General Staff.",
        "expected_person": [],
        "expected_org": ["Russian", "Ukrainian General Staff"],
        "expected_location": ["Belgorod"],
        "expected_equipment": ["HIMARS", "S-400"],
    },
    {
        "text": "Israeli Prime Minister Netanyahu addressed the Knesset regarding the Iran nuclear deal.",
        "expected_person": ["Netanyahu"],
        "expected_org": ["Knesset"],
        "expected_location": ["Iran"],
    },
    {
        "text": "Drone footage shows Ka-52 helicopters and BMP-3 IFVs destroyed near Vuhledar by Ukrainian artillery.",
        "expected_person": [],
        "expected_org": [],
        "expected_location": ["Vuhledar"],
        "expected_equipment": ["Ka-52", "BMP-3"],
    },
    {
        "text": "China's PLA Navy conducted exercises in the South China Sea near the Spratly Islands.",
        "expected_person": [],
        "expected_org": ["PLA Navy"],
        "expected_location": ["China", "South China Sea", "Spratly Islands"],
    },
    {
        "text": "General Milley and Secretary Austin briefed Congress on the Ukraine situation.",
        "expected_person": ["Milley", "Austin"],
        "expected_org": ["Congress"],
        "expected_location": ["Ukraine"],
    },
]


@dataclass
class EntityResult:
    type: str
    name: str
    confidence: float


@dataclass
class ExtractionResult:
    engine: str
    text: str
    truncated_text: str
    entities: list = field(default_factory=list)
    latency_ms: float = 0
    error: str = ""


def get_tweets_from_db(limit=200):
    """Fetch diverse real tweets from the database."""
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()

    tweets = []

    # Get most recent tweets with actual content from known sources
    cur.execute("""
        SELECT source_channel, content, source_platform
        FROM intel_report
        WHERE content IS NOT NULL
          AND length(content) > 20
          AND source_channel NOT LIKE '%%twitter.com%%'
        ORDER BY retrieved_at DESC
        LIMIT %s
    """, (limit,))

    for row in cur.fetchall():
        tweets.append({
            "source": row[0] or "unknown",
            "content": row[1],
            "platform": row[2] or "twitter",
        })

    cur.close()
    conn.close()
    return tweets


def test_gliner(texts, labels, model_name="gliner-community/gliner_small-v2.5"):
    """Run GLiNER on a list of texts."""
    print(f"  Loading GLiNER model: {model_name}...", flush=True)
    from gliner import GLiNER

    load_start = time.time()
    model = GLiNER.from_pretrained(model_name)
    load_time = time.time() - load_start
    print(f"  GLiNER loaded in {load_time:.1f}s", flush=True)

    results = []
    total_latency = 0
    count = 0

    for item in texts:
        text = item["content"] if isinstance(item, dict) else item
        truncated = text[:500]  # Truncate long texts for fair comparison

        try:
            start = time.time()
            entities = model.predict_entities(truncated, labels, threshold=0.4)
            latency = (time.time() - start) * 1000
            total_latency += latency
            count += 1

            parsed = [
                EntityResult(
                    type=e["label"],
                    name=e["text"],
                    confidence=e["score"],
                )
                for e in entities
            ]
            results.append(ExtractionResult(
                engine="GLiNER",
                text=text,
                truncated_text=truncated,
                entities=parsed,
                latency_ms=latency,
            ))
        except Exception as e:
            results.append(ExtractionResult(
                engine="GLiNER",
                text=text,
                truncated_text=truncated,
                error=str(e),
            ))

    avg_latency = total_latency / max(count, 1)
    print(f"  GLiNER: {count} texts, avg {avg_latency:.1f}ms per text", flush=True)
    return results, avg_latency


def test_flair(texts):
    """Run Flair on a list of texts."""
    print("  Loading Flair NER model (ner-large)...", flush=True)
    from flair.data import Sentence
    from flair.nn import Classifier

    load_start = time.time()
    tagger = Classifier.load('ner-large')
    load_time = time.time() - load_start
    print(f"  Flair loaded in {load_time:.1f}s", flush=True)

    results = []
    total_latency = 0
    count = 0

    for item in texts:
        text = item["content"] if isinstance(item, dict) else item
        truncated = text[:500]

        try:
            sentence = Sentence(truncated)
            start = time.time()
            tagger.predict(sentence)
            latency = (time.time() - start) * 1000
            total_latency += latency
            count += 1

            entities = []
            for entity in sentence.get_spans('ner'):
                # Flair uses PER/ORG/LOC/MISC
                flair_type = entity.tag
                mapped_type = {
                    "PER": "Person",
                    "ORG": "Organization",
                    "LOC": "Location",
                    "MISC": "Miscellaneous",
                }.get(flair_type, flair_type)

                entities.append(EntityResult(
                    type=mapped_type,
                    name=entity.text,
                    confidence=entity.score,
                ))
            results.append(ExtractionResult(
                engine="Flair",
                text=text,
                truncated_text=truncated,
                entities=entities,
                latency_ms=latency,
            ))
        except Exception as e:
            results.append(ExtractionResult(
                engine="Flair",
                text=text,
                truncated_text=truncated,
                error=str(e),
            ))

    avg_latency = total_latency / max(count, 1)
    print(f"  Flair: {count} texts, avg {avg_latency:.1f}ms per text", flush=True)
    return results, avg_latency


def test_gliner_extended(texts):
    """Run GLiNER with extended military OSINT labels."""
    return test_gliner(
        texts,
        labels=GLINER_LABELS_EXTENDED,
        model_name="gliner-community/gliner_small-v2.5",
    )


def analyze_results(name, results):
    """Analyze extraction results and print summary."""
    print(f"\n{'='*70}")
    print(f"  {name} — Analysis")
    print(f"{'='*70}")

    total_texts = len(results)
    texts_with_entities = sum(1 for r in results if len(r.entities) > 0)
    errors = sum(1 for r in results if r.error)

    # Entity type distribution
    type_counts = defaultdict(int)
    all_entities = []
    confidence_sum = 0
    confidence_count = 0

    for r in results:
        for e in r.entities:
            type_counts[e.type] += 1
            all_entities.append(e)
            confidence_sum += e.confidence
            confidence_count += 1

    avg_latency = sum(r.latency_ms for r in results if r.latency_ms > 0) / max(
        sum(1 for r in results if r.latency_ms > 0), 1
    )

    print(f"  Texts processed:          {total_texts}")
    print(f"  Texts with entities:      {texts_with_entities} ({100*texts_with_entities/max(total_texts,1):.0f}%)")
    print(f"  Total entities extracted: {len(all_entities)}")
    print(f"  Avg entities per text:    {len(all_entities)/max(total_texts,1):.1f}")
    print(f"  Errors:                   {errors}")
    print(f"  Avg latency:              {avg_latency:.1f}ms")
    if confidence_count > 0:
        print(f"  Avg confidence:           {confidence_sum/confidence_count:.3f}")

    print(f"\n  Entity type distribution:")
    for etype, cnt in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"    {etype:20s}: {cnt:4d} ({100*cnt/max(len(all_entities),1):.1f}%)")

    return {
        "total": total_texts,
        "with_entities": texts_with_entities,
        "total_entities": len(all_entities),
        "errors": errors,
        "avg_latency": avg_latency,
        "type_counts": dict(type_counts),
        "avg_confidence": confidence_sum / max(confidence_count, 1),
    }


def show_extraction_samples(results, n=5):
    """Show sample extractions."""
    print(f"\n  Sample extractions:")
    shown = 0
    for r in results:
        if len(r.entities) > 0 and shown < n:
            text_preview = r.truncated_text[:120] + "..." if len(r.truncated_text) > 120 else r.truncated_text
            print(f"\n  Text: {text_preview}")
            for e in r.entities[:8]:
                print(f"    [{e.type}] {e.name} ({e.confidence:.2f})")
            shown += 1


def run_synthetic_test(label, test_cases, gliner_labels):
    """Run synthetic tests with known ground truth."""
    print(f"\n{'='*70}")
    print(f"  SYNTHETIC TEST: {label}")
    print(f"{'='*70}")

    from gliner import GLiNER
    from flair.data import Sentence
    from flair.nn import Classifier

    gliner_model = GLiNER.from_pretrained("gliner-community/gliner_small-v2.5")
    flair_tagger = Classifier.load('ner-large')

    results = []

    for tc in test_cases:
        text = tc["text"]
        expected_person = set(tc.get("expected_person", []))
        expected_org = set(tc.get("expected_org", []))
        expected_loc = set(tc.get("expected_location", []))
        expected_equip = set(tc.get("expected_equipment", []))

        # GLiNER
        gliner_entities = gliner_model.predict_entities(text, gliner_labels, threshold=0.3)
        gliner_person = {e["text"] for e in gliner_entities if e["label"] == "Person"}
        gliner_org = {e["text"] for e in gliner_entities if e["label"] == "Organization"}
        gliner_loc = {e["text"] for e in gliner_entities if e["label"] == "Location"}
        gliner_equip = {e["text"] for e in gliner_entities if e["label"] in ("Equipment", "WeaponSystem")}

        # Flair
        flair_sentence = Sentence(text)
        flair_tagger.predict(flair_sentence)
        flair_person = {e.text for e in flair_sentence.get_spans('ner') if e.tag == "PER"}
        flair_org = {e.text for e in flair_sentence.get_spans('ner') if e.tag == "ORG"}
        flair_loc = {e.text for e in flair_sentence.get_spans('ner') if e.tag == "LOC"}
        flair_misc = {e.text for e in flair_sentence.get_spans('ner') if e.tag == "MISC"}

        # Score
        def partial_match_score(found, expected):
            if not expected:
                return None  # No expectation set
            hits = 0
            for exp in expected:
                exp_lower = exp.lower()
                for f in found:
                    if exp_lower in f.lower() or f.lower() in exp_lower:
                        hits += 1
                        break
            return hits / len(expected) if expected else 1.0

        row = {
            "text": text[:100] + "..." if len(text) > 100 else text,
            "gliner": {
                "person": partial_match_score(gliner_person, expected_person),
                "org": partial_match_score(gliner_org, expected_org),
                "location": partial_match_score(gliner_loc, expected_loc),
                "equipment": partial_match_score(gliner_equip, expected_equip),
                "person_found": sorted(gliner_person),
                "org_found": sorted(gliner_org),
                "loc_found": sorted(gliner_loc),
                "equip_found": sorted(gliner_equip),
            },
            "flair": {
                "person": partial_match_score(flair_person, expected_person),
                "org": partial_match_score(flair_org, expected_org),
                "location": partial_match_score(flair_loc, expected_loc),
                "misc": sorted(flair_misc),
                "person_found": sorted(flair_person),
                "org_found": sorted(flair_org),
                "loc_found": sorted(flair_loc),
            },
        }
        results.append(row)

    # Summarize
    gliner_scores = {"person": [], "org": [], "location": [], "equipment": []}
    flair_scores = {"person": [], "org": [], "location": []}

    for r in results:
        for k in gliner_scores:
            v = r["gliner"][k]
            if v is not None:
                gliner_scores[k].append(v)
        for k in flair_scores:
            v = r["flair"][k]
            if v is not None:
                flair_scores[k].append(v)

    print(f"\n  {'Type':<15s} {'GLiNER':>10s} {'Flair':>10s}")
    print(f"  {'-'*15} {'-'*10} {'-'*10}")
    for etype in ["person", "org", "location", "equipment"]:
        g_avg = sum(gliner_scores[etype]) / max(len(gliner_scores[etype]), 1) * 100 if gliner_scores[etype] else "N/A"
        g_str = f"{g_avg:.0f}%" if isinstance(g_avg, float) else g_avg

        if etype == "equipment":
            f_str = "N/A"
        else:
            f_avg = sum(flair_scores[etype]) / max(len(flair_scores[etype]), 1) * 100 if flair_scores[etype] else "N/A"
            f_str = f"{f_avg:.0f}%" if isinstance(f_avg, float) else f_avg

        print(f"  {etype.capitalize():<15s} {g_str:>10s} {f_str:>10s}")

    # Show misses
    print(f"\n  Detailed results:")
    for r in results:
        print(f"\n  ── {r['text']}")
        print(f"    GLiNER:  Person={r['gliner']['person_found']}, Org={r['gliner']['org_found']}, Loc={r['gliner']['loc_found']}, Equip={r['gliner']['equip_found']}")
        print(f"    Flair:   Person={r['flair']['person_found']}, Org={r['flair']['org_found']}, Loc={r['flair']['loc_found']}, Misc={r['flair']['misc']}")


def run_edge_case_test():
    """Run edge case tests."""
    print(f"\n{'='*70}")
    print(f"  EDGE CASE TESTS")
    print(f"{'='*70}")

    from gliner import GLiNER
    from flair.data import Sentence
    from flair.nn import Classifier

    gliner_model = GLiNER.from_pretrained("gliner-community/gliner_small-v2.5")
    flair_tagger = Classifier.load('ner-large')

    gliner_labels = GLINER_LABELS_GENERAL

    for name, text in EDGE_CASES:
        print(f"\n  [{name}]")
        print(f"  Text: '{text[:80]}{'...' if len(text) > 80 else ''}'")

        # GLiNER
        try:
            ge = gliner_model.predict_entities(text, gliner_labels, threshold=0.3) if text else []
            g_output = ", ".join(f"{e['text']}({e['label']})" for e in ge[:5]) if ge else "(none)"
        except Exception as e:
            g_output = f"ERROR: {e}"
        print(f"  GLiNER: {g_output}")

        # Flair
        try:
            if text:
                fs = Sentence(text)
                flair_tagger.predict(fs)
                f_output = ", ".join(f"{e.text}({e.tag})" for e in fs.get_spans('ner')[:5]) if fs.get_spans('ner') else "(none)"
            else:
                f_output = "(empty text)"
        except Exception as e:
            f_output = f"ERROR: {e}"
        print(f"  Flair:  {f_output}")


def main():
    print("=" * 70)
    print("  NER COMPARISON: GLiNER vs Flair")
    print("  Using real tweets from OpenFoundry OSINT database")
    print("=" * 70)

    # ── Fetch tweets ──
    print("\n─ Fetching tweets from database...")
    tweets = get_tweets_from_db(limit=100)
    print(f"  Fetched {len(tweets)} tweets from {len(set(t['source'] for t in tweets))} sources\n")

    # ── GLiNER (general labels) ──
    print("\n─ Running GLiNER (general: Person, Org, Location)...")
    gliner_results, gliner_latency = test_gliner(tweets, GLINER_LABELS_GENERAL)
    gliner_analysis = analyze_results("GLiNER (general)", gliner_results)
    show_extraction_samples(gliner_results, n=3)

    # ── Flair ──
    print("\n─ Running Flair (ner-large, 94.1% F1)...")
    flair_results, flair_latency = test_flair(tweets)
    flair_analysis = analyze_results("Flair (ner-large)", flair_results)
    show_extraction_samples(flair_results, n=3)

    # ── GLiNER (extended: military + equipment) ──
    print("\n─ Running GLiNER (extended: +Equipment, MilitaryUnit, WeaponSystem)...")
    gliner_ext_results, gliner_ext_latency = test_gliner_extended(tweets)
    gliner_ext_analysis = analyze_results("GLiNER (extended)", gliner_ext_results)
    show_extraction_samples(gliner_ext_results, n=3)

    # ── Equipment-specific test ──
    print("\n─ Running equipment test cases...")
    equip_inputs = [{"content": t, "source": "synthetic", "platform": "test"} for t in EQUIPMENT_TEST_CASES]
    gliner_eq_results, _ = test_gliner(equip_inputs, GLINER_LABELS_EXTENDED, "gliner-community/gliner_small-v2.5")
    flair_eq_results, _ = test_flair(equip_inputs)

    print("\n  Equipment detection comparison:")
    eq_gliner_count = sum(
        1 for r in gliner_eq_results
        if any(e.type in ("Equipment", "WeaponSystem") for e in r.entities)
    )
    eq_flair_count = sum(
        1 for r in flair_eq_results
        if any(e.type == "Miscellaneous" for e in r.entities)
    )
    print(f"  GLiNER: detected Equipment/WeaponSystem in {eq_gliner_count}/{len(equip_inputs)} texts")
    print(f"  Flair:  detected MISC in {eq_flair_count}/{len(flair_eq_results)} texts")

    for i, (gr, fr) in enumerate(zip(gliner_eq_results, flair_eq_results)):
        eq = gr.entities if gr.entities else []
        fm = fr.entities if fr.entities else []
        g_equip = [e.name for e in eq if e.type in ("Equipment", "WeaponSystem", "MilitaryUnit")]
        f_misc = [e.name for e in fm if e.type == "Miscellaneous"]
        if g_equip or f_misc:
            print(f"\n  [{i+1}] {EQUIPMENT_TEST_CASES[i][:100]}...")
            if g_equip:
                print(f"    GLiNER Equipment: {g_equip}")
            if f_misc:
                print(f"    Flair MISC:       {f_misc}")
            if not g_equip and not f_misc:
                print(f"    Both missed equipment!")

    # ── Military unit test ──
    print("\n─ Running military unit test cases...")
    unit_inputs = [{"content": t, "source": "synthetic", "platform": "test"} for t in MILITARY_UNIT_TEST_CASES]
    gliner_unit_results, _ = test_gliner(unit_inputs, GLINER_LABELS_EXTENDED, "gliner-community/gliner_small-v2.5")
    flair_unit_results, _ = test_flair(unit_inputs)

    unit_gliner = sum(
        1 for r in gliner_unit_results
        if any(e.type in ("MilitaryUnit", "ArmedGroup", "Organization") for e in r.entities)
    )
    unit_flair = sum(
        1 for r in flair_unit_results
        if any(e.type == "Organization" for e in r.entities)
    )
    print(f"  GLiNER: detected MilitaryUnit/ArmedGroup/Org in {unit_gliner}/{len(unit_inputs)} texts")
    print(f"  Flair:  detected ORG in {unit_flair}/{len(unit_inputs)} texts")

    for i, (gr, fr) in enumerate(zip(gliner_unit_results, flair_unit_results)):
        g_units = [e.name for e in gr.entities if e.type in ("MilitaryUnit", "ArmedGroup", "Organization")]
        f_orgs = [e.name for e in fr.entities if e.type == "Organization"]
        if g_units or f_orgs:
            print(f"\n  [{i+1}] '{MILITARY_UNIT_TEST_CASES[i][:90]}...'")
            if g_units:
                print(f"    GLiNER: {g_units}")
            if f_orgs:
                print(f"    Flair:  {f_orgs}")

    # ── Synthetic ground-truth test ──
    run_synthetic_test("Ground Truth Comparison", SYNTHETIC_TEST_CASES, [
        "Person", "Organization", "Location", "Equipment", "WeaponSystem", "MilitaryUnit"
    ])

    # ── Edge cases ──
    run_edge_case_test()

    # ── Performance summary ──
    print(f"\n{'='*70}")
    print(f"  PERFORMANCE SUMMARY")
    print(f"{'='*70}")
    print(f"  GLiNER (general):  avg {gliner_latency:.1f}ms/text, {gliner_analysis['total_entities']} entities")
    print(f"  GLiNER (extended): avg {gliner_ext_latency:.1f}ms/text, {gliner_ext_analysis['total_entities']} entities")
    print(f"  Flair (ner-large): avg {flair_latency:.1f}ms/text, {flair_analysis['total_entities']} entities")
    print(f"\n  Entity detection rate (texts with entities):")
    print(f"  GLiNER (general):  {gliner_analysis['with_entities']}/{gliner_analysis['total']} ({100*gliner_analysis['with_entities']/max(gliner_analysis['total'],1):.0f}%)")
    print(f"  GLiNER (extended): {gliner_ext_analysis['with_entities']}/{gliner_ext_analysis['total']} ({100*gliner_ext_analysis['with_entities']/max(gliner_ext_analysis['total'],1):.0f}%)")
    print(f"  Flair (ner-large): {flair_analysis['with_entities']}/{flair_analysis['total']} ({100*flair_analysis['with_entities']/max(flair_analysis['total'],1):.0f}%)")

    print(f"\n{'='*70}")
    print(f"  COMPARISON COMPLETE")
    print(f"{'='*70}")


if __name__ == "__main__":
    main()
