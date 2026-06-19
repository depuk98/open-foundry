---
title: Product Vision
created: 2026-06-18
last_updated: 2026-06-18
type: vision
status: active
---

# OpenFoundry OSINT — Product Vision

## Executive Summary

An **open-source intelligence platform** that automatically ingests live feeds from Twitter/X, Telegram, RSS, and structured APIs, extracts entities (people, organizations, locations, equipment) from unstructured text, builds a connected knowledge graph, and tracks source credibility over time. Available as both **self-hosted open-source** (you deploy, you own your data) and **managed cloud SaaS** (we host, you analyze). Think "open-source Palantir for geopolitical OSINT" — with the option to self-host or let us handle infrastructure.

---

## 1. The Problem

### What OSINT analysts face today

| Pain Point | Current Reality |
|------------|----------------|
| **Fragmented feeds** | Analysts monitor 50+ Twitter accounts, 20+ Telegram channels, 15+ RSS feeds, and structured APIs across multiple browser tabs. No unified view. |
| **Manual entity extraction** | When a tweet says *"Russian T-90M tanks spotted near Bakhmut"*, the analyst manually notes: Russia, T-90M, Bakhmut. Hours lost per day. |
| **No relationship graph** | "Has this source ever mentioned this location before?" "What organizations has this person been linked to across all reports?" — these questions require manual cross-referencing across spreadsheets. |
| **Opaque source credibility** | "Should I trust @sentdefender or @WarMonitor on this report?" Credibility lives in analysts' heads — no systematic tracking across sources and time. |
| **Vendor lock-in** | Palantir Foundry is the gold standard but costs millions, locks your data in, and requires infrastructure you don't control. |
| **No AI assistance** | LLMs can reason across data, but they need a connected knowledge graph to work on. Without an ontology, AI hallucinates facts. |

### Why now

Three converging trends make this the right time:

1. **Agentic AI needs ontologies** — Palantir's Alex Karp: "All the value in the market is going to go to chips and what we call ontology." AI agents need a shared model of real-world objects to reason and act. There's no open-source equivalent.

2. **Open Foundry provides the foundation** — The semantic, kinetic, and security layers (ontology engine, action framework, ReBAC authorization) already exist as open-source code. We're building the application layer on top.

3. **OSINT is exploding** — The volume of publicly available intelligence (satellite imagery, social media, livestreams, Telegram channels) has grown 100x in the last 5 years. Manual analysis can't scale.

---

## 2. The Solution

### What it is

A **geopolitical intelligence platform** available in two deployment models:

### Self-Hosted Open-Source

Deploy on your own infrastructure. Full control over data, security, and customization. Apache 2.0 license. No usage limits, no API costs, no vendor lock-in. Ideal for individual researchers, newsrooms with data residency requirements, and government agencies with air-gapped networks.

### Managed Cloud SaaS

Same open-source core, hosted by us. Sign up, connect your feeds, start analyzing in minutes. We handle infrastructure, updates, backups, and scaling. Pay based on usage tier (reports ingested, users, storage). Ideal for teams that want to skip DevOps and focus on analysis. Data encrypted at rest, isolated per tenant, exportable anytime.

### What it does

1. **Ingests** live data from Twitter/X, Telegram, RSS feeds, and structured APIs
2. **Extracts** entities (persons, organizations, locations, equipment) automatically using NER
3. **Builds** a connected knowledge graph showing relationships between entities
4. **Tracks** source credibility over time — transparent, auditable scoring
5. **Enables** analyst workflows: corroboration, contradiction, assessment creation, escalation
6. **Detects** disinformation narratives and coordinated information operations
7. **Warns** with early warning indicators based on ontology data thresholds
8. **Exposes** everything via GraphQL/REST APIs, a visual dashboard, and an AI chat interface

### Core differentiators

**1. Auto-built knowledge graph from raw feeds**

No other OSINT tool automatically extracts entities from tweets/Telegram/RSS and builds a queryable, traversable graph. A tweet saying *"Russian T-90M tanks near Bakhmut"* automatically creates nodes for Russia (Organization), T-90M (Equipment), Bakhmut (Location) — and edges connecting them all. Within seconds, you can query: "show me all equipment sighted within 50km of Bakhmut in the last 72 hours."

**2. Transparent source credibility scoring**

Every source gets a credibility score (0.0-1.0) tracked over time. Scores are calculated from: corroboration rate, contradiction rate, institutional backing, historical accuracy, and analyst reviews. The methodology is visible — no black-box AI trust scores. Users can drill down: "Why is @sentdefender scored 0.85? Show me the corroboration history."

### What it is NOT

- **Not a replacement for human analysts** — it's a force multiplier. The platform handles ingestion, extraction, and graph-building. Analysts handle interpretation, assessment, and judgment.
- **Not a real-time alerting system** — ingestion runs every 5 minutes. For sub-second alerts, use a dedicated alerting tool.
- **Not a data lake or warehouse** — this is a knowledge graph, not a place to dump raw data. The ontology gives data meaning.
- **Not Palantir** — Palantir has $100B market cap and thousands of engineers. This is the open-source foundation that does 80% of what Palantir's ontology does at 0% of the cost.

---

## 3. Who Uses It

### Persona 1: The Independent OSINT Researcher

**Who**: Individual analysts tracking geopolitical conflicts, verifying information, and producing intelligence reports. Often self-funded, publishing on Twitter/Substack/Medium.

