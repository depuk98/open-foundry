// Objects
export {
  ObjectManager,
  type ObjectManagerConfig,
  validateObjectProperties,
  validationError,
  type ValidationFailure,
  type ValidationResult,
} from './objects/index.js';

// Events
export {
  type EventBus,
  InMemoryEventBus,
  EngineEventEmitter,
  type EventCause,
  type ChangeSet,
  type ObjectEventData,
} from './events/index.js';
