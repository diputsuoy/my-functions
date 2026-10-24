import { Cole } from './cole.js';
import { Rina } from './rina.js';
import { Vince } from './vince.js';
import { Owen } from './owen.js';

const CLASSES = { COLE: Cole, RINA: Rina, VINCE: Vince, OWEN: Owen };

export function createAgents(cfg) {
  return Object.entries(cfg.agents)
    .filter(([name, c]) => c.enabled && CLASSES[name])
    .map(([name, c]) => new CLASSES[name](name, c, cfg));
}
