import { describe, it, expect } from 'vitest';
import { fgaDslToJson } from '../server.js';

describe('fgaDslToJson', () => {
  it('skips #-comment lines without corrupting output', () => {
    const dsl = `
model
  schema 1.1

# This is a top-level comment
type user

type document
  relations
    # Relation-level comment
    define owner: [user]
    define viewer: owner
`;
    const result = fgaDslToJson(dsl);
    expect(result.schema_version).toBe('1.1');
    expect(result.type_definitions).toHaveLength(2);

    const doc = result.type_definitions.find(
      (t: unknown) => (t as { type: string }).type === 'document',
    ) as { type: string; relations: Record<string, unknown> };
    expect(doc).toBeDefined();
    expect(doc.relations['owner']).toEqual({ this: {} });
    expect(doc.relations['viewer']).toEqual({ computedUserset: { relation: 'owner' } });
  });

  it('parses direct types, computed usersets, and tuple-to-userset', () => {
    const dsl = `
model
  schema 1.1

type user

type org
  relations
    define member: [user]
    define admin: member
    define viewer: admin from member
`;
    const result = fgaDslToJson(dsl);
    const org = result.type_definitions.find(
      (t: unknown) => (t as { type: string }).type === 'org',
    ) as { type: string; relations: Record<string, unknown> };
    expect(org.relations['member']).toEqual({ this: {} });
    expect(org.relations['admin']).toEqual({ computedUserset: { relation: 'member' } });
    expect(org.relations['viewer']).toEqual({
      tupleToUserset: {
        tupleset: { relation: 'member' },
        computedUserset: { relation: 'admin' },
      },
    });
  });

  it('parses union (or) relations', () => {
    const dsl = `
model
  schema 1.1

type user

type resource
  relations
    define owner: [user]
    define editor: [user]
    define viewer: owner or editor
`;
    const result = fgaDslToJson(dsl);
    const res = result.type_definitions.find(
      (t: unknown) => (t as { type: string }).type === 'resource',
    ) as { type: string; relations: Record<string, unknown> };
    expect(res.relations['viewer']).toEqual({
      union: {
        child: [
          { computedUserset: { relation: 'owner' } },
          { computedUserset: { relation: 'editor' } },
        ],
      },
    });
  });
});
