/**
 * @openfoundry/actions - Action Engine
 *
 * CEL evaluation client and action execution for the Open Foundry platform.
 */

export {
  CelClient,
  toProtobufValue,
  fromProtobufValue,
  serializeObjectVariables,
  serializeVariables,
} from './cel/index.js';

export type {
  CelClientOptions,
  CelResult,
  TypeEnv,
  TypeEntry,
  EvalRequest,
  BatchEvalRequest,
  BatchEvalResult,
  ProtobufValue,
} from './cel/index.js';