**What they do**:
- Monitor 50+ Twitter accounts, 20+ Telegram channels, 10+ RSS feeds
- Cross-reference reports across sources to verify claims
- Geolocate events from video/photos
- Produce daily/weekly situation reports
- Build following through credible analysis

**How they use the platform**:
- Connect their Twitter auth once — all their monitored feeds auto-ingest
- Dashboard shows live feed of reports sorted by credibility and recency
- Map view shows geotagged reports in real-time
- Graph view shows entity relationships: "show me everyone linked to this person"
- AI chat: "summarize the last 24 hours of activity in the Strait of Hormuz"
- Publish assessments directly from the platform with source citations

**Why they choose this over alternatives**:
- Free and self-hosted — no API costs, no vendor lock-in
- Auto-builds the knowledge graph they'd otherwise build manually in spreadsheets
- Credibility scoring is transparent and tunable — they can weight sources differently
- API-first means they can build custom tools and dashboards on top

### Persona 2: The Newsroom Intelligence Team

**Who**: Journalists and editors at news organizations who need to verify breaking stories, track developing situations, and provide context to reporting. Teams of 3-15 people.

**What they do**:
- Verify breaking news from social media before publishing
- Track developing stories across multiple regions simultaneously
- Corroborate eyewitness accounts with official statements
- Maintain source databases with credibility assessments
- Produce timelines and relationship maps for investigative pieces

**How they use the platform**:
- Shared workspace with team-based access controls (ReBAC)
- Each reporter monitors their beat's feeds; the graph connects everything
- Corroboration engine flags when 3+ independent sources confirm the same event
- Contradiction engine flags when sources disagree — triggers investigation
- Timeline view shows how a story develops over hours/days
- Export reports with full source citations for editorial review
- AI chat: "has anyone else reported artillery fire in this area in the last 6 hours?"

**Why they choose this over alternatives**:
- Collaborative — multiple reporters can work the same graph simultaneously
- Auditable — every change is logged, critical for editorial standards
- Self-hosted — source data never leaves the newsroom's servers
- Open-source — can customize for their specific workflows

### Persona 3: The Government/Military Intelligence Analyst

**Who**: Analysts at defense/intelligence agencies, NATO commands, or UN peacekeeping operations. Need secure, auditable platforms with strict access controls.

**What they do**:
- Monitor adversary military movements and equipment deployments
- Track disinformation campaigns and information operations
- Produce intelligence assessments for commanders/policymakers
- Maintain watchlists of persons/organizations of interest
- Set early warning indicators for potential conflicts

**How they use the platform**:
- Deployed on air-gapped networks (self-hosted, no external dependencies)
- Role-based access: who can see what is enforced by ReBAC
- Classified sources tracked separately from open sources
- Indicator engine triggers alerts when ontology data crosses thresholds
- Assessment pipeline with formal review/approval workflow
- Full audit trail for every action — who created what, when, based on which sources
- AI chat: "what indicators are currently at WARNING or CRITICAL level in the Middle East theater?"

**Why they choose this over alternatives**:
- Air-gappable — runs entirely on internal infrastructure
- Open-source — can be security-audited independently
- ReBAC enforcement — not just roles, but relationship-based access (e.g., "analysts assigned to Middle East desk can see reports tagged Middle East")
- Immutable audit trail — every action logged, critical for intelligence oversight
- Fraction of Palantir's cost — millions saved in licensing

---

## 4. User Experience

### 4.1 The Dashboard

The primary interface is a web-based dashboard with four integrated views:

```
┌─────────────────────────────────────────────────────────────┐
│  OpenFoundry OSINT                          [Settings] [👤] │
├──────────┬──────────────────────────────────────────────────┤
│          │                                                   │
│  FEED    │              MAP VIEW                             │
│          │   🗺️  Geospatial display of all reports          │
│  ◉ RAW   │   • Clustered markers by location                │
│  ◉ TRIAG │   • Color-coded by credibility (green→red)       │
│  ◉ VERIF │   • Click: expand to report card                 │
│  ◉ CORRO │   • Filter: time range, source, entity           │
│  ◉ DISPU │                                                   │
│  ◉ ESCAL │                                                   │
│          │                                                   │
│  Filters │                                                   │
│  ─────── │                                                   │
│  Source  │                                                   │
│  Region  │                                                   │
│  Country │                                                   │
│  Entity  │                                                   │
│  ⏱ Last  │                                                   │
│   24h    │                                                   │
│          │                                                   │
├──────────┴──────────────────────────────────────────────────┤
│  TIMELINE VIEW                     │  GRAPH VIEW             │
│  📊 Temporal display of events     │  🕸️ Entity relationship│
│  • Event bars on timeline           │  • Node-link diagram    │
│  • Color-coded by type              │  • Expand/collapse      │
│  • Click: show source reports       │  • Path finding          │
│  • Zoom: hours → days → weeks       │  • Filter by entity type │
└─────────────────────────────────────┴────────────────────────┘
```

### 4.2 The Report Card

Clicking any report anywhere opens the report card:

