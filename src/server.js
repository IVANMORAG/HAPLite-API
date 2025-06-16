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
  pingTimeout: 30000,
  pingInterval: 25000,
  connectionStateRecovery: true
});

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN.split(','),
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Demasiadas solicitudes desde esta IP'
});
app.use(limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path} - ${req.ip}`);
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/mikrotik', mikrotikRoutes);

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.use(notFound);
app.use(errorHandler);

const mikrotikService = new MikrotikService();

let bandwidthInterval = null;
let connectedClients = new Set();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token) {
    next();
  } else {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  logger.info(`Cliente conectado: ${socket.id}`);
  connectedClients.add(socket.id);

  socket.on('subscribe-bandwidth', async () => {
    if (socket.data.isSubscribed) {
      logger.debug(`Cliente ${socket.id} ya está suscrito, ignorando`);
      return;
    }
    socket.data.isSubscribed = true;
    logger.info(`Cliente ${socket.id} suscrito a datos de ancho de banda`);

    if (!bandwidthInterval && connectedClients.size > 0) {
      const sendBandwidth = async () => {
        try {
          const bandwidthData = await mikrotikService.getBandwidthUsage();
          if (bandwidthData) {
            io.emit('bandwidth-data', bandwidthData);
          }
        } catch (error) {
          logger.error(`Error enviando datos de ancho de banda: ${error.message}`);
        }
      };

      await sendBandwidth();
      bandwidthInterval = setInterval(sendBandwidth, 15000);
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Cliente desconectado: ${socket.id}`);
    connectedClients.delete(socket.id);
    socket.data.isSubscribed = false;

    if (connectedClients.size === 0 && bandwidthInterval) {
      clearInterval(bandwidthInterval);
      bandwidthInterval = null;
      logger.info('Intervalo de ancho de banda detenido');
    }
  });

  socket.on('error', (err) => {
    logger.error(`Error en socket ${socket.id}: ${err.message}`);
  });
});

process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled Promise Rejection: ${err.message}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});

function checkEnvironmentVariables() {
  const required = ['JWT_SECRET', 'MIKROTIK_HOST', 'MIKROTIK_USER', 'MIKROTIK_PASSWORD', 'CORS_ORIGIN'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    logger.error(`Variables de entorno faltantes: ${missing.join(', ')}`);
    process.exit(1);
  }
}

checkEnvironmentVariables();

const PORT = process.env.PORT || 5001;

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Servidor iniciado en puerto ${PORT}`);
  logger.info(`Conectando a MikroTik en ${process.env.MIKROTIK_HOST}:${process.env.MIKROTIK_PORT || 8728}`);
  
  setTimeout(async () => {
    try {
      const isConnected = await mikrotikService.checkMikrotikConnection();
      if (isConnected) {
        logger.info('Conexión inicial a MikroTik exitosa');
      } else {
        logger.error('No se pudo verificar la conexión inicial a MikroTik');
      }
    } catch (error) {
      logger.error(`No se pudo conectar inicialmente a MikroTik: ${error.message}`);
    }
  }, 2000);
});