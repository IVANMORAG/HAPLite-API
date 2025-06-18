const { RouterOSAPI } = require('node-routeros');
const logger = require('../utils/logger');

class MikrotikService {
  constructor() {
    this.conn = null;
    this.config = {
      host: process.env.MIKROTIK_HOST,
      user: process.env.MIKROTIK_USER,
      password: process.env.MIKROTIK_PASSWORD,
      port: parseInt(process.env.MIKROTIK_PORT) || 8728,
      timeout: 10000
    };
    this.bandwidthHistory = [];
    this.bandwidthCache = null;
    this.cacheTimeout = 1000; // 1 segundo de cache
    this.lastCacheTime = 0;
  }

  async connect() {
    try {
      if (this.conn && this.conn.connected) {
        logger.debug('Usando conexión existente a MikroTik');
        return this.conn;
      }

      if (!this.config.host || !this.config.user || !this.config.password) {
        throw new Error('Configuración de MikroTik incompleta');
      }

      logger.info(`Conectando a MikroTik: ${this.config.host}:${this.config.port}`);
      
      this.conn = new RouterOSAPI(this.config);
      await this.conn.connect();
      
      logger.info('Conexión exitosa a MikroTik');
      return this.conn;
    } catch (error) {
      logger.error(`Error de conexión: ${error.message}`);
      this.conn = null;
      throw new Error(`Error conectando a MikroTik: ${error.message}`);
    }
  }

  async disconnect() {
    if (this.conn && this.conn.connected) {
      await this.conn.close();
      this.conn = null;
      logger.info('Desconectado de MikroTik');
    }
  }

