require('dotenv').config();
const { RouterOSAPI } = require('node-routeros');

const config = {
  host: process.env.MIKROTIK_HOST,
  user: process.env.MIKROTIK_USER,
  password: process.env.MIKROTIK_PASSWORD,
  port: parseInt(process.env.MIKROTIK_PORT) || 8728,
  timeout: 10000
};

async function testConnection() {
  console.log(`Intentando conectar a ${config.host}:${config.port} con usuario ${config.user}`);
  const conn = new RouterOSAPI(config);
  try {
    await conn.connect();
    console.log('Conexión exitosa a MikroTik');
    await conn.close();
  } catch (error) {
    console.error('Error de conexión:', error.message);
    console.error('Detalles del error:', JSON.stringify(error, null, 2));
  }
}

testConnection();