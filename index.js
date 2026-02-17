import { rocketchatPlugin } from './src/channel.js';
import { setRuntime } from './src/runtime.js';

const plugin = {
  id: 'rocketchat',
  name: 'Rocket.Chat',
  description: 'Rocket.Chat channel plugin for OpenClaw',
  configSchema: { type: 'object', additionalProperties: true, properties: {} },
  register(api) {
    setRuntime(api.runtime);
    api.registerChannel({ plugin: rocketchatPlugin });
  },
};

export default plugin;