```
┌─────────────────────────────────────────┐
│  IntelReport #rpt-tw-1866869812345678901│
│                                          │
│  "US continues intercepting Iranian     │
│   drones over Strait of Hormuz..."       │
│                                          │
│  Source: @sentdefender (cred: 0.85)     │
│  Posted: 2026-06-17 02:21 UTC           │
│  Status: RAW  |  Country: IR  |  Region: Middle East │
│                                          │
│  ── Extracted Entities ──               │
│  🏢 United States (Organization)        │
│  🏢 Iran (Organization)                 │
│  📍 Strait of Hormuz (Location)         │
│  🛸 Drone (Equipment)                   │
│                                          │
│  ── Corroboration ──                    │
│  ✓ @TheStudyofWar (cred: 0.98)          │
│    "Iranian drones continue to target.." │
│  ✓ @DefenceHQ (cred: 0.97)              │
│    "UKMTO advisory for Strait..."        │
│                                          │
│  ── Actions ──                           │
│  [Corroborate] [Contradict] [Escalate]   │
│  [Create Assessment] [Flag Disinfo]      │
└─────────────────────────────────────────┘
```

### 4.3 The AI Chat Interface

Natural language queries against the knowledge graph:

```
User: "What's happening in the Strait of Hormuz right now?"

AI:    Based on 47 reports from 12 sources in the last 24 hours:
       
       • US-Iran MOU was remotely signed today, now in effect
         (confirmed by @BarakRavid, @sentdefender, @TheStudyofWar)
       
       • Strait reopening has begun — Iran aiding mine clearance
         (credibility: HIGH — 4 independent sources)
       
       • US continues intercepting Iranian drones despite MOU
         (credibility: HIGH — @CNN, @sentdefender, @DefenceHQ)
       
       • KC-135, KC-46A, E-3G AWACS, P-8A aircraft active over Strait
         (credibility: MEDIUM — @sentdefender only, unconfirmed)
       
       Warning: 3 indicators at CRITICAL for Middle East theater

User: "Show me all equipment operated by Iran's IRGC that has been 
       sighted in the last 30 days."

AI:    [Table + graph visualization of equipment sightings with dates,
       locations, and source reports]
```

### 4.4 The API

Everything is API-first. The dashboard consumes the same APIs that external tools can:

```graphql
query {
  intelReports(
    filter: { 
      region: "Middle East", 
      publishedAt: { gte: "2026-06-17T00:00:00Z" },
      sourceCredibilityScore: { gte: 0.8 }
    },
    sort: { field: publishedAt, direction: DESC }
  ) {
    edges {
      node {
        id
        content
        sourceChannel
        sourceCredibilityScore
        mentionedOrgs { name type }
        mentionedLocations { name country }
        mentionedEquipment { designation category }
      }
    }
  }
}
```

```bash
# REST API
GET /api/v1/IntelReport?filter=country:IR&publishedAt >= 2026-06-17
GET /api/v1/IntelReport/rpt-tw-xxx/links
POST /api/v1/actions/CorroborateReport
POST /api/v1/actions/CreateAssessment
```

---

## 5. The Intelligence Cycle

The platform maps to the standard intelligence cycle:

```
    ┌──────────────────────────────────────────────┐
    │                                              │
    ▼                                              │
┌─────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│COLLECT  │──▶│ PROCESS  │──▶│ ANALYZE  │──▶│DISSEMINA.│
│         │   │          │   │          │   │          │
│Twitter  │   │NER       │   │Corrobor. │   │Assessmen.│
│Telegram │   │extraction│   │Contrad.  │   │Reports   │
│RSS      │   │Entity    │   │Cred.     │   │API export│
│APIs     │   │creation  │   │scoring   │   │Dashboard │
│         │   │Graph     │   │Indicator │   │AI chat   │
│         │   │building  │   │eval.     │   │          │
└─────────┘   └──────────┘   └──────────┘   └──────────┘
     │                                              │
     └──────────────────────────────────────────────┘
                    FEEDBACK LOOP
       (analyst actions update source credibility,
        indicators refine collection priorities)
```

### How each phase maps to the platform

| Phase | What happens | Platform component |
|-------|-------------|-------------------|
| **Collect** | Twitter/Telegram/RSS/API connectors ingest raw data | [[sync-engine]], connectors |
| **Process** | NER extracts entities, creates objects, builds graph links | [[entity-extraction-service]] (planned) |
| **Analyze** | Corroboration, contradiction, credibility scoring, indicator evaluation, AI-assisted reasoning | [[action-executor]], [[ontology-engine]], indicators |
| **Disseminate** | Assessments published, API exports, dashboard views, AI chat responses | [[api-gateway]], dashboard (planned), AI interface (planned) |
| **Feedback** | Analyst actions (corroborate/escalate/flag) feed back into source credibility and collection priorities | [[action-executor]], source credibility scoring |

---

## 6. Key Features (Current + Planned)

### ✅ Built & Running

| Feature | Status | Details |
|---------|--------|---------|
| **Twitter/X ingestion** | ✅ Live | 15 OSINT accounts monitored, 3,000+ tweets ingested, every 5 minutes |
| **SourceProfile auto-creation** | ✅ Live | 13 source profiles with credibility scores |
| **ReportedBy links** | ✅ Live | 158 links connecting reports to sources in the graph |
| **IntelReport storage** | ✅ Live | Dual storage: PostgreSQL (CRUD) + Apache AGE (graph traversal) |
| **GraphQL/REST API** | ✅ Live | Full query API with filtering, pagination, search |
| **ACLED connector** | ⚠️ Config only | YAML config exists, REST connector stub needs implementation |
| **OSINT domain pack** | ✅ Live | 10 object types, 35 link types, 7 actions, 4 connectors |

### 🟡 In Progress / Planned

