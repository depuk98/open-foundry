---
title: OSINT Domain Pack
created: 2026-06-18
last_updated: 2026-06-20
type: feature
status: in-progress
related_components:
  - ontology-engine
  - action-executor
  - security-service
  - sync-engine
  - ner-extraction
  - twitter-connector
related_decisions:
  - adr-009-twitter-internal-api
  - adr-010-osint-schema-design
  - adr-013-palantir-domain-pack-refactor
related_features:
  - domain-pack-palantir-refactor
  - osint-platform-roadmap  - sync-engine
  - api-gateway
  - ner-extraction
related_decisions: []
---

# OSINT Domain Pack

The Geopolitical OSINT domain pack (`osint`, v0.2.0) is the most ambitious domain pack, modelling the full intelligence cycle: raw intelligence ingestion from multiple sources, entity extraction (persons, organizations, locations, equipment), source credibility tracking, report corroboration/contradiction, narrative tracking, early-warning indicators, and finished intelligence assessment production. It supports 10 object types, approximately 35 link types, 7 governed actions, 4 connectors, 2 computed functions, and 2 quality rules.

## Scope

### Object Types (10)

| Type | Description |
|------|-------------|
| **IntelReport** | The atomic unit of raw intelligence. Every tweet, Telegram message, RSS article, or API data point becomes an IntelReport. Fields: `id`, `content` (searchable), `summary`, `language`, `source` (IntelSource enum: TWITTER, TELEGRAM, RSS, ACLED, etc.), `sourcePlatform`, `sourceUrl`, `sourceChannel`, `publishedAt`, `retrievedAt` (readonly), `reportedLocation` (GeoPoint), `country` (Country enum, ~60 codes), `region`, `sourceCredibilityScore`, `reportCredibility`, `verificationMethod`, `status` (IntelReportStatus: RAW→TRIAGED→VERIFIED→CORROBORATED→DISPUTED→ESCALATED→ARCHIVED), `priority`, `tags`, `mediaUrls`, `rawMetadata` (JSON), `corroborationCount` (computed), `contradictionCount` (computed). Implements Identifiable & Auditable interfaces. |
| **SourceProfile** | Intelligence source (Twitter account, Telegram channel, RSS feed, institutional publisher). Fields: `id`, `handle` (unique), `displayName`, `platform`, `profileUrl`, `description`, `categories` (SourceCategory enum: CONFLICT_MONITOR, GEOSPATIAL_ANALYST, OSINT_ANALYST, INSTITUTIONAL, etc.), `credibilityScore`, `credibilityBasis`, `totalReports` (computed), `knownBiases`, `isMonitored`, `monitoringPriority`, `lastActive`, `followerCount`, `status` (SourceStatus: ACTIVE/INACTIVE/SUSPENDED/BANNED). Implements Identifiable & Auditable. |
| **Person** | Individual of interest. Fields include `name`, `aliases`, `nationality`, `dateOfBirth`, `role`, `affiliations`, `watchlistStatus` (WatchlistStatus: NONE/MONITORED/FLAGGED/SANCTIONED). Linked to Organization via `PersonBelongsToOrg`/`PersonPreviouslyInOrg`, to Event via `PersonInvolvedInEvent`. |
| **Organization** | Military unit, government agency, NGO, armed group, corporation, etc. Fields: `name`, `aliases`, `type` (OrgType: MILITARY_UNIT, GOVERNMENT_AGENCY, INTELLIGENCE_AGENCY, NGO, ARMED_GROUP, etc.), `country`, `description`, `status`, `watchlistStatus`. Linked hierarchically via `OrgSubordinateTo`. Controls locations (`OrgControlsLocation`), operates equipment (`OrgOperatesEquipment`). |
| **Location** | Geographic point of interest. Fields: `name`, `coordinates` (GeoPoint), `type` (LocationType: CITY, TOWN, VILLAGE, MILITARY_BASE, AIRFIELD, PORT, BORDER_CROSSING, etc.), `country`, `status` (LocationStatus: UNDER_CONTROL/CONTESTED/OCCUPIED/LIBERATED/DESTROYED). Links to Events, Equipment sightings, Organization control. |
| **Event** | Discrete event: battles, airstrikes, protests, diplomatic meetings. Fields: `eventDate`, `type` (EventType: AIR_STRIKE, ARTILLERY_SHELLING, DRONE_ATTACK, MISSILE_ATTACK, GROUND_ENGAGEMENT, CIVILIAN_CASUALTY, PROTEST, DIPLOMATIC, CYBER_ATTACK, etc.), `description`, `location`, `fatalities`, `casualtiesWounded`, `displacedPersons`, `attributionConfidence`, `geolocationVerified`. Implements Identifiable, Auditable, Locatable, Temporal. |
| **Equipment** | Military/hardware platforms. Fields: `name`, `category` (EquipmentCategory: MAIN_BATTLE_TANK, ARMORED_VEHICLE, ARTILLERY, DRONE, LOITERING_MUNITION, ELECTRONIC_WARFARE, etc.), `model`, `manufacturer`, `countryOfOrigin`, `status` (EquipmentStatus: OPERATIONAL/DAMAGED/DESTROYED/CAPTURED/ABANDONED). Sighted at locations, used in events. |
| **Assessment** | Finished intelligence product combining multiple source reports. Fields: `title`, `executiveSummary`, `fullContent`, `author`, `classification` (UNCLASSIFIED/OFFICIAL/SECRET/TOP_SECRET), `status` (DRAFT→IN_REVIEW→PUBLISHED→RETRACTED→SUPERSEDED), `region`, `overallConfidence` (HIGH/MEDIUM/LOW). Links to source IntelReports, assessed Events/Orgs/Persons. Supports `SupersedesAssessment`/`SupersededByAssessment` chains. |
| **Narrative** | Disinformation/misinformation/propaganda narrative tracking. Fields: `name`, `type` (DISINFORMATION, MISINFORMATION, PROPAGANDA, CONSPIRACY_THEORY, INFORMATION_OPERATION), `description`, `status` (ACTIVE/WANING/RESURGENT/CONTAINED/DEBUNKED), `firstObserved`, `lastObserved`, `estimatedReach`. Links to originating organizations, amplifying organizations, source reports, and debunking sources. |
| **Indicator** | Early warning indicator with CEL trigger conditions. Fields: `name`, `description`, `category`, `triggerCondition` (CEL expression), `warningThreshold`, `criticalThreshold`, `currentValue`, `status` (ACTIVE/TRIGGERED/DISMISSED/EXPIRED), `valueHistory` (JSON). Watches Events, Locations, Organizations. |

