// Plugin Loader — Discovers and loads plugins from the plugins/ directory

import { readdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createPluginContext, registerPlugin } from './manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(__dirname, '..', '..', 'plugins');

export async function loadPlugins() {
  if (!existsSync(PLUGINS_DIR)) {
    return { loaded: 0, errors: [] };
  }

  const entries = readdirSync(PLUGINS_DIR);
  const errors = [];
  let loaded = 0;

  for (const entry of entries) {
    const pluginPath = join(PLUGINS_DIR, entry);
    let stat;
    try {
      stat = statSync(pluginPath);
    } catch {
      continue;
    }

    let mainFile;
    if (stat.isFile() && entry.endsWith('.js')) {
      mainFile = pluginPath;
    } else if (stat.isDirectory()) {
      mainFile = join(pluginPath, 'index.js');
      if (!existsSync(mainFile)) continue;
    } else {
      continue;
    }

    try {
      const mod = await import(pathToFileURL(mainFile).href);
      if (typeof mod.activate !== 'function') {
        errors.push({ plugin: entry, error: 'No activate() export found' });
        continue;
      }

      const name = mod.name || entry.replace(/\.js$/, '');
      const context = createPluginContext(name);
      registerPlugin(name, {
        name,
        version: mod.version || '0.0.0',
        description: mod.description || '',
        active: true,
      });

      await mod.activate(context);
      loaded++;
      console.log(`Plugin loaded: ${name}`);
    } catch (err) {
      errors.push({ plugin: entry, error: err.message });
      console.error(`Failed to load plugin ${entry}:`, err.message);
    }
  }

  return { loaded, errors };
}
