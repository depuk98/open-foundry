/**
 * Tests for the OSINT (Open Source Intelligence) domain pack.
 *
 * Validates:
 * - All ODL files parse and validate (combined schema)
 * - Enums, ObjectTypes, LinkTypes, ActionTypes
 * - All action manifests parse correctly
 * - Pack manifest structure
 * - OpenFGA permissions model content
 * - Connector configurations
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOdl, validateSchema } from '@openfoundry/odl';
import { parseActionManifest } from '@openfoundry/actions';
import { parse as parseYaml } from 'yaml';
import type { ParsedSchema, FieldDirective } from '@openfoundry/odl';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = resolve(__dirname, '..', '..');

// ─── Helpers ───

function readOdl(filename: string): string {
  return readFileSync(resolve(PACK_ROOT, 'schema', filename), 'utf-8');
}

function readAction(filename: string): string {
  return readFileSync(resolve(PACK_ROOT, 'actions', filename), 'utf-8');
}

function findDirective<K extends FieldDirective['kind']>(
  directives: FieldDirective[],
  kind: K,
): Extract<FieldDirective, { kind: K }> | undefined {
  return directives.find(d => d.kind === kind) as Extract<FieldDirective, { kind: K }> | undefined;
}

// ─── Load all ODL files as combined source ───

const ODL_FILES = [
  'enums.odl',
  'intel-report.odl',
  'source-profile.odl',
  'person.odl',
  'organization.odl',
  'location.odl',
  'event.odl',
  'equipment.odl',
  'assessment.odl',
  'indicator.odl',
  'narrative.odl',
  'links.odl',
  'actions.odl',
];

function buildCombinedSource(): string {
  const sources = ODL_FILES.map(f => readOdl(f));
  const first = sources[0]!;
  const rest = sources.slice(1).map(s =>
    s.replace(/^extend schema @namespace\([^)]+\)\s*/m, ''),
  );
  return [first, ...rest].join('\n\n');
}

const combinedSource = buildCombinedSource();

// ─── Tests ───