### Link Types (~35)

The OSINT pack has by far the richest relationship graph. Major link groups:

| Group | Links |
|-------|-------|
| **Source → Report** | `ReportedBy` (IntelReport → SourceProfile) |
| **Report → Entities** | `MentionsPerson`, `MentionsOrganization`, `MentionsLocation`, `MentionsEquipment` (all MANY_TO_MANY with confidence scores) |
| **Report → Event** | `ReportedEvent` (MANY_TO_MANY) |
| **Report ↔ Report** | `Corroborates` (with overlapScore), `Contradicts` (with conflictDescription) |
| **Person ↔ Organization** | `PersonBelongsToOrg`, `PersonPreviouslyInOrg`, `KeyPersonnelInOrg` |
| **Source ↔ Entity** | `ProfileForPerson`, `ProfileForOrganization` |
| **Organization hierarchy** | `OrgSubordinateTo` |
| **Organization → Equipment** | `OrgOperatesEquipment` (with quantity, variant, firstObserved/lastObserved, status) |
| **Organization → Location** | `OrgControlsLocation`, `OrgHQAtLocation` |
| **Event relationships** | `OccurredAtLocation`, `PersonInvolvedInEvent`, `OrgInvolvedInEvent`, `EventAttributedToOrg`, `EventClaimedByOrg`, `EquipmentUsedInEvent`, `InfrastructureDamagedInEvent` |
| **Equipment sightings** | `EquipmentSightedAtLocation` |
| **Assessment → Entities** | `SynthesizedFrom` (IntelReports), `AssessmentCoversEvent`, `AssessmentCoversOrg`, `AssessmentCoversPerson`, `SupersedesAssessment`, `SupersededByAssessment` |
| **Narrative links** | `NarrativeOriginatedByOrg`, `NarrativeAmplifiedByOrg`, `NarrativeSourceReport`, `NarrativeDebunkedBySource` |
| **Indicator watching** | `IndicatorWatchesEvent`, `IndicatorWatchesLocation`, `IndicatorWatchesOrg` |