| Feature | Priority | Effort |
|---------|----------|--------|
| **NER Entity Extraction** | 🔴 P0 | 3.5 days — see [NER plan](ner-entity-extraction-plan.md) |
| **Telegram connector** | 🟡 P1 | 2 days — MTProto client implementation |
| **RSS connector** | 🟡 P1 | 1 day — polling-based RSS feed ingestion |
| **Source credibility auto-scoring** | 🟡 P1 | 3 days — algorithm based on corroboration rate, analyst reviews |
| **Corroboration engine** | 🟡 P1 | 2 days — auto-detect when 3+ sources confirm same event |
| **Disinformation detection** | 🟢 P2 | 3 days — narrative tracking, coordinated behavior detection |
| **Web Dashboard** | 🟡 P1 | 5-7 days — map view, timeline, graph visualization |
| **AI Chat Interface** | 🟢 P2 | 3-5 days — LLM gateway with ontology tool access |
| **Indicator engine** | 🟢 P2 | 3 days — CEL threshold evaluation against live data |
| **Email alerts** | 🟢 P2 | 1 day — trigger emails when indicators breach thresholds |
| **Multi-tenancy** | 🟢 P3 | Already in schema — needs UI for tenant management |
| **Federation** | 🟢 P3 | Spec exists — cross-instance data sharing |

---

## 7. Technical Architecture

### 7.1 Current Stack

```
┌──────────────────────────────────────────────┐
│  DATA SOURCES                                 │
│  Twitter/X · Telegram (planned) · RSS (pl.)  │
│  ACLED API · Liveuamap (planned)              │
├──────────────────────────────────────────────┤
│  CONNECTORS (sync-engine)                     │
│  TwitterConnector · TelegramConnector (pl.)   │
│  RssConnector (pl.) · RestConnector           │
├──────────────────────────────────────────────┤
│  ONTOLOGY ENGINE (Open Foundry)               │
│  Object lifecycle · Link graph · Validation   │
│  Version history · Temporal queries           │
├──────────────────────────────────────────────┤
│  STORAGE                                       │
│  PostgreSQL 17 (relational)                    │
│  Apache AGE (graph)                            │
├──────────────────────────────────────────────┤
│  API LAYER                                     │
│  GraphQL (Apollo) · REST · WebSocket           │
│  Full-text search · Filtering · Aggregation    │
├──────────────────────────────────────────────┤
│  SECURITY                                      │
│  OIDC Auth · OpenFGA ReBAC · Consent · Audit   │
├──────────────────────────────────────────────┤
│  INTERFACES                                    │
│  Web Dashboard (planned)                       │
│  AI Chat (planned)                             │
│  API (live)                                    │
│  DBeaver / SQL clients (live)                  │
└──────────────────────────────────────────────┘
```

### 7.2 Entity-Relationship Model

```
                    ┌─────────────┐
                    │SourceProfile │ ← credibility tracked here
                    └──────┬──────┘
                           │ ReportedBy
                           ▼
┌─────────┐  MentionsPerson  ┌──────────────┐  ReportedEvent  ┌─────────┐
│ Person  │◄─────────────────│              │────────────────►│  Event  │
└─────────┘                  │ IntelReport  │                 └─────────┘
                    ┌────────│              │──────┐
┌──────────────┐    │        └──────────────┘      │    ┌──────────┐
│ Organization │◄───┤                              ├───►│Equipment │
└──────────────┘    │                              │    └──────────┘
                    │                              │
┌──────────┐        │                              │    ┌──────────┐
│ Location │◄───────┘                              └───►│Narrative │
└──────────┘                                           └──────────┘
       │
       │ OccurredAt / OrgControls / EquipmentSightedAt
       ▼
┌──────────┐     SynthesizedFrom     ┌──────────────┐
│  Event   │◄────────────────────────│  Assessment  │ ← analyst product
└──────────┘                         └──────────────┘

Corroborates / Contradicts: IntelReport ←→ IntelReport
Supersedes: Assessment ←→ Assessment

PersonBelongsToOrg / KeyPersonnel: Person ←→ Organization
OrgOperatesEquipment: Organization ←→ Equipment
OrgControlsLocation: Organization ←→ Location
```

### 7.3 The Knowledge Graph in Action

A single tweet generates this graph:

```
Tweet: "Russian T-90M tanks of the 58th Army spotted near Bakhmut"

Generates:
  IntelReport ◄──ReportedBy── SourceProfile(@sentdefender, cred:0.85)
       │
       ├──MentionsOrganization──► Organization("Russia", MILITARY_UNIT)
       │                              │
       │                              └──OrgOperatesEquipment──► Equipment("T-90M")
       │
       ├──MentionsOrganization──► Organization("58th Combined Arms Army")
       │
       ├──MentionsEquipment─────► Equipment("T-90M", MAIN_BATTLE_TANK)
       │
       └──MentionsLocation──────► Location("Bakhmut", UA, CITY)
```

Now you can query:
- "Show all equipment operated by Russian military units sighted in Ukraine"
- "Has the 58th Army been mentioned in any other reports this week?"
- "What's the credibility-weighted consensus on T-90M deployments near Bakhmut?"
- "Find all reports corroborating this T-90M sighting"

---

## 8. Source Credibility System

### 8.1 Scoring Methodology

Each source has a credibility score (0.0-1.0) calculated from multiple factors:

