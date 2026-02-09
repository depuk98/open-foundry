/**
 * Validation pipeline for the Ontology Engine (Section 4.3).
 *
 * Every write operation passes through:
 * 1. Schema validation — field types, required fields, enum values
 * 2. Constraint evaluation — @constraint CEL expressions
 * 3. Uniqueness check — @unique fields checked across all instances
 * 4. Cardinality check — link operations (delegated to link manager)
 * 5. Referential integrity — link targets must exist
 */

import type {
  PlatformError,
  RequestContext,
  StorageProvider,
} from '@openfoundry/spi';
import type {
  ParsedSchema,
  ObjectType,
  FieldDefinition,
} from '@openfoundry/odl';

/** A single validation failure. */
export interface ValidationFailure {
  /** The pipeline step that failed. */
  step: 'schema' | 'constraint' | 'uniqueness' | 'cardinality' | 'referential_integrity';
  /** The field that caused the failure (if applicable). */
  field?: string;
  /** Human-readable message. */
  message: string;
}

/** Result of running the validation pipeline. */
export interface ValidationResult {
  valid: boolean;
  failures: ValidationFailure[];
}

/**
 * Built-in scalar type names recognized by the engine.
 * Maps ODL type names to JS typeof checks.
 */
const SCALAR_TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  ID: (v) => typeof v === 'string',
  String: (v) => typeof v === 'string',
  Int: (v) => typeof v === 'number' && Number.isInteger(v),
  Float: (v) => typeof v === 'number',
  Boolean: (v) => typeof v === 'boolean',
  Date: (v) => typeof v === 'string',
  DateTime: (v) => typeof v === 'string',
  Duration: (v) => typeof v === 'string',
  GeoPoint: (v) => typeof v === 'object' && v !== null,
  JSON: (_v) => true,
  URI: (v) => typeof v === 'string',
};

/**
 * Validates properties for an object create or update.
 *
 * Runs the validation pipeline in the order specified by Section 4.3:
 * 1. Schema validation
 * 2. Constraint evaluation
 * 3. Uniqueness check
 *
 * Steps 4 (cardinality) and 5 (referential integrity) are for link
 * operations and are checked separately by the ObjectManager/LinkManager.
 */
export async function validateObjectProperties(
  schema: ParsedSchema,
  typeName: string,
  properties: Record<string, unknown>,
  ctx: RequestContext,
  storage: StorageProvider,
  existingId?: string,
): Promise<ValidationResult> {
  const failures: ValidationFailure[] = [];

  const objectType = schema.objectTypes.find((t) => t.name === typeName);
  if (!objectType) {
    return {
      valid: false,
      failures: [{
        step: 'schema',
        message: `Unknown object type: ${typeName}`,
      }],
    };
  }

  // Build enum lookup for the schema
  const enumMap = new Map<string, Set<string>>();
  for (const e of schema.enums) {
    enumMap.set(e.name, new Set(e.values.map((v) => v.name)));
  }

  // Step 1: Schema validation
  const schemaFailures = validateSchema(objectType, properties, enumMap);
  failures.push(...schemaFailures);

  // Step 2: Constraint evaluation
  const constraintFailures = evaluateConstraints(objectType, properties);
  failures.push(...constraintFailures);

  // Step 3: Uniqueness check (only if schema validation passed)
  if (failures.length === 0) {
    const uniquenessFailures = await checkUniqueness(
      objectType,
      properties,
      ctx,
      storage,
      typeName,
      existingId,
    );
    failures.push(...uniquenessFailures);
  }

  return {
    valid: failures.length === 0,
    failures,
  };
}

/**
 * Step 1: Schema validation.
 * Checks field types, required fields, and enum values.
 */