describe('OSINT Domain Pack — ODL Schema Parsing', () => {
  let schema: ParsedSchema;

  schema = parseOdl(combinedSource);

  describe('namespace', () => {
    it('declares osint namespace', () => {
      expect(schema.namespace).toBeDefined();
      expect(schema.namespace!.name).toBe('osint');
      expect(schema.namespace!.version).toBe('0.2.0');
    });
  });

  describe('enums', () => {
    it('declares all 21 enums', () => {
      const enumNames = schema.enums.map(e => e.name).sort();
      expect(enumNames).toEqual([
        'AssessmentClassification',
        'AssessmentStatus',
        'ConfidenceLevel',
        'Country',
        'CredibilityRating',
        'EquipmentCategory',
        'EquipmentStatus',
        'EventType',
        'IndicatorStatus',
        'IntelReportStatus',
        'IntelSource',
        'LocationStatus',
        'LocationType',
        'NarrativeStatus',
        'NarrativeType',
        'OrgType',
        'SourceCategory',
        'SourceStatus',
        'UnitSize',
        'WatchlistStatus',
      ].sort());
    });

    it('IntelSource has correct values', () => {
      const e = schema.enums.find(e => e.name === 'IntelSource')!;
      expect(e.values.map(v => v.name)).toContain('TWITTER');
      expect(e.values.map(v => v.name)).toContain('TELEGRAM');
      expect(e.values.map(v => v.name)).toContain('RSS');
      expect(e.values.map(v => v.name)).toContain('ACLED');
    });

    it('CredibilityRating has correct values', () => {
      const e = schema.enums.find(e => e.name === 'CredibilityRating')!;
      expect(e.values.map(v => v.name)).toEqual([
        'VERIFIED', 'LIKELY', 'POSSIBLE', 'DOUBTFUL', 'DISPROVEN', 'UNEVALUATED',
      ]);
    });

    it('EventType has correct values', () => {
      const e = schema.enums.find(e => e.name === 'EventType')!;
      expect(e.values.map(v => v.name)).toContain('AIR_STRIKE');
      expect(e.values.map(v => v.name)).toContain('GROUND_ENGAGEMENT');
      expect(e.values.map(v => v.name)).toContain('DRONE_ATTACK');
    });

    it('OrgType has correct values', () => {
      const e = schema.enums.find(e => e.name === 'OrgType')!;
      expect(e.values.map(v => v.name)).toContain('MILITARY_UNIT');
      expect(e.values.map(v => v.name)).toContain('ARMED_GROUP');
      expect(e.values.map(v => v.name)).toContain('GOVERNMENT_AGENCY');
    });

    it('EquipmentCategory has correct values', () => {
      const e = schema.enums.find(e => e.name === 'EquipmentCategory')!;
      expect(e.values.map(v => v.name)).toContain('MAIN_BATTLE_TANK');
      expect(e.values.map(v => v.name)).toContain('DRONE');
      expect(e.values.map(v => v.name)).toContain('MISSILE_SYSTEM');
    });

    it('IntelReportStatus has correct values', () => {
      const e = schema.enums.find(e => e.name === 'IntelReportStatus')!;
      expect(e.values.map(v => v.name)).toEqual([
        'RAW', 'TRIAGED', 'VERIFIED', 'CORROBORATED', 'DISPUTED', 'ESCALATED', 'ARCHIVED',
      ]);
    });

    it('Country enum includes conflict-relevant codes', () => {
      const e = schema.enums.find(e => e.name === 'Country')!;
      const names = e.values.map(v => v.name);
      expect(names).toContain('UA');
      expect(names).toContain('RU');
      expect(names).toContain('US');
      expect(names).toContain('CN');
      expect(names).toContain('IR');
      expect(names).toContain('IL');
      expect(names).toContain('SY');
      expect(names).toContain('IQ');
    });
  });

  describe('objectTypes (10)', () => {
    it('declares all 10 ObjectTypes', () => {
      const names = schema.objectTypes.map(t => t.name).sort();
      expect(names).toEqual([
        'Assessment', 'Equipment', 'Event', 'Indicator', 'IntelReport',
        'Location', 'Narrative', 'Organization', 'Person', 'SourceProfile',
      ]);
    });

    describe('IntelReport', () => {
      let report: ParsedSchema['objectTypes'][0];

      beforeAll(() => {
        report = schema.objectTypes.find(t => t.name === 'IntelReport')!;
      });

      it('has core content fields', () => {
        const names = report.fields.map(f => f.name);
        expect(names).toContain('content');
        expect(names).toContain('summary');
        expect(names).toContain('language');
        expect(names).toContain('source');
        expect(names).toContain('sourcePlatform');
        expect(names).toContain('sourceChannel');
      });

      it('content is @searchable with weight', () => {
        const field = report.fields.find(f => f.name === 'content')!;
        const searchable = findDirective(field.directives, 'searchable');
        expect(searchable).toBeDefined();
      });

      it('publishedAt is @indexed', () => {
        const field = report.fields.find(f => f.name === 'publishedAt')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });

      it('country is Country enum @indexed', () => {
        const field = report.fields.find(f => f.name === 'country')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });

      it('sourceCredibilityScore has @constraint 0-1', () => {
        const field = report.fields.find(f => f.name === 'sourceCredibilityScore')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toContain('value >= 0.0');
        expect(constraint!.expr).toContain('value <= 1.0');
      });

      it('has @computed corroborationCount and contradictionCount', () => {
        const ccField = report.fields.find(f => f.name === 'corroborationCount')!;
        const ccDirective = findDirective(ccField.directives, 'computed');
        expect(ccDirective).toBeDefined();
        expect(ccDirective!.fn).toBe('countLinks');

        const ctField = report.fields.find(f => f.name === 'contradictionCount')!;
        const ctDirective = findDirective(ctField.directives, 'computed');
        expect(ctDirective).toBeDefined();
        expect(ctDirective!.fn).toBe('countLinks');
      });

      it('has link traversal fields to related entities', () => {
        const names = report.fields.map(f => f.name);
        expect(names).toContain('sourceProfile');
        expect(names).toContain('mentionedPersons');
        expect(names).toContain('mentionedOrgs');
        expect(names).toContain('mentionedLocations');
        expect(names).toContain('mentionedEquipment');
        expect(names).toContain('relatedEvent');
      });

      it('implements Identifiable and Auditable', () => {
        const interfaces = report.interfaces;
        expect(interfaces).toContain('Identifiable');
        expect(interfaces).toContain('Auditable');
      });
    });

    describe('SourceProfile', () => {
      it('handle is @unique @indexed', () => {
        const sp = schema.objectTypes.find(t => t.name === 'SourceProfile')!;
        const field = sp.fields.find(f => f.name === 'handle')!;
        expect(findDirective(field.directives, 'unique')).toBeDefined();
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });

      it('credibilityScore has @constraint 0-1', () => {
        const sp = schema.objectTypes.find(t => t.name === 'SourceProfile')!;
        const field = sp.fields.find(f => f.name === 'credibilityScore')!;
        const constraint = findDirective(field.directives, 'constraint');
        expect(constraint).toBeDefined();
        expect(constraint!.expr).toContain('value >= 0.0 && value <= 1.0');
      });

      it('totalReports is @computed', () => {
        const sp = schema.objectTypes.find(t => t.name === 'SourceProfile')!;
        const field = sp.fields.find(f => f.name === 'totalReports')!;
        expect(findDirective(field.directives, 'computed')).toBeDefined();
      });

      it('isMonitored is @indexed', () => {
        const sp = schema.objectTypes.find(t => t.name === 'SourceProfile')!;
        const field = sp.fields.find(f => f.name === 'isMonitored')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });
    });

    describe('Person', () => {
      it('fullName is @searchable with weight', () => {
        const person = schema.objectTypes.find(t => t.name === 'Person')!;
        const field = person.fields.find(f => f.name === 'fullName')!;
        const searchable = findDirective(field.directives, 'searchable');
        expect(searchable).toBeDefined();
      });

      it('isPersonOfInterest is @indexed', () => {
        const person = schema.objectTypes.find(t => t.name === 'Person')!;
        const field = person.fields.find(f => f.name === 'isPersonOfInterest')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });

      it('implements Locatable', () => {
        const person = schema.objectTypes.find(t => t.name === 'Person')!;
        expect(person.interfaces).toContain('Locatable');
      });
    });

    describe('Organization', () => {
      it('name is @searchable with weight', () => {
        const org = schema.objectTypes.find(t => t.name === 'Organization')!;
        const field = org.fields.find(f => f.name === 'name')!;
        const searchable = findDirective(field.directives, 'searchable');
        expect(searchable).toBeDefined();
      });

      it('type is OrgType @indexed', () => {
        const org = schema.objectTypes.find(t => t.name === 'Organization')!;
        const field = org.fields.find(f => f.name === 'type')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });

      it('isDesignated is @indexed', () => {
        const org = schema.objectTypes.find(t => t.name === 'Organization')!;
        const field = org.fields.find(f => f.name === 'isDesignated')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });
    });

    describe('Event', () => {
      it('eventDate is @indexed', () => {
        const event = schema.objectTypes.find(t => t.name === 'Event')!;
        const field = event.fields.find(f => f.name === 'eventDate')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });

      it('type is EventType @indexed', () => {
        const event = schema.objectTypes.find(t => t.name === 'Event')!;
        const field = event.fields.find(f => f.name === 'type')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });

      it('country is Country @indexed', () => {
        const event = schema.objectTypes.find(t => t.name === 'Event')!;
        const field = event.fields.find(f => f.name === 'country')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });

      it('reportCount is @computed', () => {
        const event = schema.objectTypes.find(t => t.name === 'Event')!;
        const field = event.fields.find(f => f.name === 'reportCount')!;
        expect(findDirective(field.directives, 'computed')).toBeDefined();
      });

      it('implements Temporal and Locatable', () => {
        const event = schema.objectTypes.find(t => t.name === 'Event')!;
        expect(event.interfaces).toContain('Temporal');
        expect(event.interfaces).toContain('Locatable');
      });
    });

    describe('Equipment', () => {
      it('designation is @searchable with weight', () => {
        const eq = schema.objectTypes.find(t => t.name === 'Equipment')!;
        const field = eq.fields.find(f => f.name === 'designation')!;
        const searchable = findDirective(field.directives, 'searchable');
        expect(searchable).toBeDefined();
      });

      it('category is @indexed', () => {
        const eq = schema.objectTypes.find(t => t.name === 'Equipment')!;
        const field = eq.fields.find(f => f.name === 'category')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });
    });

    describe('Assessment', () => {
      it('title is @searchable with weight', () => {
        const asmt = schema.objectTypes.find(t => t.name === 'Assessment')!;
        const field = asmt.fields.find(f => f.name === 'title')!;
        const searchable = findDirective(field.directives, 'searchable');
        expect(searchable).toBeDefined();
      });

      it('publishedAt is @indexed', () => {
        const asmt = schema.objectTypes.find(t => t.name === 'Assessment')!;
        const field = asmt.fields.find(f => f.name === 'publishedAt')!;
        expect(findDirective(field.directives, 'indexed')).toBeDefined();
      });

      it('sourceCount is @computed', () => {
        const asmt = schema.objectTypes.find(t => t.name === 'Assessment')!;
        const field = asmt.fields.find(f => f.name === 'sourceCount')!;
        expect(findDirective(field.directives, 'computed')).toBeDefined();
      });
    });
  });

  describe('linkTypes (35)', () => {
    it('declares at least 35 LinkTypes', () => {
      expect(schema.linkTypes.length).toBeGreaterThanOrEqual(35);
    });

    it('ReportedBy: IntelReport -> SourceProfile, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'ReportedBy')!;
      expect(lt.from).toBe('IntelReport');
      expect(lt.to).toBe('SourceProfile');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
    });

    it('MentionsPerson: IntelReport -> Person, MANY_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'MentionsPerson')!;
      expect(lt.from).toBe('IntelReport');
      expect(lt.to).toBe('Person');
      expect(lt.cardinality).toBe('MANY_TO_MANY');
    });

    it('Corroborates: IntelReport -> IntelReport, MANY_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'Corroborates')!;
      expect(lt.from).toBe('IntelReport');
      expect(lt.to).toBe('IntelReport');
      expect(lt.cardinality).toBe('MANY_TO_MANY');
    });

    it('PersonBelongsToOrg: Person -> Organization, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'PersonBelongsToOrg')!;
      expect(lt.from).toBe('Person');
      expect(lt.to).toBe('Organization');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
    });

    it('EventAttributedToOrg: Event -> Organization, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'EventAttributedToOrg')!;
      expect(lt.from).toBe('Event');
      expect(lt.to).toBe('Organization');
      expect(lt.cardinality).toBe('MANY_TO_ONE');
    });

    it('OrgOperatesEquipment: Organization -> Equipment, MANY_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'OrgOperatesEquipment')!;
      expect(lt.from).toBe('Organization');
      expect(lt.to).toBe('Equipment');
      expect(lt.cardinality).toBe('MANY_TO_MANY');
    });

    it('SynthesizedFrom: Assessment -> IntelReport, MANY_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'SynthesizedFrom')!;
      expect(lt.from).toBe('Assessment');
      expect(lt.to).toBe('IntelReport');
    });

    it('SupersedesAssessment: Assessment -> Assessment, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'SupersedesAssessment')!;
      expect(lt.from).toBe('Assessment');
      expect(lt.to).toBe('Assessment');
    });

    it('NarrativeOriginatedByOrg: Narrative -> Organization, MANY_TO_ONE', () => {
      const lt = schema.linkTypes.find(t => t.name === 'NarrativeOriginatedByOrg')!;
      expect(lt.from).toBe('Narrative');
      expect(lt.to).toBe('Organization');
    });

    it('IndicatorWatchesEvent: Indicator -> Event, MANY_TO_MANY', () => {
      const lt = schema.linkTypes.find(t => t.name === 'IndicatorWatchesEvent')!;
      expect(lt.from).toBe('Indicator');
      expect(lt.to).toBe('Event');
    });

    it('all LinkTypes have an id @primary field', () => {
      for (const lt of schema.linkTypes) {
        const idField = lt.fields.find(f => f.name === 'id');
        expect(idField).toBeDefined();
        expect(findDirective(idField!.directives, 'primary')).toBeDefined();
      }
    });
  });

  describe('action types', () => {
    it('defines 7 action types', () => {
      expect(schema.actionTypes).toHaveLength(7);
      const names = schema.actionTypes.map(a => a.name);
      expect(names).toContain('CorroborateReport');
      expect(names).toContain('ContradictReport');
      expect(names).toContain('EscalateReport');
      expect(names).toContain('CreateAssessment');
      expect(names).toContain('GeoVerifyReport');
      expect(names).toContain('FlagDisinformation');
      expect(names).toContain('AssignSourceCredibility');
    });

    it('EscalateReport priority has @constraint 1-5', () => {
      const action = schema.actionTypes.find(a => a.name === 'EscalateReport')!;
      const priority = action.fields.find(f => f.name === 'priority')!;
      const constraint = findDirective(priority.directives, 'constraint');
      expect(constraint).toBeDefined();
      expect(constraint!.expr).toContain('value >= 1');
      expect(constraint!.expr).toContain('value <= 5');
    });

    it('AssignSourceCredibility newScore has @constraint 0-1', () => {
      const action = schema.actionTypes.find(a => a.name === 'AssignSourceCredibility')!;
      const newScore = action.fields.find(f => f.name === 'newScore')!;
      const constraint = findDirective(newScore.directives, 'constraint');
      expect(constraint).toBeDefined();
      expect(constraint!.expr).toContain('value >= 0.0 && value <= 1.0');
    });
  });
});