| Factor | Weight | How it's calculated |
|--------|--------|--------------------|
| **Corroboration rate** | 35% | % of reports where ≥2 other independent sources confirm the same fact |
| **Contradiction rate** | 25% | % of reports directly contradicted by higher-credibility sources (penalty) |
| **Institutional backing** | 20% | Is this an official government/military account, academic institution, or established news org? |
| **Historical accuracy** | 15% | Analyst-reviewed track record over time — does the source have a history of getting things right? |
| **Analyst score** | 5% | Manual override by senior analysts based on domain expertise |

### 8.2 Transparency

Every score is drillable:

```
@sentdefender: 0.85
  └─ Corroboration: 0.92 (892/970 reports corroborated)
  └─ Contradiction:  0.15 (12 reports contradicted, 8 by higher-cred sources)
  └─ Institutional:  0.40 (independent OSINT, not institutional)
  └─ Historical:     0.88 (consistent accuracy over 18 months)
  └─ Analyst:        0.85 (senior analyst review, June 2026)
```

### 8.3 Credibility-Weighted Consensus

When multiple sources report on the same event, the platform calculates a credibility-weighted likelihood:

```
Event: "US-Iran MOU signed remotely today"

Sources:
  @BarakRavid       (cred: 0.92) — "citing two senior US officials"
  @sentdefender     (cred: 0.85) — "according to @BarakRavid"
  @TheStudyofWar    (cred: 0.98) — "MOU now in effect, per leaked text"
  @DefenceHQ        (cred: 0.97) — "UKMTO advisory: Strait reopening"

Credibility-weighted consensus: HIGH (0.93)
  ← Weighted average of source credibility × corroboration factor
```

---

## 9. Development Phases

### Phase 1: Foundation (NOW — Weeks 1-2)
- [x] OSINT domain pack schema (10 types, 35 links)
- [x] Twitter connector (live, 3,000+ tweets ingested)
- [x] SourceProfile auto-creation
- [x] ReportedBy graph links
- [ ] NER entity extraction (P0 — 3.5 days)
- [ ] Telegram connector
- [ ] RSS connector

### Phase 2: Intelligence Core (Weeks 3-4)
- [ ] Entity dedup improvements (fuzzy matching)
- [ ] Corroboration auto-detection
- [ ] Contradiction auto-detection
- [ ] Source credibility auto-scoring
- [ ] Basic web dashboard (feed + map)

### Phase 3: Analyst Workflow (Weeks 5-6)
- [ ] Assessment creation workflow
- [ ] Corroboration/contradiction UI actions
- [ ] Escalation pipeline
- [ ] Timeline visualization
- [ ] Graph visualization

### Phase 4: Advanced Features (Weeks 7-8)
- [ ] AI chat interface (LLM + ontology tools)
- [ ] Disinformation detection
- [ ] Indicator engine with alerts
- [ ] Multi-tenancy UI
- [ ] Export formats (PDF, CSV, JSON)

### Phase 5: Enterprise Readiness (Weeks 9-10)
- [ ] Production deployment hardening
- [ ] Performance optimization
- [ ] Documentation and tutorials
- [ ] Community onboarding
- [ ] Federation protocol

---

## 10. Business Model & Revenue

### Self-Hosted (Free, Apache 2.0)

- Full platform, no restrictions. Deploy on your own hardware.
- Community support via Discord, GitHub issues, and forums.
- Revenue: $0. Sustained by community contributions and SaaS cross-subsidization.

### Managed Cloud SaaS (Paid Tiers)

| Tier | Price | What's Included |
|------|-------|----------------|
| **Starter** | Free | 1 user, 5 data sources, 10K reports/month, 7-day data retention |
| **Pro** | $49/month | 5 users, 25 data sources, 100K reports/month, 90-day retention, API access |
| **Team** | $199/month | 15 users, 100 data sources, 500K reports/month, 1-year retention, ReBAC roles, audit |
| **Enterprise** | Custom | Unlimited users, custom data sources, infinite retention, SSO, SLA, air-gapped option |

### Why this model works

- **Open-source core drives adoption** — individual researchers use the free self-hosted version, become advocates, and bring the platform into their organizations.
- **SaaS converts power users** — when teams outgrow managing their own infrastructure, they upgrade to managed hosting.
- **Enterprise pays for compliance** — government/defense users need SSO, SLA, audit, and air-gapped deployment. They pay for the enterprise tier.
- **No extractive pricing** — users can always take their data and go back to self-hosted. The SaaS premium is for convenience, not lock-in.

---

## 11. Competitive Landscape

| Tool | What It Does | Why OpenFoundry OSINT Is Different |
|------|-------------|-----------------------------------|
| **Palantir Foundry** | Enterprise ontology platform, $1M+/year | Open-source alternative. 80% of the ontology capability at 0% of the cost. Self-hosted option. No vendor lock-in. |
| **Dataminr** | Real-time alerting from social media, $20K+/year | OpenFoundry focuses on graph-building and analysis, not just alerts. Transparent credibility methodology. |
| **Maltego** | Link analysis graph, desktop app, $1K+/year | Auto-builds the graph from feeds (Maltego requires manual node creation). Web-based, collaborative, API-first. |
| **Echosec / LifeRaft** | Social media monitoring for security teams, $10K+/year | Focused on geopolitical OSINT not just brand/corpsec. Open-source. Credibility-weighted consensus. |
| **i2 Analyst's Notebook** | IBM investigative analysis, desktop, $5K+/year | Auto-ingestion from live feeds (i2 is manual import). Graph built continuously. Web-based collaboration. |
| **TweetDeck / Hootsuite** | Social media dashboards, free-$99/month | Not just monitoring — entity extraction, graph building, credibility scoring, assessment workflow. Purpose-built for OSINT. |
| **Spreadsheets + Manual** | What most individual analysts use | Automation. NER saves hours/day. Graph queries replace manual cross-referencing. |
| **Custom Python scripts** | What technical analysts build themselves | Production-grade, maintained, with dashboard, AI chat, collaboration, and audit. Saves months of DIY development. |

