/**
 * @openfoundry/odl - Ontology Definition Language parser, validator, and codegen.
 *
 * Parses GraphQL SDL files extended with Open Foundry directives
 * into a structured ParsedSchema AST, validates structural correctness,
 * and generates GraphQL API schemas per the Open Foundry spec.
 */

export { parseOdl } from './parser/index.js';
export { validateSchema } from './validator/index.js';
export { generateGraphQLSchema } from './codegen/index.js';

export type {
  ValidationResult,
  ValidationIssue,
  ValidationSeverity,
} from './validator/types.js';

export type {
  ParsedSchema,
  NamespaceMetadata,
  ObjectType,
  LinkType,
  ActionType,
  EnumDefinition,
  EnumValue,
  InterfaceDefinition,
  ScalarDefinition,
  FieldDefinition,
  FieldTypeRef,
  FieldDirective,
  TypeDirective,
  DirectiveArgValue,
  Cardinality,
  Direction,
  CacheStrategy,
  PrimaryDirective,
  UniqueDirective,
  IndexedDirective,
  ReadonlyDirective,
  SensitiveDirective,
  ParamDirective,
  LinkDirective,
  ComputedDirective,
  ConstraintDirective,
  DefaultDirective,
  DeprecatedDirective,
  TerminologyDirective,
  SearchableDirective,
  ObjectTypeDirective,
  LinkTypeDirective,
  ActionTypeDirective,
  FunctionDirective,
} from './parser/types.js';
