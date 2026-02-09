/**
 * @openfoundry/odl - Ontology Definition Language parser.
 *
 * Parses GraphQL SDL files extended with Open Foundry directives
 * into a structured ParsedSchema AST.
 */

export { parseOdl } from './parser/index.js';

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