  async retryOperation(operation, maxAttempts = 3, delay = 1000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        logger.warn(`Intento ${attempt} fallido: ${error.message}`);
        if (attempt === maxAttempts) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
        // Reconectar en el último intento
        if (attempt === maxAttempts - 1) {
          this.conn = null;
          await this.connect();
        }
      }
    }
  }

  async getConnectedUsers() {
    try {
      logger.debug('Obteniendo usuarios conectados');
      const conn = await this.connect();

      const [arpEntries, dhcpLeases, queues] = await Promise.all([
        this.retryOperation(() => conn.write('/ip/arp/print')),
        this.retryOperation(() => conn.write('/ip/dhcp-server/lease/print')),
        this.retryOperation(() => conn.write('/queue/simple/print'))
      ]);

      // Crear mapa de límites de velocidad
      const speedLimits = {};
      queues.forEach(queue => {
        const target = queue.target?.split('/')[0];
        if (target) {
          speedLimits[target] = {
            maxLimit: queue['max-limit'],
            bytesIn: parseInt(queue.bytes) || 0,
            bytesOut: parseInt(queue['bytes-out']) || 0
          };
        }
      });

      const users = arpEntries.map(arp => {
        const lease = dhcpLeases.find(l => l['mac-address'] === arp['mac-address']);
        const speedLimit = speedLimits[arp.address];
        
        return {
          id: arp['.id'],
          ip: arp.address,
          mac: arp['mac-address'],
          interface: arp.interface,
          hostname: lease ? lease['host-name'] || arp['mac-address'] : arp['mac-address'],
          status: arp.dynamic === 'true' ? 'Activo' : 'Estático',
          lastSeen: arp['last-seen'] || 'N/A',
          speedLimit: speedLimit ? speedLimit.maxLimit : 'Sin límite',
          bandwidth: speedLimit ? {
            bytesIn: speedLimit.bytesIn,
            bytesOut: speedLimit.bytesOut
          } : null
        };
      });
      
      logger.debug(`Usuarios encontrados: ${users.length}`);
      return users;
    } catch (error) {
      logger.error(`Error obteniendo usuarios: ${error.message}`);
      throw new Error(`Error al obtener usuarios: ${error.message}`);
    }
  }

  async getBandwidthUsage() {
    try {
      // Implementar cache para reducir carga en MikroTik
      const now = Date.now();
      if (this.bandwidthCache && (now - this.lastCacheTime) < this.cacheTimeout) {
        logger.debug('Devolviendo datos de cache');
        return this.bandwidthCache;
      }

      logger.debug('Obteniendo uso de ancho de banda');
      const conn = await this.connect();
      
      // Obtener interfaces activas dinámicamente
      const interfaces = await this.retryOperation(() => 
        conn.write('/interface/print')
      );
      
      logger.debug(`Interfaces encontradas: ${interfaces.length}`);
      
      const bandwidthData = [];
      const timestamp = new Date().toISOString();
      
      // En HAP Lite, las interfaces pueden ser diferentes
      // Buscar interfaces activas y relevantes
      const activeInterfaces = interfaces.filter(i => 
        i.running === 'true' && 
        (i.type === 'ether' || i.type === 'wlan' || i.name === 'bridge' || i.name.includes('ether') || i.name.includes('wlan'))
      );
      
      // Si no hay interfaces específicas, usar todas las activas
      const interfacesToMonitor = activeInterfaces.length > 0 
        ? activeInterfaces.slice(0, 5) // Máximo 5 interfaces
        : interfaces.filter(i => i.running === 'true').slice(0, 3);
      
      logger.info(`Monitoreando ${interfacesToMonitor.length} interfaces: ${interfacesToMonitor.map(i => i.name).join(', ')}`);
      
      const statsPromises = interfacesToMonitor.map(async (iface) => {
        try {
          const stats = await this.retryOperation(async () => {
            const result = await conn.write('/interface/monitor-traffic', [
              `=interface=${iface.name}`,
              '=once='
            ]);
            return result;
          });
          
          if (stats && stats.length > 0) {
            const data = {
              interface: iface.name,
              rxBits: parseInt(stats[0]['rx-bits-per-second']) || 0,
              txBits: parseInt(stats[0]['tx-bits-per-second']) || 0,
              rxBytes: parseInt(stats[0]['rx-byte']) || 0,
              txBytes: parseInt(stats[0]['tx-byte']) || 0,
              rxPackets: parseInt(stats[0]['rx-packet']) || 0,
              txPackets: parseInt(stats[0]['tx-packet']) || 0,
              timestamp: timestamp
            };
            logger.debug(`Datos de ${iface.name}: RX=${data.rxBits} bps, TX=${data.txBits} bps`);
            return data;
          }
          return null;
        } catch (error) {
          logger.warn(`Error monitoreando ${iface.name}: ${error.message}`);
          return null;
        }
      });
      
      const results = await Promise.all(statsPromises);
      results.forEach(result => {
        if (result) bandwidthData.push(result);
      });
      
      logger.info(`Datos de ancho de banda obtenidos: ${bandwidthData.length} interfaces`);
      
      // Almacenar histórico (máximo 300 puntos)
      if (bandwidthData.length > 0) {
        this.bandwidthHistory.push(...bandwidthData);
        if (this.bandwidthHistory.length > 300) {
          this.bandwidthHistory = this.bandwidthHistory.slice(-300);
        }
        
        // Actualizar cache
        this.bandwidthCache = bandwidthData;
        this.lastCacheTime = now;
      }
      
      return bandwidthData.length > 0 ? bandwidthData : [];
    } catch (error) {
      logger.error(`Error obteniendo ancho de banda: ${error.message}`);
      throw new Error(`Error al obtener ancho de banda: ${error.message}`);
    }
  }

  async getBandwidthHistory(minutes = 5) {
    const cutoffTime = new Date(Date.now() - minutes * 60 * 1000);
    return this.bandwidthHistory.filter(entry => 
      new Date(entry.timestamp) > cutoffTime
    );
  }

  async setSpeedLimit(userIp, rxLimit, txLimit) {
    try {
      const conn = await this.connect();
      const existingRules = await this.retryOperation(() =>
        conn.write('/queue/simple/print', { '?target': userIp + '/32' })
      );
      
      if (existingRules.length > 0) {
        await this.retryOperation(() =>
          conn.write('/queue/simple/set', {
            '.id': existingRules[0]['.id'],
            'max-limit': `${rxLimit}/${txLimit}`
          })
        );
        logger.info(`Límite actualizado para ${userIp}: ${rxLimit}/${txLimit}`);
      } else {
        await this.retryOperation(() =>
          conn.write('/queue/simple/add', {
            name: `limit_${userIp.replace(/\./g, '_')}`,
            target: userIp + '/32',
            'max-limit': `${rxLimit}/${txLimit}`
          })
        );
        logger.info(`Nuevo límite creado para ${userIp}: ${rxLimit}/${txLimit}`);
      }
      
      return { success: true, message: 'Límite establecido correctamente' };
    } catch (error) {
      logger.error(`Error estableciendo límite: ${error.message}`);
      throw new Error(`Error al establecer límite: ${error.message}`);
    }
  }

  async removeSpeedLimit(userIp) {
    try {
      const conn = await this.connect();
      const rules = await this.retryOperation(() =>
        conn.write('/queue/simple/print', { '?target': userIp + '/32' })
      );
      
      for (const rule of rules) {
        await this.retryOperation(() =>
          conn.write('/queue/simple/remove', { '.id': rule['.id'] })
        );
      }
      
      logger.info(`Límite removido para ${userIp}`);
      return { success: true, message: 'Límite removido correctamente' };
    } catch (error) {
      logger.error(`Error removiendo límite: ${error.message}`);
      throw new Error(`Error al remover límite: ${error.message}`);
    }
  }

