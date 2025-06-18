const MikrotikService = require('./mikrotikService');
const logger = require('../utils/logger');

class WebSocketManager {
  constructor(io) {
    this.io = io;
    this.mikrotikService = new MikrotikService();
    this.intervals = new Map();
    this.clientSettings = new Map();
    this.connectionRetryAttempts = 0;
    this.maxRetryAttempts = 5;
  }

  initialize() {
    this.io.on('connection', (socket) => {
      logger.info(`Cliente conectado: ${socket.id}`);
      
      // Enviar estado inicial
      this.sendInitialData(socket);
      
      // Manejar suscripciones
      socket.on('subscribe-bandwidth', (options = {}) => {
        this.handleBandwidthSubscription(socket, options);
      });
      
      socket.on('subscribe-users', (options = {}) => {
        this.handleUsersSubscription(socket, options);
      });
      
      socket.on('update-interval', (data) => {
        this.updateClientInterval(socket, data);
      });
      
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
      
      // Eventos adicionales
      socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
      });
    });
  }

  async sendInitialData(socket) {
    try {
      // Enviar datos iniciales de ancho de banda
      const bandwidthData = await this.mikrotikService.getBandwidthUsage();
      if (bandwidthData) {
        socket.emit('bandwidth-data', {
          data: bandwidthData,
          timestamp: new Date().toISOString()
        });
      }
      
      // Enviar usuarios conectados
      const users = await this.mikrotikService.getConnectedUsers();
      socket.emit('users-data', {
        data: users,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error(`Error enviando datos iniciales: ${error.message}`);
      socket.emit('error', {
        type: 'initial-data',
        message: 'Error obteniendo datos iniciales'
      });
    }
  }

  handleBandwidthSubscription(socket, options) {
    const { 
      interval = 2000, // Por defecto 2 segundos para tiempo real
      interfaces = ['ether1', 'wlan1', 'bridge']
    } = options;
    
    logger.info(`Cliente ${socket.id} suscrito a ancho de banda (intervalo: ${interval}ms)`);
    
    // Limpiar intervalo existente si hay uno
    this.clearClientInterval(socket.id, 'bandwidth');
    
    // Guardar configuración del cliente
    this.clientSettings.set(socket.id, { interval, interfaces });
    
    // Enviar datos inmediatamente al suscribirse
    this.sendBandwidthData(socket, interfaces);
    
    // Crear nuevo intervalo
    const intervalId = setInterval(async () => {
      await this.sendBandwidthData(socket, interfaces);
    }, interval);
    
    // Guardar referencia del intervalo
    if (!this.intervals.has(socket.id)) {
      this.intervals.set(socket.id, new Map());
    }
    this.intervals.get(socket.id).set('bandwidth', intervalId);
  }

  async sendBandwidthData(socket, interfaces) {
    try {
      const bandwidthData = await this.mikrotikService.getBandwidthUsage();
      
      if (bandwidthData && bandwidthData.length > 0) {
        // Si no se especifican interfaces, enviar todas
        const filteredData = interfaces.length > 0 
          ? bandwidthData.filter(item => interfaces.includes(item.interface))
          : bandwidthData;
        
        logger.info(`Enviando ${filteredData.length} items de ancho de banda al cliente ${socket.id}`);
        
        socket.emit('bandwidth-data', {
          data: filteredData,
          timestamp: new Date().toISOString(),
          interval: 2000
        });
        
        // Reset contador de reintentos en caso de éxito
        this.connectionRetryAttempts = 0;
      } else {
        logger.warn(`No hay datos de ancho de banda para enviar al cliente ${socket.id}`);
        socket.emit('bandwidth-data', {
          data: [],
          timestamp: new Date().toISOString(),
          interval: 2000
        });
      }
    } catch (error) {
      logger.error(`Error obteniendo ancho de banda: ${error.message}`);
      
      // Manejar reconexión
      if (this.connectionRetryAttempts < this.maxRetryAttempts) {
        this.connectionRetryAttempts++;
        socket.emit('warning', {
          type: 'connection',
          message: `Reintentando conexión (${this.connectionRetryAttempts}/${this.maxRetryAttempts})`
        });
      } else {
        socket.emit('error', {
          type: 'bandwidth',
          message: 'Error persistente obteniendo datos de ancho de banda'
        });
        this.clearClientInterval(socket.id, 'bandwidth');
      }
    }
  }

  handleUsersSubscription(socket, options) {
    const { interval = 5000 } = options; // Actualizar usuarios cada 5 segundos
    
    logger.info(`Cliente ${socket.id} suscrito a usuarios (intervalo: ${interval}ms)`);
    
    this.clearClientInterval(socket.id, 'users');
    
    const intervalId = setInterval(async () => {
      try {
        const users = await this.mikrotikService.getConnectedUsers();
        socket.emit('users-data', {
          data: users,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error(`Error obteniendo usuarios: ${error.message}`);
        socket.emit('error', {
          type: 'users',
          message: 'Error obteniendo usuarios conectados'
        });
      }
    }, interval);
    
    if (!this.intervals.has(socket.id)) {
      this.intervals.set(socket.id, new Map());
    }
    this.intervals.get(socket.id).set('users', intervalId);
  }

  updateClientInterval(socket, data) {
    const { type, interval } = data;
    
    if (!['bandwidth', 'users'].includes(type)) {
      socket.emit('error', {
        type: 'invalid-subscription',
        message: 'Tipo de suscripción inválido'
      });
      return;
    }
    
    logger.info(`Actualizando intervalo de ${type} para cliente ${socket.id} a ${interval}ms`);
    
    // Reiniciar suscripción con nuevo intervalo
    if (type === 'bandwidth') {
      const settings = this.clientSettings.get(socket.id) || {};
      this.handleBandwidthSubscription(socket, { ...settings, interval });
    } else if (type === 'users') {
      this.handleUsersSubscription(socket, { interval });
    }
  }

  clearClientInterval(socketId, type) {
    const clientIntervals = this.intervals.get(socketId);
    if (clientIntervals && clientIntervals.has(type)) {
      clearInterval(clientIntervals.get(type));
      clientIntervals.delete(type);
      logger.debug(`Intervalo ${type} limpiado para cliente ${socketId}`);
    }
  }

  handleDisconnect(socket) {
    logger.info(`Cliente desconectado: ${socket.id}`);
    
    // Limpiar todos los intervalos del cliente
    const clientIntervals = this.intervals.get(socket.id);
    if (clientIntervals) {
      clientIntervals.forEach((interval, type) => {
        clearInterval(interval);
        logger.debug(`Intervalo ${type} limpiado para cliente ${socket.id}`);
      });
      this.intervals.delete(socket.id);
    }
    
    // Limpiar configuraciones del cliente
    this.clientSettings.delete(socket.id);
  }

  // Broadcast a todos los clientes
  broadcastBandwidthAlert(data) {
    this.io.emit('bandwidth-alert', {
      data,
      timestamp: new Date().toISOString(),
      type: 'high-usage'
    });
  }

  // Enviar notificación a cliente específico
  notifyClient(socketId, notification) {
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('notification', notification);
    }
  }

  // Limpiar todos los recursos
  cleanup() {
    logger.info('Limpiando recursos de WebSocket Manager');
    
    // Limpiar todos los intervalos
    this.intervals.forEach((clientIntervals, socketId) => {
      clientIntervals.forEach((interval) => {
        clearInterval(interval);
      });
    });
    
    this.intervals.clear();
    this.clientSettings.clear();
    
    // Desconectar MikroTik
    this.mikrotikService.disconnect();
  }

  // Obtener estadísticas
  getStats() {
    return {
      connectedClients: this.io.engine.clientsCount,
      activeSubscriptions: this.intervals.size,
      subscriptionDetails: Array.from(this.intervals.entries()).map(([socketId, intervals]) => ({
        socketId,
        subscriptions: Array.from(intervals.keys())
      }))
    };
  }
}

module.exports = WebSocketManager;