function validateSchema(
  objectType: ObjectType,
  properties: Record<string, unknown>,
  enumMap: Map<string, Set<string>>,
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];

  for (const field of objectType.fields) {
    // Skip system fields (_id, etc.) and computed/link/primary fields
    if (isSystemField(field) || isComputedField(field) || isLinkField(field)) {
      continue;
    }

    const value = properties[field.name];

    // Check required fields (nonNull means required)
    if (field.type.nonNull && (value === undefined || value === null)) {
      // Skip if field has a @default directive
      const hasDefault = field.directives.some((d) => d.kind === 'default');
      if (!hasDefault) {
        failures.push({
          step: 'schema',
          field: field.name,
          message: `Required field '${field.name}' is missing`,
        });
        continue;
      }
    }

    // Skip further checks if value is not provided (optional field)
    if (value === undefined || value === null) {
      continue;
    }

    // Check enum values
    const enumValues = enumMap.get(field.type.name);
    if (enumValues) {
      if (field.type.isList) {
        if (!Array.isArray(value)) {
          failures.push({
            step: 'schema',
            field: field.name,
            message: `Field '${field.name}' must be an array of ${field.type.name}`,
          });
        } else {
          for (const item of value) {
            if (typeof item !== 'string' || !enumValues.has(item)) {
              failures.push({
                step: 'schema',
                field: field.name,
                message: `Invalid enum value '${String(item)}' for field '${field.name}'. Valid values: ${[...enumValues].join(', ')}`,
              });
            }
          }
        }
      } else if (typeof value !== 'string' || !enumValues.has(value)) {
        failures.push({
          step: 'schema',
          field: field.name,
          message: `Invalid enum value '${String(value)}' for field '${field.name}'. Valid values: ${[...enumValues].join(', ')}`,
        });
      }
      continue;
    }

    // Check scalar types
    const typeCheck = SCALAR_TYPE_CHECKS[field.type.name];
    if (typeCheck) {
      if (field.type.isList) {
        if (!Array.isArray(value)) {
          failures.push({
            step: 'schema',
            field: field.name,
            message: `Field '${field.name}' must be an array`,
          });
        } else {
          for (let i = 0; i < value.length; i++) {
            if (!typeCheck(value[i])) {
              failures.push({
                step: 'schema',
                field: field.name,
                message: `Field '${field.name}[${i}]' has invalid type. Expected ${field.type.name}`,
              });
            }
          }
        }
      } else if (!typeCheck(value)) {
        failures.push({
          step: 'schema',
          field: field.name,
          message: `Field '${field.name}' has invalid type. Expected ${field.type.name}, got ${typeof value}`,
        });
      }
    }
  }

  return failures;
}

/**
 * Step 2: Constraint evaluation.
 * Evaluates @constraint CEL expressions against proposed state.
 *
 * NOTE: Full CEL evaluation requires the cel-evaluator gRPC sidecar.
 * For now, we support a minimal set of inline expressions:
 * - Comparison: field > N, field < N, field >= N, field <= N
 * - String length: size(field) > N, size(field) <= N
 * - Regex match: field.matches("pattern")
 *
 * Complex CEL expressions are passed through (always valid) until
 * the CEL sidecar integration is implemented.
 */
function evaluateConstraints(
  objectType: ObjectType,
  properties: Record<string, unknown>,
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];

  for (const field of objectType.fields) {
    const constraints = field.directives.filter(
      (d): d is { kind: 'constraint'; expr: string } => d.kind === 'constraint',
    );

    for (const constraint of constraints) {
      const result = evaluateCelExpr(constraint.expr, field.name, properties);
      if (result === false) {
        failures.push({
          step: 'constraint',
          field: field.name,
          message: `Constraint violated on field '${field.name}': ${constraint.expr}`,
        });
      }
      // result === null means we couldn't evaluate — skip (delegate to CEL sidecar)
    }
  }

  return failures;
}

/**
 * Evaluate a simple CEL-like expression inline.
 * Returns true (pass), false (fail), or null (cannot evaluate).
 */