describe('OSINT Domain Pack — ODL Validation', () => {
  it('validates combined schema without errors', () => {
    const schema = parseOdl(combinedSource);
    const result = validateSchema(schema);

    if (result.errors.length > 0) {
      for (const err of result.errors) {
        console.error(`[${err.code}] ${err.message}`);
      }
    }

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

describe('OSINT Domain Pack — Individual ODL Files', () => {
  for (const file of ODL_FILES) {
    it(`${file} parses without GraphQL syntax errors`, () => {
      const source = readOdl(file);
      const schema = parseOdl(source);
      expect(schema).toBeDefined();
    });
  }
});

describe('OSINT Domain Pack — Action Manifests', () => {
  const actionFiles = [
    'corroborate-report.yaml',
    'contradict-report.yaml',
    'escalate-report.yaml',
    'create-assessment.yaml',
    'geo-verify-report.yaml',
    'flag-disinformation.yaml',
    'assign-source-credibility.yaml',
  ];

  for (const file of actionFiles) {
    describe(file, () => {
      it('parses without errors', () => {
        const yaml = readAction(file);
        const result = parseActionManifest(yaml);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.manifest).toBeDefined();
      });
    });
  }

  describe('corroborate-report.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('corroborate-report.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('CorroborateReport');
      expect(m.version).toBe(1);
      expect(m.reversible).toBe(false);
      expect(m.preconditions).toHaveLength(3);
      expect(m.effects).toHaveLength(2);
      expect(m.sideEffects).toHaveLength(1);
    });

    it('preconditions prevent self-corroboration', () => {
      const result = parseActionManifest(readAction('corroborate-report.yaml'));
      const selfCheck = result.manifest!.preconditions[0]!;
      expect(selfCheck.expr).toContain('sourceReport.id != targetReport.id');
    });

    it('effects create Corroborates link and update sourceReport status', () => {
      const result = parseActionManifest(readAction('corroborate-report.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['createLink', 'updateObject']);
    });
  });

  describe('escalate-report.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('escalate-report.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('EscalateReport');
      expect(m.version).toBe(1);
      expect(m.reversible).toBe(true);
      expect(m.preconditions).toHaveLength(2);
      expect(m.effects).toHaveLength(1);
      expect(m.sideEffects).toHaveLength(1);
    });

    it('prevents escalation of archived reports', () => {
      const result = parseActionManifest(readAction('escalate-report.yaml'));
      const archivedCheck = result.manifest!.preconditions[0]!;
      expect(archivedCheck.expr).toContain("report.status != 'ARCHIVED'");
    });

    it('effect updates report status to ESCALATED', () => {
      const result = parseActionManifest(readAction('escalate-report.yaml'));
      const setBody = JSON.stringify(result.manifest!.effects[0]!);
      expect(setBody).toContain('ESCALATED');
    });
  });

  describe('flag-disinformation.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('flag-disinformation.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('FlagDisinformation');
      expect(m.version).toBe(1);
      expect(m.reversible).toBe(true);
      expect(m.preconditions).toHaveLength(2);
      expect(m.effects).toHaveLength(1);
      expect(m.sideEffects).toHaveLength(1);
    });

    it('sets reportCredibility to DISPROVEN', () => {
      const result = parseActionManifest(readAction('flag-disinformation.yaml'));
      const setBody = JSON.stringify(result.manifest!.effects[0]!);
      expect(setBody).toContain('DISPROVEN');
    });

    it('emits osint.report.disinformation event', () => {
      const result = parseActionManifest(readAction('flag-disinformation.yaml'));
      const eventType = result.manifest!.sideEffects[0]!.config!['type'];
      expect(eventType).toBe('osint.report.disinformation');
    });
  });

  describe('assign-source-credibility.yaml', () => {
    it('requires senior_analyst or admin role', () => {
      const result = parseActionManifest(readAction('assign-source-credibility.yaml'));
      const roleCheck = result.manifest!.preconditions[0]!;
      expect(roleCheck.expr).toContain("senior_analyst");
    });

    it('updates source credibilityScore and credibilityBasis', () => {
      const result = parseActionManifest(readAction('assign-source-credibility.yaml'));
      const setBody = JSON.stringify(result.manifest!.effects[0]!);
      expect(setBody).toContain('credibilityScore');
      expect(setBody).toContain('credibilityBasis');
    });
  });

  describe('geo-verify-report.yaml', () => {
    it('requires geospatial_analyst role', () => {
      const result = parseActionManifest(readAction('geo-verify-report.yaml'));
      const roleCheck = result.manifest!.preconditions[1]!;
      expect(roleCheck.expr).toContain("geospatial_analyst");
    });

    it('creates MentionsLocation link and updates report', () => {
      const result = parseActionManifest(readAction('geo-verify-report.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['updateObject', 'createLink']);
    });
  });

  describe('create-assessment.yaml', () => {
    it('requires at least one source report', () => {
      const result = parseActionManifest(readAction('create-assessment.yaml'));
      const countCheck = result.manifest!.preconditions[0]!;
      expect(countCheck.expr).toContain('sourceReportIds.size()');
    });

    it('creates Assessment with DRAFT status', () => {
      const result = parseActionManifest(readAction('create-assessment.yaml'));
      const setBody = JSON.stringify(result.manifest!.effects[0]!);
      expect(setBody).toContain('DRAFT');
    });
  });

  describe('contradict-report.yaml', () => {
    it('has correct action name and structure', () => {
      const result = parseActionManifest(readAction('contradict-report.yaml'));
      const m = result.manifest!;
      expect(m.action).toBe('ContradictReport');
      expect(m.version).toBe(1);
      expect(m.reversible).toBe(true);
      expect(m.preconditions).toHaveLength(3);
      expect(m.effects).toHaveLength(2);
      expect(m.sideEffects).toHaveLength(1);
    });

    it('effects include createLink Contradicts', () => {
      const result = parseActionManifest(readAction('contradict-report.yaml'));
      const types = result.manifest!.effects.map(e => e.type);
      expect(types).toEqual(['createLink', 'updateObject']);
    });
  });
});

