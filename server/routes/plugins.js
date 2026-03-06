import { Router } from 'express';
import { getRegisteredPlugins, getPluginCapabilities } from '../plugins/manager.js';

const router = Router();

// GET /plugins — list all loaded plugins
router.get('/plugins', (req, res) => {
  res.json(getRegisteredPlugins());
});

// GET /plugins/capabilities — list all registered hooks, tools, parsers, validators
router.get('/plugins/capabilities', (req, res) => {
  res.json(getPluginCapabilities());
});

export default router;
