/**
 * Default connector registry with built-in plugins pre-registered.
 */

import { ConnectorRegistry } from "./connector-registry.js";
import { jdbcPlugin } from "./jdbc-connector.js";

/**
 * Create a ConnectorRegistry with all built-in connector plugins
 * already registered (currently: jdbc).
 */
export function createDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(jdbcPlugin);
  return registry;
}
