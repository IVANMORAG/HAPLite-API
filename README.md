# MikroTik Management API

API para la gestión de usuarios, ancho de banda y configuración de routers MikroTik.

## Características principales

- Gestión de usuarios conectados
- Monitoreo de ancho de banda en tiempo real
- Límites de velocidad por IP
- Bloqueo/desbloqueo de usuarios
- Autenticación JWT
- WebSockets para actualizaciones en tiempo real
- Logging detallado

## Requisitos previos

- Node.js 18.x o superior
- Router MikroTik con API habilitada
- Credenciales de acceso al router

## Instalación

1. Clonar el repositorio:
```bash
git clone https://github.com/tu-usuario/mikrotik-api.git
cd mikrotik-api
```

2. Instalar dependencias:
```bash
npm install
```

3. Configurar variables de entorno:
```bash
cp .env.example .env
```

Editar el archivo `.env` con tus credenciales:
```env
MIKROTIK_HOST=192.168.88.1
MIKROTIK_PORT=8728
MIKROTIK_USER=admin
MIKROTIK_PASSWORD=tu_contraseña
JWT_SECRET=tu_secreto_jwt
```

4. Iniciar el servidor:
```bash
npm start
# o para desarrollo
npm run dev
```

## Uso

### Autenticación

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "password123"
}
```

Respuesta:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "admin",
    "role": "admin"
  }
}
```

### Endpoints principales

- `GET /api/mikrotik/users` - Lista de usuarios conectados
- `GET /api/mikrotik/bandwidth` - Uso de ancho de banda
- `POST /api/mikrotik/speed-limit` - Establecer límite de velocidad
- `POST /api/mikrotik/kick-user` - Expulsar usuario
- `GET /api/mikrotik/queues` - Listar colas activas

## WebSockets

La API incluye soporte para WebSockets para recibir actualizaciones en tiempo real del ancho de banda:

```javascript
const socket = io('http://tuservidor:5001');

socket.on('connect', () => {
  console.log('Conectado al servidor WebSocket');
  
  // Autenticar
  socket.emit('authenticate', { token: 'tu_jwt_token' });
  
  // Suscribirse a actualizaciones de ancho de banda
  socket.emit('subscribe-bandwidth');
});

socket.on('bandwidth-data', (data) => {
  console.log('Datos de ancho de banda:', data);
});

socket.on('disconnect', () => {
  console.log('Desconectado del servidor WebSocket');
});
```

## Estructura del proyecto

```
src/
├── middleware/        # Middlewares de Express
├── routes/           # Definición de rutas
├── services/         # Lógica de negocio
├── utils/            # Utilidades
└── server.js         # Punto de entrada
```

## Variables de entorno

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `MIKROTIK_HOST` | IP del router MikroTik | `192.168.88.1` |
| `MIKROTIK_PORT` | Puerto API (normalmente 8728) | `8728` |
| `MIKROTIK_USER` | Usuario API | `admin` |
| `MIKROTIK_PASSWORD` | Contraseña API | `password123` |
| `JWT_SECRET` | Secreto para firmar JWT | `secret_key` |
| `CORS_ORIGIN` | Orígenes permitidos (separados por coma) | `http://localhost:3000` |

## Contribución

1. Haz un fork del proyecto
2. Crea una rama para tu feature (`git checkout -b feature/awesome-feature`)
3. Haz commit de tus cambios (`git commit -m 'Add some awesome feature'`)
4. Haz push a la rama (`git push origin feature/awesome-feature`)
5. Abre un Pull Request

## Licencia

MIT