### Where we win

- **Open-source and self-hosted** — no competitor offers both rich ontology modeling AND open-source self-hosting
- **Transparent credibility** — every score is drillable and auditable. No black-box AI trust scores.
- **Graph-first** — entities and relationships are first-class, not an afterthought on top of a document store

### Where we lose (today)

- **Real-time alerting** — Dataminr alerts in seconds; we poll every 5 minutes
- **Enterprise compliance** — Palantir has FedRAMP, SOC2, HIPAA certs; we need to build those
- **Mobile experience** — i2 and Maltego have desktop apps; we're web-only

---

## 12. Data Privacy & Compliance

### Self-Hosted Deployments

- All data stays on the user's infrastructure. No data ever leaves their network.
- Encryption at rest (PostgreSQL TDE or filesystem encryption).
- Air-gapped deployment supported (no external API calls — wink-ner runs locally, LLM is optional and can use self-hosted models).

### SaaS Deployments

- Data encrypted at rest (AES-256) and in transit (TLS 1.3).
- Tenant isolation: each organization's data in a separate PostgreSQL schema.
- Data residency: choose deployment region (US, EU, Asia-Pacific).
- Export anytime: full data export via API or database dump. No lock-in.
- GDPR-compliant: right to access, right to deletion, data processing agreement available.
- SOC2 Type II certification planned for enterprise tier.

### Sensitive Data Handling

- `@sensitive` fields in the ODL schema (e.g., `Person.dateOfBirth`, `Person.emailAddresses`) are automatically redacted from API responses based on viewer permissions.
- Field-level redaction via ReBAC — junior analysts may see entity names but not personal details.
- Configurable data retention policies per source type.

---

## 13. Onboarding Experience

### The "Aha Moment" — First Insight in Under 5 Minutes

```
Minute 1: Sign up (SaaS) or docker compose up (self-hosted)
Minute 2: Connect Twitter — click "Authorize with X" → Chrome cookies auto-extracted
Minute 3: Dashboard populates with tweets from recommended OSINT accounts
Minute 4: Click a tweet → see extracted entities (auto-NER) and source credibility
Minute 5: Ask AI chat: "What's happening in Ukraine right now?" → get summary from live data
```

### Progressive Disclosure

| Stage | What the user sees | Complexity |
|-------|-------------------|------------|
| **Landing** | Value proposition, demo video, live public dashboard example | Zero |
| **Sign-up** | Email + password (SaaS) or `docker compose up` command (self-hosted) | Low |
| **First session** | Pre-configured OSINT feeds, auto-populated dashboard | Low |
| **First customization** | Add custom Twitter accounts, RSS feeds via UI | Medium |
| **First analysis** | Corroborate/contradict reports, create assessment | Medium |
| **Power user** | Custom GraphQL queries, API integrations, indicator configuration | High |
| **Admin** | User management, ReBAC roles, custom domain packs, federation | High |

### Documentation & Learning

- **Interactive tutorial**: guided walkthrough of the intelligence cycle using sample data
- **Video demos**: 2-5 minute videos for each major feature
- **API reference**: auto-generated OpenAPI 3.0 + GraphQL SDL docs
- **Community forum**: Discord server with channels for each persona
- **Office hours**: weekly live Q&A for Pro+ tiers

---

## 14. Collaboration Model

### Shared Workspaces

Teams share a tenant. All members see the same feeds, graph, and assessments. ReBAC controls who can do what:

```
Tenant: "Newsroom International Desk"
  ├─ Role: Editor (can publish assessments, assign credibility, manage sources)
  ├─ Role: Reporter (can create assessments, corroborate, flag for review)
  ├─ Role: Contributor (can view reports, add notes, suggest corroborations)
  └─ Role: Viewer (read-only access to published assessments)
```

### Real-Time Collaboration

- Multiple analysts can view the same report card simultaneously
- Corroboration/contradiction actions are immediately visible to all team members
- Assessment editing with comment threads per section
- Activity feed: "Alice corroborated Report #123 with Report #456", "Bob escalated Report #789 to Priority 3"

### Cross-Organization Sharing (Future — Federation)

- Organizations can share specific data via Data Sharing Agreements
- "Newsroom A shares their Middle East source credibility scores with NGO B"
- "Government Agency C shares sanitized event data with Research Institute D"
- All sharing is opt-in, auditable, and revocable

---

## 15. Content Moderation & Governance

### Who decides what's credible?

The credibility system is **algorithmic by default, human-overridable**:

1. **Algorithmic baseline**: Corroboration rate, contradiction rate, and institutional backing are calculated automatically from the graph.
2. **Analyst review**: Senior analysts can override scores with documented rationale.
3. **Transparency requirement**: Every override is logged with who changed it, when, and why.
4. **Appeal mechanism**: Source owners can request re-evaluation with evidence.

### Preventing Gaming

