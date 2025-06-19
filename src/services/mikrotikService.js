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


 // Reemplaza la función getConnectedUsers() en tu mikrotikService.js

// REEMPLAZA la función getConnectedUsers() en mikrotikService.js

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
        const maxLimit = queue['max-limit'] || '';
        
        // Parsear límites para mostrar números reales
        let uploadSpeed = 'Sin límite';
        let downloadSpeed = 'Sin límite';
        
        if (maxLimit && maxLimit !== '') {
          const [upload, download] = maxLimit.split('/');
          if (upload && download) {
            uploadSpeed = this.parseSpeedToMbps(upload);
            downloadSpeed = this.parseSpeedToMbps(download);
          }
        }
        
        speedLimits[target] = {
          maxLimit: maxLimit,
          uploadSpeed: uploadSpeed,
          downloadSpeed: downloadSpeed,
          hasLimit: maxLimit && maxLimit !== '',
          bytesIn: parseInt(queue.bytes) || 0,
          bytesOut: parseInt(queue['bytes-out']) || 0
        };
      }
    });

    const users = arpEntries.map(arp => {
      const lease = dhcpLeases.find(l => l['mac-address'] === arp['mac-address']);
      const speedLimit = speedLimits[arp.address];
      
      // Determinar el nombre del dispositivo
      let deviceName = arp['mac-address']; // Por defecto usar MAC
      if (lease && lease['host-name']) {
        deviceName = lease['host-name'];
      }
      
      // Formatear velocidad de conexión
      let velocidadConexion = 'Sin límite';
      if (speedLimit && speedLimit.hasLimit) {
        velocidadConexion = `${speedLimit.uploadSpeed} / ${speedLimit.downloadSpeed}`;
      }
      
      return {
        id: arp['.id'],
        ip: arp.address,
        mac: arp['mac-address'],
        interface: arp.interface,
        dispositivo: deviceName,
        status: arp.dynamic === 'true' ? 'Activo' : 'Estático',
        lastSeen: arp['last-seen'] || 'N/A',
        velocidadConexion: velocidadConexion,
        hasSpeedLimit: speedLimit ? speedLimit.hasLimit : false,
        speedLimit: speedLimit ? speedLimit.maxLimit : null,
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

// AGREGAR esta función auxiliar al final de la clase MikrotikService
parseSpeedToMbps(speedString) {
  if (!speedString) return 'Sin límite';
  
  // Convertir diferentes formatos a Mbps
  const speed = speedString.toString().toLowerCase();
  
  if (speed.includes('k')) {
    const value = parseFloat(speed.replace(/[^0-9.]/g, ''));
    return `${(value / 1000).toFixed(1)} Mbps`;
  } else if (speed.includes('m')) {
    const value = parseFloat(speed.replace(/[^0-9.]/g, ''));
    return `${value} Mbps`;
  } else if (speed.includes('g')) {
    const value = parseFloat(speed.replace(/[^0-9.]/g, ''));
    return `${(value * 1000).toFixed(1)} Mbps`;
  } else {
    // Asumir que está en bits por segundo
    const value = parseInt(speed);
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(1)} Mbps`;
    } else if (value >= 1000) {
      return `${(value / 1000).toFixed(1)} Kbps`;
    } else {
      return `${value} bps`;
    }
  }
}

// Función auxiliar para formatear bandwidth (agrégala al final de la clase)
formatBandwidth(bitsPerSecond) {
  if (bitsPerSecond === 0) return '0 bps';
  
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  let value = bitsPerSecond;
  let unitIndex = 0;
  
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  
  return `${value.toFixed(1)} ${units[unitIndex]}`;
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


// REEMPLAZA COMPLETAMENTE la función setSpeedLimit en mikrotikService.js
async setSpeedLimit(userIp, rxLimit, txLimit) {
  try {
    const conn = await this.connect();
    
    logger.info(`Estableciendo límite para ${userIp}: RX=${rxLimit}, TX=${txLimit} (${rxLimit/1000000}/${txLimit/1000000} Mbps)`);
    
    // CASO ESPECIAL: Si ambos límites son 0, BLOQUEAR completamente
    if (rxLimit === 0 && txLimit === 0) {
      return await this.blockUserCompletely(userIp);
    }
    
    // CASO ESPECIAL: Si uno de los límites es 0, usar valor muy bajo (1 bps)
    const effectiveRxLimit = rxLimit === 0 ? 1 : rxLimit;  // 1 bit por segundo = prácticamente bloqueado
    const effectiveTxLimit = txLimit === 0 ? 1 : txLimit;
    
    const limitString = `${effectiveRxLimit}/${effectiveTxLimit}`;
    
    // Primero, remover cualquier bloqueo de firewall existente
    await this.unblockUser(userIp);
    
    // Remover reglas de queue existentes
    const existingRules = await this.retryOperation(() =>
      conn.write('/queue/simple/print', { '?target': userIp + '/32' })
    );
    
    for (const rule of existingRules) {
      await this.retryOperation(() =>
        conn.write('/queue/simple/remove', { '.id': rule['.id'] })
      );
      logger.info(`Regla anterior removida para ${userIp}: ${rule['.id']}`);
    }
    
    // Crear nueva regla de queue
    const queueName = `limit_${userIp.replace(/\./g, '_')}_${Date.now()}`;
    const result = await this.retryOperation(() =>
      conn.write('/queue/simple/add', {
        name: queueName,
        target: userIp + '/32',
        'max-limit': limitString,
        comment: `API_LIMIT_${new Date().toISOString()}_RX${rxLimit}_TX${txLimit}`
      })
    );
    
    const queueId = result ? result['.id'] : null;
    logger.info(`Nueva regla creada para ${userIp}: ${limitString}, Queue ID: ${queueId}`);
    
    // Verificar que se aplicó correctamente
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const verificationRules = await this.retryOperation(() =>
      conn.write('/queue/simple/print', { '?target': userIp + '/32' })
    );
    
    const applied = verificationRules.length > 0 && 
                   verificationRules[0]['max-limit'] === limitString;
    
    if (!applied) {
      logger.warn(`Advertencia: El límite para ${userIp} podría no haberse aplicado correctamente`);
    }
    
    // Mensaje personalizado según el tipo de límite
    let message;
    if (rxLimit === 0 || txLimit === 0) {
      message = `Límite extremo aplicado para ${userIp} (${(effectiveRxLimit/1000000).toFixed(3)}/${(effectiveTxLimit/1000000).toFixed(3)} Mbps) - Internet prácticamente bloqueado`;
    } else {
      message = `Límite establecido correctamente para ${userIp} (${(rxLimit/1000000).toFixed(1)}/${(txLimit/1000000).toFixed(1)} Mbps)`;
    }
    
    return { 
      success: true, 
      message: message,
      applied: applied,
      limit: limitString,
      originalLimits: { rx: rxLimit, tx: txLimit },
      effectiveLimits: { rx: effectiveRxLimit, tx: effectiveTxLimit },
      limitFormatted: `${(rxLimit/1000000).toFixed(1)} / ${(txLimit/1000000).toFixed(1)} Mbps`,
      userIp: userIp,
      queueId: queueId,
      isBlocked: (rxLimit === 0 && txLimit === 0),
      isRestricted: (rxLimit === 0 || txLimit === 0),
      verification: {
        rules: verificationRules.length,
        maxLimit: verificationRules[0]?.['max-limit'] || null
      }
    };
  } catch (error) {
    logger.error(`Error estableciendo límite para ${userIp}: ${error.message}`);
    throw new Error(`Error al establecer límite: ${error.message}`);
  }
}

// NUEVA FUNCIÓN: Bloquear usuario completamente con firewall
async blockUserCompletely(userIp) {
  try {
    const conn = await this.connect();
    
    logger.info(`Bloqueando completamente a ${userIp} usando firewall`);
    
    // 1. Crear lista de bloqueo si no existe
    try {
      await conn.write('/ip/firewall/address-list/add', [
        '=list=api_speed_blocked',
        '=address=127.0.0.1',
        '=comment=Lista_bloqueo_velocidad',
        '=timeout=1s'
      ]);
    } catch (e) {
      if (!e.message.includes('already have')) {
        logger.debug('Lista api_speed_blocked ya existe o error menor:', e.message);
      }
    }

    // 2. Verificar/crear regla de firewall para bloqueo por velocidad
    const firewallRules = await conn.write('/ip/firewall/filter/print', [
      '?comment=bloqueo_velocidad_api'
    ]);

    if (firewallRules.length === 0) {
      await conn.write('/ip/firewall/filter/add', [
        '=chain=forward',
        '=src-address-list=api_speed_blocked',
        '=action=drop',
        '=comment=bloqueo_velocidad_api'
      ]);
      logger.info('Regla de firewall para bloqueo por velocidad creada');
    }

    // 3. Agregar IP a la lista de bloqueo
    const result = await conn.write('/ip/firewall/address-list/add', [
      '=list=api_speed_blocked',
      `=address=${userIp}`,
      '=comment=Bloqueado_por_limite_0_API'
    ]);

    // 4. También crear una regla de queue con límite mínimo como respaldo
    const existingRules = await this.retryOperation(() =>
      conn.write('/queue/simple/print', { '?target': userIp + '/32' })
    );
    
    for (const rule of existingRules) {
      await this.retryOperation(() =>
        conn.write('/queue/simple/remove', { '.id': rule['.id'] })
      );
    }

    const queueName = `blocked_${userIp.replace(/\./g, '_')}_${Date.now()}`;
    await this.retryOperation(() =>
      conn.write('/queue/simple/add', {
        name: queueName,
        target: userIp + '/32',
        'max-limit': '1/1', // 1 bit por segundo
        comment: `API_BLOCKED_${new Date().toISOString()}`
      })
    );

    return {
      success: true,
      message: `IP ${userIp} bloqueada completamente (sin acceso a internet)`,
      isBlocked: true,
      method: 'firewall_and_queue',
      ruleId: result['.id'] || null,
      userIp: userIp,
      limitFormatted: '0.0 / 0.0 Mbps (Bloqueado)',
      verification: {
        firewallBlocked: true,
        queueLimited: true
      }
    };
  } catch (error) {
    logger.error(`Error bloqueando completamente a ${userIp}: ${error.message}`);
    throw new Error(`Error al bloquear usuario: ${error.message}`);
  }
}

// FUNCIÓN MEJORADA: Remover límite completamente
async removeSpeedLimit(userIp) {
  try {
    const conn = await this.connect();
    
    logger.info(`Removiendo todos los límites para ${userIp}`);
    
    // 1. Remover de listas de firewall
    await this.unblockUser(userIp);
    
    // 2. Remover reglas de queue
    const rules = await this.retryOperation(() =>
      conn.write('/queue/simple/print', { '?target': userIp + '/32' })
    );
    
    for (const rule of rules) {
      await this.retryOperation(() =>
        conn.write('/queue/simple/remove', { '.id': rule['.id'] })
      );
      logger.info(`Regla de queue removida para ${userIp}: ${rule['.id']}`);
    }
    
    logger.info(`Todos los límites removidos para ${userIp} (${rules.length} reglas eliminadas)`);
    
    return { 
      success: true, 
      message: `Límites removidos completamente para ${userIp} - velocidad sin restricciones`,
      rulesRemoved: rules.length,
      userIp: userIp
    };
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

// FUNCIÓN MEJORADA: Desbloquear usuario (actualiza la existente)
async unblockUser(userIp) {
  try {
    const conn = await this.connect();
    
    // Eliminar de listas de firewall (tanto bloqueo temporal como por velocidad)
    const lists = ['api_blocked', 'api_speed_blocked'];
    let removed = 0;
    
    for (const listName of lists) {
      try {
        const listEntries = await conn.write('/ip/firewall/address-list/print', [
          `?list=${listName}`,
          `?address=${userIp}`
        ]);

        for (const entry of listEntries) {
          await conn.write('/ip/firewall/address-list/remove', [
            `=.id=${entry['.id']}`
          ]);
          removed++;
        }
      } catch (e) {
        logger.debug(`Lista ${listName} no existe o sin entradas para ${userIp}`);
      }
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