async kickUser(userIp) {
  try {
    const conn = await this.connect();

    // 1. Crear lista si no existe (con IP temporal)
    try {
      await conn.write('/ip/firewall/address-list/add', [
        '=list=api_blocked',
        '=address=127.0.0.1',
        '=comment=Lista_inicial',
        '=timeout=1s'
      ]);
    } catch (e) {
      if (!e.message.includes('already have')) throw e;
    }

    // 2. Verificar/crear regla de firewall
    const firewallRules = await conn.write('/ip/firewall/filter/print', [
      '?comment=bloqueo_api'
    ]);

    if (firewallRules.length === 0) {
      await conn.write('/ip/firewall/filter/add', [
        '=chain=forward',
        '=src-address-list=api_blocked',
        '=action=drop',
        '=comment=bloqueo_api'
      ]);
    }

    // 3. Bloquear IP
    const result = await conn.write('/ip/firewall/address-list/add', [
      '=list=api_blocked',
      `=address=${userIp}`,
      '=comment=Bloqueado_por_API',
      '=timeout=5m'
    ]);

    return {
      success: true,
      message: `IP ${userIp} bloqueada por 5 minutos`,
      ruleId: result['.id']
    };
  } catch (error) {
    logger.error(`Error bloqueando usuario: ${error.message}`);
    throw new Error(`Error al bloquear usuario: ${error.message}`);
  }
}

async unblockUser(userIp) {
  try {
    const conn = await this.connect();
    
    // Buscar y eliminar todas las entradas relacionadas
    const listEntries = await conn.write('/ip/firewall/address-list/print', [
      '?list=api_blocked',
      `?address=${userIp}`
    ]);

    let removed = 0;
    for (const entry of listEntries) {
      await conn.write('/ip/firewall/address-list/remove', [
        `=.id=${entry['.id']}`
      ]);
      removed++;
    }

    return {
      success: true,
      message: `IP ${userIp} desbloqueada`,
      rulesRemoved: removed
    };
  } catch (error) {
    logger.error(`Error desbloqueando usuario: ${error.message}`);
    throw new Error(`Error al desbloquear usuario: ${error.message}`);
  }
}


  async getActiveQueues() {
    try {
      const conn = await this.connect();
      const queues = await this.retryOperation(() =>
        conn.write('/queue/simple/print')
      );
      
      return queues.map(queue => ({
        id: queue['.id'],
        name: queue.name,
        target: queue.target,
        maxLimit: queue['max-limit'],
        bytesIn: parseInt(queue.bytes) || 0,
        bytesOut: parseInt(queue['bytes-out']) || 0,
        packetsIn: parseInt(queue.packets) || 0,
        packetsOut: parseInt(queue['packets-out']) || 0
      }));
    } catch (error) {
      logger.error(`Error obteniendo queues: ${error.message}`);
      throw new Error(`Error al obtener queues: ${error.message}`);
    }
  }

  async checkMikrotikConnection() {
    try {
      const conn = await this.connect();
      const result = await this.retryOperation(() => 
        conn.write('/system/resource/print')
      );
      return result && result.length > 0;
    } catch (error) {
      logger.error(`Error verificando conexión: ${error.message}`);
      return false;
    }
  }

  // Obtener estadísticas del sistema
  async getSystemStats() {
    try {
      const conn = await this.connect();
      const [resource, health] = await Promise.all([
        this.retryOperation(() => conn.write('/system/resource/print')),
        this.retryOperation(() => conn.write('/system/health/print'))
      ]);

      return {
        cpuLoad: resource[0]['cpu-load'],
        memoryFree: resource[0]['free-memory'],
        memoryTotal: resource[0]['total-memory'],
        uptime: resource[0].uptime,
        temperature: health[0]?.temperature || 'N/A'
      };
    } catch (error) {
      logger.error(`Error obteniendo estadísticas del sistema: ${error.message}`);
      throw new Error(`Error al obtener estadísticas: ${error.message}`);
    }
  }
}

module.exports = MikrotikService;