| Attack | Defense |
|--------|---------|
| Creating fake accounts to corroborate yourself | Corroboration only counts from sources with credibility ≥ threshold. New sources start at 0.5 and must earn trust. |
| Mass-reporting a competitor's source as disinformation | Flag actions require senior analyst role. Flags are reviewed before affecting scores. |
| Buying/selling credibility scores | Full audit trail. Anomalous score changes flagged for review. |
| Astroturfing (one entity controlling many "independent" sources) | Behavioral clustering: sources that always corroborate each other but never anyone else are flagged as potentially coordinated. |

### Content Policy for SaaS

- No illegal content (CSAM, terrorist content as defined by local law)
- No doxxing (publishing non-public personal information)
- No platform manipulation (coordinated inauthentic behavior)
- Appeals process for content removal decisions

---

## 16. Scaling Limits

### Current Baseline (Open Foundry + PostgreSQL)

| Dimension | Current Limit | Target (Phase 5) |
|-----------|--------------|-------------------|
| Reports ingested | ~30K/month (5 tweets/min, 15 accounts) | 1M+/month |
| Concurrent users | 1 (single tenant, dev mode) | 1,000+ concurrent |
| Graph vertices | 3,000+ (current) | 10M+ |
| Graph edges | 200+ (current) | 100M+ |
| Query latency | <100ms (current) | <500ms at scale |
| Extraction cycle | 5 minutes | 1-5 minutes (configurable) |
| Storage | ~10MB (current) | 100GB+ |

### Scaling Strategy

- **Horizontal scaling**: stateless API gateway, read replicas for PostgreSQL
- **Caching**: Redis for rate limiting + frequent queries; in-memory entity dedup cache
- **Batching**: bulk INSERT for high-volume ingestion
- **Partitioning**: partition `intel_report` by month for large deployments
- **Async NER**: for high-throughput, run NER in a worker queue instead of inline

---

## 17. Integration Ecosystem

### Inbound (Data Sources)

| Type | Status | Connector |
|------|--------|-----------|
| Twitter/X | ✅ Live | `twitter` — internal GraphQL API via browser cookies |
| Telegram | 🟡 Planned | `telegram` — MTProto client for channel monitoring |
| RSS/Atom | 🟡 Planned | `rss` — polling-based feed parser |
| ACLED API | ⚠️ Config | `rest` — conflict event data |
| Liveuamap API | ⚪ Future | `rest` — live conflict mapping |
| Discord | ⚪ Future | Bot-based channel monitoring |
| Reddit | ⚪ Future | Pushshift/API for subreddit monitoring |
| Custom REST API | ⚠️ Config | `rest` — connector stub needs HTTP extraction implementation |
| Webhook receiver | ⚪ Future | Accept POST webhooks as reports |
| Email ingestion | ⚪ Future | IMAP polling for newsletter/report ingestion |
| File upload | ⚪ Future | CSV/JSON upload for bulk historical data |

### Outbound (Integrations)

| Integration | Purpose |
|-------------|---------|
| **Slack/Discord webhooks** | Push alerts when indicators breach thresholds |
| **Email (SMTP)** | Daily/weekly digest of top reports |
| **Zapier/Make** | No-code automation: "when indicator triggers → create Jira ticket" |
| **Custom webhooks** | POST JSON to any URL on report ingestion/corroboration/escalation |
| **MCP Server** | Model Context Protocol — expose ontology as tools for AI agents (Claude, ChatGPT) |
| **OpenCTI** | Export indicators and reports to OpenCTI threat intelligence platform |
| **Obsidian/Roam** | Export entity graph as bidirectional links for knowledge management tools |

---

## 18. Offline & Mobile

### Field Reporter Use Case

OSINT sources are often in areas with poor or intermittent connectivity:

```
Field reporter in conflict zone:
  1. Capture photo/video on phone
  2. Add geolocation, timestamp, notes
  3. Save as pending report (stored locally)
  4. When connectivity returns → auto-sync to server
  5. Server processes: NER, credibility, graph linking
```

### Implementation

- **Progressive Web App (PWA)**: works offline, caches recent reports, syncs when online
- **Mobile-responsive dashboard**: the web dashboard works on any screen size
- **Low-bandwidth mode**: text-only feed, compressed API responses
- **Native apps** (future): iOS/Android for camera integration and background sync

---

## 19. Comparison to Palantir

### Side-by-Side Feature Matrix

| Feature | Palantir Foundry | OpenFoundry OSINT |
|---------|-----------------|-------------------|
| **Ontology modeling** | Graphical ontology editor | ODL (GraphQL SDL + YAML) — code-based, version-controlled |
| **Object types** | Unlimited, drag-and-drop | Unlimited, declarative schema |
| **Link types** | Rich relationship modeling | 35 link types in OSINT pack, extensible |
| **Actions (Kinetic)** | Full action framework | CEL-based 7-step pipeline (validate→authorize→consent→execute→audit) |
| **Data integration** | 200+ connectors, Pipeline Builder | 3 connectors (Twitter, JDBC, REST) + plugin architecture |
| **Graph visualization** | Object Explorer (Quiver) | Not yet built (planned Phase 3) |
| **Map visualization** | Geospatial analysis | Not yet built (planned Phase 2) |
| **Dashboard builder** | Workshop (low-code app builder) | Not yet built (planned Phase 2) |
| **AI/LLM integration** | AIP (full LLM orchestration) | AI chat planned (Phase 4); MCP server for agent access |
| **ReBAC authorization** | Yes (proprietary) | Yes (OpenFGA, open standard) |
| **Audit trail** | Immutable audit log | Immutable audit log |
| **Multi-tenancy** | Yes | Schema supports it; needs UI |
| **Federation** | Cross-instance data sharing | Spec exists; needs implementation |
| **Process mining** | Vertex (process mining) | Not planned |
| **Notebooks** | Slate (data science) | Not planned |
| **Pricing** | $1M+/year | Free (self-hosted) to $199/month (Team SaaS) |
| **Open source** | No | Yes (Apache 2.0) |
| **Self-hosted** | No | Yes |
| **Vendor lock-in** | High | None (exportable data, open formats) |
| **Security certifications** | FedRAMP, SOC2, HIPAA | Planned for enterprise tier |

