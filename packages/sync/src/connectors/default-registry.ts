/**
 * Default connector registry with built-in plugins pre-registered.
 */

import { ConnectorRegistry } from "./connector-registry.js";
import { jdbcPlugin } from "./jdbc-connector.js";
import { restPlugin } from "./rest-connector.js";
import { twitterPlugin } from "./twitter-connector.js";

/**
 * Create a ConnectorRegistry with all built-in connector plugins
 * already registered (jdbc, rest, twitter).
 */
export function createDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(jdbcPlugin);
  registry.register(restPlugin);
  registry.register(twitterPlugin);
  return registry;
}