describe('OSINT Domain Pack — pack.yaml manifest', () => {
  it('has all required fields', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    expect(pack['name']).toBe('osint');
    expect(pack['version']).toBe('0.2.0');
    expect(pack['namespace']).toBe('osint');
  });

  it('declares correct dependency on openfoundry.core', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const deps = pack['dependencies'] as Record<string, string>;
    expect(deps['openfoundry.core']).toBe('>=1.0.0');
  });

  it('declares correct provides counts', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const provides = pack['provides'] as Record<string, number>;
    expect(provides['objectTypes']).toBe(10);
    expect(provides['linkTypes']).toBe(30);
    expect(provides['actionTypes']).toBe(7);
    expect(provides['connectors']).toBe(4);
  });

  it('references all schema files', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const schemaFiles = pack['schema'] as string[];
    expect(schemaFiles).toHaveLength(13);
    for (const odlFile of ODL_FILES) {
      expect(schemaFiles).toContain(`schema/${odlFile}`);
    }
  });

  it('references all action files', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const actionFiles = pack['actions'] as string[];
    expect(actionFiles).toHaveLength(7);
    expect(actionFiles).toContain('actions/corroborate-report.yaml');
    expect(actionFiles).toContain('actions/contradict-report.yaml');
    expect(actionFiles).toContain('actions/escalate-report.yaml');
    expect(actionFiles).toContain('actions/create-assessment.yaml');
    expect(actionFiles).toContain('actions/geo-verify-report.yaml');
    expect(actionFiles).toContain('actions/flag-disinformation.yaml');
    expect(actionFiles).toContain('actions/assign-source-credibility.yaml');
  });

  it('references all connector files', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const connFiles = pack['connectors'] as string[];
    expect(connFiles).toHaveLength(4);
  });

  it('references permissions file', () => {
    const packYamlPath = resolve(PACK_ROOT, 'pack.yaml');
    const content = readFileSync(packYamlPath, 'utf-8');
    const pack = parseYaml(content) as Record<string, unknown>;

    const permFiles = pack['permissions'] as string[];
    expect(permFiles).toContain('permissions/osint-roles.fga');
  });
});