### Actions (7)

| Action | Description | Key Params |
|--------|-------------|------------|
| `CorroborateReport` | Link two IntelReports as mutually supporting with an overlap score | sourceReport, targetReport, overlapScore (0.0–1.0), analysis |
| `ContradictReport` | Link two IntelReports as contradictory | sourceReport, targetReport, conflictDescription |
| `EscalateReport` | Escalate a report for analyst attention | report, priority (1–5), reason |
| `CreateAssessment` | Create a finished intelligence assessment from source reports | title, executiveSummary, fullContent, region?, country?, sourceReportIds, overallConfidence |
| `GeoVerifyReport` | Verify a report's location against satellite/OSINT imagery | report, verifiedLocation (GeoPoint), locationName, proofUrls, method |
| `FlagDisinformation` | Flag a report as disinformation, optionally linking to a narrative | report, narrative?, reason, evidenceUrls |
| `AssignSourceCredibility` | Update a source's credibility score with reasoning | source, newScore (0.0–1.0), reason |

### Enums

The pack defines 17 rich enumerations including `IntelSource` (8 values), `EventType` (18 values), `EquipmentCategory` (16 values), `OrgType` (11 values), `LocationType` (14 values), `LocationStatus` (7 values), `EquipmentStatus` (7 values), `Country` (~60 codes), `ConfidenceLevel`, `CredibilityRating`, `IntelReportStatus`, `AssessmentStatus`, `AssessmentClassification`, `IndicatorStatus`, `NarrativeType`, `NarrativeStatus`, `UnitSize` (9 values), and more.

## Implementation

The pack is composed of:
- **12 ODL schemas**: `enums.odl`, `intel-report.odl`, `source-profile.odl`, `person.odl`, `organization.odl`, `location.odl`, `event.odl`, `equipment.odl`, `assessment.odl`, `indicator.odl`, `narrative.odl`, `links.odl`, `actions.odl`
- **7 action manifests**: YAML files with CEL preconditions/effects
- **Permissions**: `osint-roles.fga` — OpenFGA authorization model for analysts, senior analysts, and admins
- **Seed data**: `seed/sources.yaml` — initial source profiles and monitored accounts
- **Browser cookie support**: `src/browser-cookies.ts` — auto-extracts Twitter auth tokens from Chrome/Edge/Firefox browser cookie stores (macOS Keychain, Linux gnome-keyring/libsecret, Windows DPAPI)
- **Tests**: `src/__tests__/osint-pack.test.ts` and `src/__tests__/browser-cookies.test.ts`

Several object types implement multiple interfaces: `IntelReport`, `SourceProfile`, `Assessment`, `Event`, and `Indicator` all implement `Identifiable & Auditable`. `Event` additionally implements `Locatable & Temporal`. The IntelReport type has two computed fields (`corroborationCount`, `contradictionCount`) driven by CEL functions.

## Connectors (4)

### Twitter OSINT (active)

