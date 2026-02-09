// Objects
export {
  ObjectManager,
  type ObjectManagerConfig,
  validateObjectProperties,
  validationError,
  type ValidationFailure,
  type ValidationResult,
} from './objects/index.js';

// Links
export {
  LinkManager,
  type LinkManagerConfig,
  generateUUIDv7,
} from './links/index.js';

// Events
export {
  type EventBus,
  InMemoryEventBus,
  EngineEventEmitter,
  type EventCause,
  type ChangeSet,
  type ObjectEventData,
  type LinkEventData,
} from './events/index.js';
