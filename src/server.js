require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const socketIo = require('socket.io');
const logger = require('./utils/logger');
const mikrotikRoutes = require('./routes/mikrotik');
const authRoutes = require('./routes/auth');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const MikrotikService = require('./services/mikrotikService');
const WebSocketManager = require('./services/websocketManager');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.CORS_ORIGIN.split(','),
    methods: ["GET", "POST"],
    credentials: true,
    transports: ['websocket', 'polling']
  },
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Middleware de seguridad
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN.split(','),
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Demasiadas solicitudes desde esta IP'
});
app.use(limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path} - ${req.ip}`);
  next();
});

// Rutas
app.use('/api/auth', authRoutes);
app.use('/api/mikrotik', mikrotikRoutes);

// Health check
app.get('/health', async (req, res) => {
  const mikrotikService = new MikrotikService();
  const mikrotikStatus = await mikrotikService.checkMikrotikConnection();
  
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      mikrotik: mikrotikStatus ? 'connected' : 'disconnected',
      websocket: io.engine.clientsCount > 0 ? 'active' : 'idle'
    }
  });
});

// Error handlers
app.use(notFound);
app.use(errorHandler);

// Inicializar WebSocket Manager
const wsManager = new WebSocketManager(io);
wsManager.initialize();

// Manejo de errores del proceso
process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled Promise Rejection: ${err.message}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  // Limpiar recursos antes de salir
  wsManager.cleanup();
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM recibido, cerrando servidor...');
  wsManager.cleanup();
  server.close(() => {
    logger.info('Servidor cerrado correctamente');
    process.exit(0);
  });
});

// Verificar variables de entorno
function checkEnvironmentVariables() {
  const required = ['JWT_SECRET', 'MIKROTIK_HOST', 'MIKROTIK_USER', 'MIKROTIK_PASSWORD'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    logger.error(`Variables de entorno faltantes: ${missing.join(', ')}`);
    process.exit(1);
  }
}

checkEnvironmentVariables();

// Iniciar servidor
const PORT = process.env.PORT || 5001;
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Servidor iniciado en puerto ${PORT}`);
  logger.info(`Conectando a MikroTik en ${process.env.MIKROTIK_HOST}:${process.env.MIKROTIK_PORT || 8728}`);
  
  // Verificar conexión inicial con MikroTik
  setTimeout(async () => {
    const mikrotikService = new MikrotikService();
    try {
      await mikrotikService.connect();
      logger.info('Conexión inicial a MikroTik exitosa');
    } catch (error) {
      logger.error(`No se pudo conectar inicialmente a MikroTik: ${error.message}`);
    }
  }, 2000);
});