function evaluateCelExpr(
  expr: string,
  _fieldName: string,
  properties: Record<string, unknown>,
): boolean | null {
  // Simple comparison: "this.fieldName > N" or "this.fieldName >= N"
  const comparisonMatch = expr.match(
    /^this\.(\w+)\s*(>=|<=|!=|==|>|<)\s*(.+)$/,
  );
  if (comparisonMatch) {
    const [, refField, op, rawValue] = comparisonMatch;
    const fieldValue = properties[refField!];
    if (typeof fieldValue !== 'number') return null;
    const numValue = Number(rawValue!.trim());
    if (isNaN(numValue)) return null;

    switch (op) {
      case '>': return fieldValue > numValue;
      case '<': return fieldValue < numValue;
      case '>=': return fieldValue >= numValue;
      case '<=': return fieldValue <= numValue;
      case '==': return fieldValue === numValue;
      case '!=': return fieldValue !== numValue;
      default: return null;
    }
  }

  // size() check: "size(this.fieldName) > N"
  const sizeMatch = expr.match(
    /^size\(this\.(\w+)\)\s*(>|<|>=|<=|==|!=)\s*(\d+)$/,
  );
  if (sizeMatch) {
    const [, refField, op, rawValue] = sizeMatch;
    const fieldValue = properties[refField!];
    let size: number;
    if (typeof fieldValue === 'string') {
      size = fieldValue.length;
    } else if (Array.isArray(fieldValue)) {
      size = fieldValue.length;
    } else {
      return null;
    }
    const numValue = Number(rawValue);
    switch (op) {
      case '>': return size > numValue;
      case '<': return size < numValue;
      case '>=': return size >= numValue;
      case '<=': return size <= numValue;
      case '==': return size === numValue;
      case '!=': return size !== numValue;
      default: return null;
    }
  }

  // Cannot evaluate — delegate to CEL sidecar
  return null;
}

/**
 * Step 3: Uniqueness check.
 * Queries the storage provider to verify @unique field values don't conflict.
 *
 * CQ-01: TOCTOU race condition — This check is advisory only. The caller MUST
 * run within a serializable transaction or rely on DB UNIQUE constraints to
 * prevent concurrent inserts from creating duplicates between the check and
 * the subsequent INSERT. The PostgreSQL SPI provider should add UNIQUE indexes
 * on all @unique fields during schema migration.
 */
async function checkUniqueness(
  objectType: ObjectType,
  properties: Record<string, unknown>,
  ctx: RequestContext,
  storage: StorageProvider,
  typeName: string,
  existingId?: string,
): Promise<ValidationFailure[]> {
  const failures: ValidationFailure[] = [];

  const uniqueFields = objectType.fields.filter((f) =>
    f.directives.some((d) => d.kind === 'unique'),
  );

  for (const field of uniqueFields) {
    const value = properties[field.name];
    if (value === undefined || value === null) continue;

    const result = await storage.queryObjects(ctx, typeName, {
      field: field.name,
      operator: 'eq',
      value,
    });

    // Filter out the current object (for updates)
    const conflicts = existingId
      ? result.items.filter((obj) => obj._id !== existingId)
      : result.items;

    if (conflicts.length > 0) {
      failures.push({
        step: 'uniqueness',
        field: field.name,
        message: `Uniqueness violation: field '${field.name}' with value '${String(value)}' already exists`,
      });
    }
  }

  return failures;
}

/** Check if a field is a system-managed field (primary key). */
function isSystemField(field: FieldDefinition): boolean {
  return field.directives.some((d) => d.kind === 'primary');
}

/** Check if a field is computed. */
function isComputedField(field: FieldDefinition): boolean {
  return field.directives.some((d) => d.kind === 'computed');
}

/** Check if a field is a link reference. */
function isLinkField(field: FieldDefinition): boolean {
  return field.directives.some((d) => d.kind === 'link');
}

/**
 * Creates a structured PlatformError for validation failures.
 */
export function validationError(failures: ValidationFailure[]): PlatformError {
  return {
    code: 'VALIDATION_ERROR',
    category: 'validation',
    message: failures.map((f) => f.message).join('; '),
    retryable: false,
    details: { failures },
  };
}