- **Datasource**: `Twitter_OSINT_Feed` — ingests tweets from 15 monitored OSINT accounts and 3 saved searches
- **Connector type**: `twitter` — uses Twitter's internal GraphQL API with browser auth cookies (no X API v2 key required)
- **Sync mode**: `POLLING` every 5 minutes, SOURCE_PRIORITY conflict resolution, rate-limited to 5 req/s
- **Writeback**: disabled
- **Mapping**: tweets → `IntelReport`. Creates linked `SourceProfile` objects via `ReportedBy` link
- **Monitored accounts (15)**: sentdefender, Osinttechnical, GeoConfirmed, Tendar, RALee85, CalibreObscura, ELINTNews, TheStudyofWar, CriticalThreats, bellingcat, Cen4infoRes, CITeam_en, DefenceHQ, DefMon3, IntelCrab
- **Status**: **Running** — browser cookie extraction implemented and tested

### Telegram Channels (planned)

- **Datasource**: `Telegram_OSINT_Feed` — ingests messages from 6 monitored channels via MTProto client API
- **Connector type**: `telegram`
- **Sync mode**: `CDC`, SOURCE_PRIORITY conflict resolution, rate-limited to 10 req/s
- **Auth**: Environment variables `TG_API_ID` and `TG_API_HASH`
- **Monitored channels (6)**: @rybar_en, @suriyak_maps, @bellingcat, @IntelSlava, @DDGeopolitics, @TheIntelLab
- **Status**: Planned — connector config exists; MTProto client implementation pending

### ISW RSS (planned)

- **Datasource**: `ISW_Ukraine_Assessment` — polls the Institute for the Study of War Ukraine campaign assessment RSS feed
- **Connector type**: `rss`
- **Sync mode**: `POLLING` every 15 minutes, SOURCE_PRIORITY conflict resolution
- **Mapping**: RSS items → `Assessment` object type (transforms to finished intelligence assessments)
- **Status**: Planned — connector config exists; RSS polling implementation pending

### ACLED API (active)

- **Datasource**: `ACLED_Conflict_Data` — ingests conflict event data from the Armed Conflict Location & Event Data Project
- **Connector type**: `rest`
- **Sync mode**: `OVERLAY` with TTL cache (PT1H)
- **Writeback**: disabled
- **Mapping**: ACLED events → `Event` object type. Filters for Europe, Middle East, and Africa regions; event types: Battles, Explosions/Remote violence, Violence against civilians; 7-day lookback
- **Auth**: Environment variable `ACLED_API_KEY` (register at acleddata.com)
- **Status**: **Active** — REST connector implemented

## Status & Roadmap

- **Current**: **In-progress** (v0.2.0). Twitter and ACLED connectors are running; Telegram, ISW RSS connectors have full configuration but pending MTProto/RSS client implementation; NER (Named Entity Recognition) extraction pipeline planned to populate the Person/Organization/Location/Equipment entity graph from raw IntelReport content.
- **v0.2.0**: 10 object types, ~35 link types, 7 actions, 4 connectors (2 active, 2 planned), 2 functions, 2 quality rules
- **Immediate roadmap**:
  - Complete Telegram MTProto connector implementation
  - Complete ISW RSS polling connector
  - Implement NER extraction pipeline (IntelReport → entity mentions → graph population)
  - Implement Indicator evaluation engine (CEL trigger conditions against live data)
  - Narrative tracking lifecycle (detect, classify, track amplification, debunk)

## Sources

- [Source: domain-packs/osint/pack.yaml]
- [Source: domain-packs/osint/schema/ — all ODL schemas (12 files)]
- [Source: domain-packs/osint/actions/ — action manifests (7 files)]
- [Source: domain-packs/osint/connectors/ — connector configs (4 files)]
- [Source: domain-packs/osint/permissions/osint-roles.fga]
- [Source: domain-packs/osint/seed/sources.yaml]
- [Source: domain-packs/osint/src/browser-cookies.ts]
- [Source: README.md — Domain Packs section]