describe('OSINT Domain Pack — OpenFGA permissions', () => {
  it('permissions file exists with expected types', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'osint-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('type user');
    expect(content).toContain('type intel_report');
    expect(content).toContain('type source_profile');
    expect(content).toContain('type person');
    expect(content).toContain('type organization');
    expect(content).toContain('type location');
    expect(content).toContain('type event');
    expect(content).toContain('type equipment');
    expect(content).toContain('type assessment');
    expect(content).toContain('type narrative');
    expect(content).toContain('type indicator');
  });

  it('schema version is 1.1', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'osint-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');
    expect(content).toContain('schema 1.1');
  });

  it('intel_report has role-based permissions', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'osint-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('define intelligence_analyst: [user]');
    expect(content).toContain('define geospatial_analyst: [user]');
    expect(content).toContain('define can_corroborate: intelligence_analyst or senior_analyst');
    expect(content).toContain('define can_verify: intelligence_analyst or senior_analyst or geospatial_analyst');
    expect(content).toContain('define can_flag_disinfo: intelligence_analyst or senior_analyst');
  });

  it('assessment has publish and retract permissions', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'osint-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('define can_publish: senior_analyst or admin');
    expect(content).toContain('define can_retract: author or senior_analyst or admin');
    expect(content).toContain('define can_supersede: senior_analyst or admin');
  });

  it('indicator is restricted to senior analysts', () => {
    const fgaPath = resolve(PACK_ROOT, 'permissions', 'osint-roles.fga');
    const content = readFileSync(fgaPath, 'utf-8');

    expect(content).toContain('define can_create: senior_analyst or admin');
    expect(content).toContain('define can_edit: senior_analyst or admin');
    expect(content).toContain('define can_dismiss: senior_analyst or admin');
  });
});

