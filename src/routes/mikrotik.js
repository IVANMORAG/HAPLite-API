const express = require('express');
const { body, param, validationResult } = require('express-validator');
const MikrotikService = require('../services/mikrotikService');
const { auth } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();
const mikrotikService = new MikrotikService();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      errors: errors.array()
    });
  }
  next();
};

router.get('/users', auth, async (req, res) => {
  try {
    logger.info('Solicitud recibida para obtener usuarios conectados');
    const users = await mikrotikService.getConnectedUsers();
    res.json({
      success: true,
      data: users,
      count: users.length
    });
  } catch (error) {
    logger.error(`Error obteniendo usuarios conectados: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo usuarios conectados',
      error: error.message
    });
  }
});

router.get('/bandwidth', auth, async (req, res) => {
  try {
    logger.info('Solicitud recibida para obtener ancho de banda');
    const bandwidthData = await mikrotikService.getBandwidthUsage();
    res.json({
      success: true,
      data: bandwidthData || []
    });
  } catch (error) {
    logger.error(`Error obteniendo ancho de banda: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo datos de ancho de banda',
      error: error.message
    });
  }
});

// ENDPOINT FALTANTE - bandwidth-history
router.get('/bandwidth-history', auth, async (req, res) => {
  try {
    logger.info('Solicitud recibida para obtener historial de ancho de banda');
    const minutes = parseInt(req.query.minutes) || 5; // Por defecto últimos 5 minutos
    const history = await mikrotikService.getBandwidthHistory(minutes);
    
    res.json({
      success: true,
      data: history || [],
      count: history.length
    });
  } catch (error) {
    logger.error(`Error obteniendo historial de ancho de banda: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo historial de ancho de banda',
      error: error.message,
      data: [] // Enviar array vacío en caso de error
    });
  }
});

router.post('/speed-limit',
  auth,
  [
    body('ip').isIP().withMessage('IP inválida'),
    body('rxLimit').isInt({ min: 1 }).withMessage('Límite RX debe ser mayor a 0'),
    body('txLimit').isInt({ min: 1 }).withMessage('Límite TX debe ser mayor a 0')
  ],
  validate,
  async (req, res) => {
    try {
      const { ip, rxLimit, txLimit } = req.body;
      const result = await mikrotikService.setSpeedLimit(ip, rxLimit, txLimit);
      res.json({
        success: true,
        message: result.message
      });
    } catch (error) {
      logger.error(`Error estableciendo límite de velocidad: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error estableciendo límite de velocidad',
        error: error.message
      });
    }
  }
);

router.delete('/speed-limit/:ip',
  auth,
  [
    param('ip').isIP().withMessage('IP inválida')
  ],
  validate,
  async (req, res) => {
    try {
      const { ip } = req.params;
      const result = await mikrotikService.removeSpeedLimit(ip);
      res.json({
        success: true,
        message: result.message
      });
    } catch (error) {
      logger.error(`Error removiendo límite de velocidad: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error removiendo límite de velocidad',
        error: error.message
      });
    }
  }
);

router.post('/kick-user',
  auth,
  [
    body('ip').isIP().withMessage('IP inválida'),
    body('duration').optional().isInt({ min: 60, max: 3600 }).withMessage('Duración debe estar entre 60 y 3600 segundos')
  ],
  validate,
  async (req, res) => {
    try {
      const { ip, duration = 300 } = req.body;
      const result = await mikrotikService.kickUser(ip, duration);
      res.json({
        success: true,
        message: result.message
      });
    } catch (error) {
      logger.error(`Error expulsando usuario: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error expulsando usuario',
        error: error.message
      });
    }
  }
);

router.post('/unblock-user',
  auth,
  [
    body('ip').isIP().withMessage('IP inválida')
  ],
  validate,
  async (req, res) => {
    try {
      const { ip } = req.body;
      const result = await mikrotikService.unblockUser(ip);
      res.json({
        success: true,
        message: result.message
      });
    } catch (error) {
      logger.error(`Error desbloqueando usuario: ${error.message}`);
      res.status(500).json({
        success: false,
        message: 'Error desbloqueando usuario',
        error: error.message
      });
    }
  }
);

router.get('/queues', auth, async (req, res) => {
  try {
    const queues = await mikrotikService.getActiveQueues();
    res.json({
      success: true,
      data: queues,
      count: queues.length
    });
  } catch (error) {
    logger.error(`Error obteniendo queues: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo reglas de queue',
      error: error.message
    });
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    await mikrotikService.connect();
    res.json({
      success: true,
      message: 'Conexión con MikroTik exitosa',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Error verificando conexión: ${error.message}`);
    res.status(500).json({
      success: false,
      message: 'Error conectando con MikroTik',
      error: error.message
    });
  }
});

module.exports = router;