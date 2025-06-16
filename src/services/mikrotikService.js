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
      }
    }
  }

  async getConnectedUsers() {
    try {
      logger.debug('Obteniendo usuarios conectados');
      const conn = await this.connect();

      const [arpEntries, dhcpLeases] = await Promise.all([
        this.retryOperation(() => conn.write('/ip/arp/print')),
        this.retryOperation(() => conn.write('/ip/dhcp-server/lease/print'))
      ]);

      const users = arpEntries.map(arp => {
        const lease = dhcpLeases.find(l => l['mac-address'] === arp['mac-address']);
        return {
          id: arp['.id'],
          ip: arp.address,
          mac: arp['mac-address'],
          interface: arp.interface,
          hostname: lease ? lease['host-name'] || arp['mac-address'] : arp['mac-address'],
          status: arp.dynamic === 'true' ? 'Activo' : 'Estático',
          lastSeen: arp['last-seen'] || 'N/A'
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
      logger.debug('Obteniendo uso de ancho de banda');
      const conn = await this.connect();
      
      // Obtener interfaces activas dinámicamente
      const interfaces = await this.retryOperation(() => 
        conn.write('/interface/print')
      );
      
      const bandwidthData = [];
      const now = new Date().toISOString();
      
      // Procesar interfaces principales
      for (const iface of interfaces.filter(i => ['ether1', 'wlan1', 'bridge'].includes(i.name))) {
        try {
          const stats = await this.retryOperation(() =>
            conn.write('/interface/monitor-traffic', {
              interface: iface.name,
              interval: 1,
              once: true
            }, { timeout: 2000 })
          );
          
          if (stats?.[0]) {
            bandwidthData.push({
              interface: iface.name,
              rxBits: parseInt(stats[0]['rx-bits-per-second']) || 0,
              txBits: parseInt(stats[0]['tx-bits-per-second']) || 0,
              rxBytes: parseInt(stats[0]['rx-byte']) || 0,
              txBytes: parseInt(stats[0]['tx-byte']) || 0,
              timestamp: now
            });
          }
        } catch (error) {
          logger.warn(`Error monitoreando ${iface.name}: ${error.message}`);
        }
      }
      
      // Almacenar histórico (máximo 300 puntos)
      if (bandwidthData.length > 0) {
        this.bandwidthHistory.push(...bandwidthData);
        if (this.bandwidthHistory.length > 300) {
          this.bandwidthHistory = this.bandwidthHistory.slice(-300);
        }
      }
      
      return bandwidthData.length > 0 ? bandwidthData : null;
    } catch (error) {
      logger.error(`Error obteniendo ancho de banda: ${error.message}`);
      throw new Error(`Error al obtener ancho de banda: ${error.message}`);
    }
  }

  async getBandwidthHistory() {
    return this.bandwidthHistory;
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

    // 1. Crear la lista 'api_blocked' si no existe (con una IP temporal)
    try {
      await conn.write('/ip/firewall/address-list/add', [
        '=list=api_blocked',
        '=address=127.0.0.1',
        '=comment=Lista_inicial',
        '=timeout=1s'
      ]);
    } catch (e) {
      // Ignorar si la lista ya existe
      if (!e.message.includes('already have')) {
        throw e;
      }
    }

    // 2. Verificar/Crear la regla de firewall
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

    // 3. Agregar la IP a bloquear
    const result = await conn.write('/ip/firewall/address-list/add', [
      '=list=api_blocked',
      `=address=${userIp}`,
      '=comment=Bloqueado_por_API'
    ]);

    return {
      success: true,
      message: `IP ${userIp} bloqueada exitosamente`,
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
    
    // Eliminar todas las reglas que bloqueen esta IP
    const rules = await conn.write('/ip/firewall/filter/print', [
      `?src-address=${userIp}`,
      '?action=drop'
    ]);
    
    // También eliminar de address-list
    const listEntries = await conn.write('/ip/firewall/address-list/print', [
      '?list=api_blocked',
      `?address=${userIp}`
    ]);

    // Eliminar todas las entradas encontradas
    const allEntries = [...rules, ...listEntries];
    for (const entry of allEntries) {
      const cmd = entry.list ? 
        '/ip/firewall/address-list/remove' : 
        '/ip/firewall/filter/remove';
      
      await conn.write([cmd, `=.id=${entry['.id']}`]);
    }

    return {
      success: true,
      message: `IP ${userIp} desbloqueada`,
      rulesRemoved: allEntries.length
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
      await this.retryOperation(() => 
        conn.write('/system/resource/print')
      );
      return true;
    } catch (error) {
      logger.error(`Error verificando conexión: ${error.message}`);
      return false;
    }
  }
}

module.exports = MikrotikService;