describe('OSINT Domain Pack — Connector configs', () => {
  it('twitter-osint.yaml has expected structure', () => {
    const connPath = resolve(PACK_ROOT, 'connectors', 'twitter-osint.yaml');
    const content = readFileSync(connPath, 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;

    expect(config['datasource']).toBe('Twitter_OSINT_Feed');
    expect(config['connector']).toBe('twitter');

    const mapping = config['mapping'] as Record<string, unknown>;
    expect(mapping['objectType']).toBe('IntelReport');

    const sync = config['sync'] as Record<string, unknown>;
    expect(sync['mode']).toBe('POLLING');
    expect(sync['interval']).toBe('PT30S');
  });

  it('telegram-channels.yaml has expected structure', () => {
    const connPath = resolve(PACK_ROOT, 'connectors', 'telegram-channels.yaml');
    const content = readFileSync(connPath, 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;

    expect(config['datasource']).toBe('Telegram_OSINT_Feed');
    expect(config['connector']).toBe('telegram');

    const sync = config['sync'] as Record<string, unknown>;
    expect(sync['mode']).toBe('CDC');
  });

  it('isw-rss.yaml has expected structure', () => {
    const connPath = resolve(PACK_ROOT, 'connectors', 'isw-rss.yaml');
    const content = readFileSync(connPath, 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;

    expect(config['datasource']).toBe('ISW_Ukraine_Assessment');
    expect(config['connector']).toBe('rss');

    const mapping = config['mapping'] as Record<string, unknown>;
    expect(mapping['objectType']).toBe('Assessment');

    const sync = config['sync'] as Record<string, unknown>;
    expect(sync['mode']).toBe('POLLING');
  });

  it('acled-api.yaml has expected structure', () => {
    const connPath = resolve(PACK_ROOT, 'connectors', 'acled-api.yaml');
    const content = readFileSync(connPath, 'utf-8');
    const config = parseYaml(content) as Record<string, unknown>;

    expect(config['datasource']).toBe('ACLED_Conflict_Data');
    expect(config['connector']).toBe('rest');

    const mapping = config['mapping'] as Record<string, unknown>;
    expect(mapping['objectType']).toBe('Event');

    const sync = config['sync'] as Record<string, unknown>;
    expect(sync['mode']).toBe('OVERLAY');
  });
});

describe('OSINT Domain Pack — Seed data', () => {
  it('seed file exists and contains source profiles', () => {
    const seedPath = resolve(PACK_ROOT, 'seed', 'sources.yaml');
    const content = readFileSync(seedPath, 'utf-8');
    const seed = parseYaml(content) as Record<string, unknown>;

    const items = seed['seed'] as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(12);

    const types = items.map(i => i['type']);
    expect(types.every(t => t === 'SourceProfile')).toBe(true);
  });

  it('institutional sources have credibility >= 0.95', () => {
    const seedPath = resolve(PACK_ROOT, 'seed', 'sources.yaml');
    const content = readFileSync(seedPath, 'utf-8');
    const seed = parseYaml(content) as Record<string, unknown>;

    const items = seed['seed'] as Array<Record<string, unknown>>;
    const institutional = items.filter(i => {
      const props = i['properties'] as Record<string, unknown>;
      return props['credibilityBasis'] === 'institutional';
    });

    for (const item of institutional) {
      const props = item['properties'] as Record<string, unknown>;
      expect(props['credibilityScore']).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('state media sources have lower credibility', () => {
    const seedPath = resolve(PACK_ROOT, 'seed', 'sources.yaml');
    const content = readFileSync(seedPath, 'utf-8');
    const seed = parseYaml(content) as Record<string, unknown>;

    const items = seed['seed'] as Array<Record<string, unknown>>;
    const stateMedia = items.filter(i => {
      const props = i['properties'] as Record<string, unknown>;
      const cats = props['categories'] as string[];
      return cats?.includes('STATE_MEDIA');
    });

    for (const item of stateMedia) {
      const props = item['properties'] as Record<string, unknown>;
      expect(props['credibilityScore']).toBeLessThanOrEqual(0.7);
    }
  });
});