### The 80/20 Rule

OpenFoundry OSINT does **80% of what Palantir's ontology does at 0% of the cost**. Specifically:
- ✅ Ontology modeling, object types, link types
- ✅ Governed actions with audit trail
- ✅ ReBAC authorization (same conceptual model as Palantir)
- ✅ Data integration via connectors
- ✅ Full API access (GraphQL, REST, WebSocket)
- ❌ Visual app builder (Workshop equivalent) — planned
- ❌ AI/LLM platform (AIP equivalent) — planned
- ❌ Enterprise compliance certs — planned for SaaS enterprise tier

---

## 20. Success Metrics

### Product Health

| Metric | Target | How Measured |
|--------|--------|-------------|
| **Time to first insight** | <5 minutes | From sign-up to first AI chat query answered |
| **Daily active users** | >100 (Year 1) | Login events |
| **Reports ingested/month** | >1M (Year 1) | Database count |
| **Entity extraction accuracy** | >80% precision, >60% recall | Manual audit of 1,000 random reports |
| **Source credibility correlation** | Credibility score correlates with ground truth accuracy | Historical analysis of known-true vs known-false events |
| **Assessment publication rate** | >50 assessments/week | Database count |
| **API usage** | >10K GraphQL queries/day | API gateway metrics |

### Business Health (SaaS)

| Metric | Target (Year 1) | Target (Year 3) |
|--------|----------------|-----------------|
| **Total users** | 1,000 | 10,000 |
| **Paying users** | 100 (10% conversion) | 1,000 (10% conversion) |
| **MRR** | $10,000 | $100,000 |
| **Churn** | <5% monthly | <5% monthly |
| **NPS** | >40 | >50 |
| **Self-hosted deployments** | 500 | 5,000 |

### Community Health

| Metric | Target (Year 1) |
|--------|----------------|
| **GitHub stars** | 1,000 |
| **Contributors** | 20+ |
| **Domain packs published** | 10+ (OSINT, AML, supply chain + community packs) |
| **Connector plugins** | 5+ (Twitter, Telegram, RSS, ACLED + community connectors) |
| **Discord members** | 500+ |

---

## 21. Governance & Sustainability

### Project Governance

The platform follows an **open-core with foundation stewardship** model:

- **Open Foundry core** (ontology engine, action framework, API, security) — Apache 2.0, maintained by the open-source community
- **OSINT domain pack** — Apache 2.0, community-maintained with designated maintainers
- **SaaS platform** — operated by a commercial entity that employs core maintainers
- **Decision-making**: RFC process for major changes. 3 core maintainers must approve. Community vote for contentious decisions.

### Sustainability Plan

| Revenue Source | Purpose |
|---------------|---------|
| **SaaS subscriptions** | Pays for infrastructure, support, and core maintainer salaries |
| **Enterprise contracts** | Custom deployments, SLAs, compliance certifications |
| **Grants & sponsorships** | Non-profit OSINT research, educational licenses |
| **Community donations** | GitHub Sponsors, Open Collective |

### Why This Won't Die Like Most Open-Source Projects

1. **SaaS cross-subsidizes open-source** — paid users fund the free version, not the other way around
2. **Real economic value** — OSINT analysts save 10-20 hours/week. That's worth paying for.
3. **Network effects** — more users → more sources tracked → better credibility data → more value → more users
4. **Low marginal cost** — infrastructure costs scale sub-linearly with users
5. **Government/defense budget** — intelligence agencies have procurement budgets for exactly this category

---

## 22. Open Questions

1. **Authentication for dashboard**: Use OpenFoundry's Keycloak OIDC? Or add simpler email/password for researchers?
2. **Public vs private instances**: Allow users to publish selected reports/assessments to a public-facing page? Or keep everything private by default?
3. **AI provider**: Self-hosted LLM (Llama, Mistral) for air-gapped deployments? Or support OpenAI/Anthropic APIs for those who can use them?
4. **Mobile app**: Necessary for field reporters? Or is mobile-web responsive dashboard sufficient?
5. **Community packs**: Allow users to share equipment gazetteers, source lists, and indicator templates as community domain packs?
6. **Pricing validation**: Is the proposed SaaS pricing ($0/$49/$199/Custom) aligned with what target users would pay?
7. **Name & branding**: Is "OpenFoundry OSINT" the right product name? Or something more distinct?
8. **Launch strategy**: Product Hunt? Hacker News? OSINT community conferences? Direct outreach to target personas?

---

## Sources

- session — Full context of user's vision across multiple conversations
- `domain-packs/osint/` — OSINT domain pack schema and connectors
- `packages/sync/src/connectors/twitter-connector.ts` — Live Twitter ingestion
- `packages/api/src/server.ts` — Connector wiring and extraction loops
- `docs/features/ner-entity-extraction-plan.md` — NER implementation plan
- `docs/decisions/adr-010-osint-schema-design.md` — Entity model design rationale
