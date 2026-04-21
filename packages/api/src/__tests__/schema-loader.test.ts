/**
 * Tests for domain pack schema loading.
 *
 * Validates that loadDomainPacks correctly:
 * - Discovers packs from the filesystem
 * - Parses ODL files and produces a merged ParsedSchema
 * - Converts to OntologySchema for the SPI layer
 * - Extracts indexes from directives
 */

import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDomainPacks } from '../schema-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAIN_PACKS_DIR = resolve(__dirname, '..', '..', '..', '..', 'domain-packs');

describe('loadDomainPacks', () => {
  it('loads core pack alone', async () => {
    const { parsed, spiSchema, packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core']);

    expect(packs).toHaveLength(1);
    expect(packs[0]!.name).toBe('core');

    // Core provides 6 custom scalars and interfaces
    expect(parsed.scalars.length).toBeGreaterThanOrEqual(6);
    expect(parsed.interfaces.length).toBeGreaterThanOrEqual(4);

    // No object types or link types from core
    expect(parsed.objectTypes).toHaveLength(0);
    expect(parsed.linkTypes).toHaveLength(0);

    // SPI schema has empty types (no concrete objects in core)
    expect(spiSchema.objectTypes).toHaveLength(0);
    expect(spiSchema.linkTypes).toHaveLength(0);
  });

  it('loads nhs-acute pack with core', async () => {
    const { parsed, spiSchema, packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);

    expect(packs).toHaveLength(2);
    expect(packs[0]!.name).toBe('core');
    expect(packs[1]!.name).toBe('nhs-acute');

    // NHS acute provides 5 object types
    expect(parsed.objectTypes).toHaveLength(5);
    const objNames = parsed.objectTypes.map(t => t.name).sort();
    expect(objNames).toEqual(['Bed', 'Consultant', 'DischargeRecord', 'Patient', 'Ward']);

    // 6 link types
    expect(parsed.linkTypes).toHaveLength(6);

    // SPI schema should have same counts
    expect(spiSchema.objectTypes).toHaveLength(5);
    expect(spiSchema.linkTypes).toHaveLength(6);
    expect(spiSchema.version).toBe(1);
  });

  it('converts object types correctly', async () => {
    const { spiSchema } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);

    const patient = spiSchema.objectTypes.find(t => t.name === 'Patient');
    expect(patient).toBeDefined();

    // 'id' field should be excluded (system column)
    const propNames = patient!.properties.map(p => p.name);
    expect(propNames).not.toContain('id');

    // nhsNumber should be present
    expect(propNames).toContain('nhsNumber');

    // Virtual @link fields should be excluded
    expect(propNames).not.toContain('currentWard');
    expect(propNames).not.toContain('currentBed');
    expect(propNames).not.toContain('admissions');
    expect(propNames).not.toContain('consultant');

    // Computed fields should be excluded
    const ward = spiSchema.objectTypes.find(t => t.name === 'Ward');
    const wardProps = ward!.properties.map(p => p.name);
    expect(wardProps).not.toContain('currentOccupancy');
  });

  it('extracts indexes from directives', async () => {
    const { spiSchema } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);

    const patient = spiSchema.objectTypes.find(t => t.name === 'Patient');
    expect(patient!.indexes).toBeDefined();

    // nhsNumber has @unique @indexed
    const nhsIdx = patient!.indexes!.find(i => i.field === 'nhsNumber' && i.unique);
    expect(nhsIdx).toBeDefined();

    // name has @searchable
    const nameIdx = patient!.indexes!.find(i => i.field === 'name' && i.indexType === 'FULLTEXT');
    expect(nameIdx).toBeDefined();

    // Consultant gmcNumber has @unique @indexed
    const consultant = spiSchema.objectTypes.find(t => t.name === 'Consultant');
    const gmcIdx = consultant!.indexes!.find(i => i.field === 'gmcNumber' && i.unique);
    expect(gmcIdx).toBeDefined();
  });

  it('converts link types correctly', async () => {
    const { spiSchema } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);

    const admittedTo = spiSchema.linkTypes.find(t => t.name === 'AdmittedTo');
    expect(admittedTo).toBeDefined();
    expect(admittedTo!.fromType).toBe('Patient');
    expect(admittedTo!.toType).toBe('Ward');
    expect(admittedTo!.cardinality).toBe('MANY_TO_ONE');
    expect(admittedTo!.properties).toBeDefined();
    expect(admittedTo!.properties!.length).toBeGreaterThanOrEqual(2);

    const occupiesBed = spiSchema.linkTypes.find(t => t.name === 'OccupiesBed');
    expect(occupiesBed!.cardinality).toBe('ONE_TO_ONE');
  });

  it('loads all packs when no names specified', async () => {
    const { parsed, packs } = await loadDomainPacks(DOMAIN_PACKS_DIR);

    // Should load core + all 3 domain packs
    expect(packs.length).toBeGreaterThanOrEqual(4);
    expect(packs[0]!.name).toBe('core'); // core always first

    // Should have types from multiple packs
    const objNames = parsed.objectTypes.map(t => t.name);
    expect(objNames).toContain('Patient');   // nhs-acute
    expect(objNames).toContain('Customer');  // aml
    expect(objNames).toContain('Product');   // supply-chain
  });

  it('ensures core is loaded first even when specified later', async () => {
    const { packs } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['nhs-acute', 'core']);
    expect(packs[0]!.name).toBe('core');
  });

  it('marks required fields correctly', async () => {
    const { spiSchema } = await loadDomainPacks(DOMAIN_PACKS_DIR, ['core', 'nhs-acute']);

    const patient = spiSchema.objectTypes.find(t => t.name === 'Patient');
    const nameField = patient!.properties.find(p => p.name === 'name');
    expect(nameField!.required).toBe(true);

    // nhsNumber is not required (no !)
    const nhsField = patient!.properties.find(p => p.name === 'nhsNumber');
    expect(nhsField!.required).toBe(false);
  });
});
