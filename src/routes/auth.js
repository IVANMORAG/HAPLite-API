const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const logger = require('../utils/logger');

const router = express.Router();

// Usuarios hardcodeados para demo (en producción usar base de datos)
const users = [
  {
    id: 1,
    username: 'admin',
    password: '$2a$10$DwRVMYKU6l5Vh2FK0odfkublbaaKM/WRCpAW58OjtnuCpQng5IWzC', // password123
    role: 'admin'
  }
];

// Middleware para validar errores
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

// POST /api/auth/register - Registrar nuevo usuario
router.post(
  '/register',
  [
    body('username')
      .notEmpty()
      .withMessage('Username es requerido')
      .isLength({ min: 3 })
      .withMessage('Username debe tener al menos 3 caracteres'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password debe tener al menos 6 caracteres'),
    body('role')
      .optional()
      .isIn(['admin', 'user'])
      .withMessage('Rol inválido, debe ser "admin" o "user"')
  ],
  validate,
  async (req, res) => {
    try {
      const { username, password, role = 'user' } = req.body;

      // Verificar si el usuario ya existe
      const existingUser = users.find(u => u.username === username);
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'El usuario ya existe'
        });
      }

      // Hashear contraseña
      const saltRounds = 10;
      const hashedPassword = await bcrypt.hash(password, saltRounds);

      // Crear nuevo usuario
      const newUser = {
        id: users.length + 1,
        username,
        password: hashedPassword,
        role
      };
      users.push(newUser);

      logger.info(`Usuario ${username} registrado exitosamente`);

      res.status(201).json({
        success: true,
        message: 'Usuario registrado exitosamente',
        user: {
          id: newUser.id,
          username: newUser.username,
          role: newUser.role
        }
      });
    } catch (error) {
      logger.error('Error registrando usuario:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }
);

// POST /api/auth/login - Iniciar sesión
router.post(
  '/login',
  [
    body('username').notEmpty().withMessage('Username es requerido'),
    body('password').isLength({ min: 6 }).withMessage('Password debe tener al menos 6 caracteres')
  ],
  validate,
  async (req, res) => {
    try {
      const { username, password } = req.body;

      // Buscar usuario
      const user = users.find(u => u.username === username);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Credenciales inválidas'
        });
      }

      // Verificar contraseña
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        return res.status(401).json({
          success: false,
          message: 'Credenciales inválidas'
        });
      }

      // Generar JWT
      const token = jwt.sign(
        {
          userId: user.id,
          username: user.username,
          role: user.role
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      logger.info(`Usuario ${username} inició sesión exitosamente`);

      res.json({
        success: true,
        message: 'Login exitoso',
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role
        }
      });
    } catch (error) {
      logger.error('Error en login:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }
);

// GET /api/auth/me - Obtener información del usuario actual
router.get('/me', async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Token no proporcionado'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = users.find(u => u.id === decoded.userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    logger.error('Error verificando token:', error);
    res.status(401).json({
      success: false,
      message: 'Token inválido'
    });
  }
});

// POST /api/auth/change-password - Cambiar contraseña
router.post(
  '/change-password',
  [
    body('currentPassword').notEmpty().withMessage('Contraseña actual es requerida'),
    body('newPassword').isLength({ min: 6 }).withMessage('Nueva contraseña debe tener al menos 6 caracteres')
  ],
  validate,
  async (req, res) => {
    try {
      const token = req.header('Authorization')?.replace('Bearer ', '');

      if (!token) {
        return res.status(401).json({
          success: false,
          message: 'Token no proporcionado'
        });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userIndex = users.findIndex(u => u.id === decoded.userId);

      if (userIndex === -1) {
        return res.status(401).json({
          success: false,
          message: 'Usuario no encontrado'
        });
      }

      const { currentPassword, newPassword } = req.body;

      // Verificar contraseña actual
      const isValidCurrentPassword = await bcrypt.compare(currentPassword, users[userIndex].password);
      if (!isValidCurrentPassword) {
        return res.status(400).json({
          success: false,
          message: 'Contraseña actual incorrecta'
        });
      }

      // Hashear nueva contraseña
      const saltRounds = 10;
      const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);

      // Actualizar contraseña
      users[userIndex].password = hashedNewPassword;

      logger.info(`Usuario ${users[userIndex].username} cambió su contraseña`);

      res.json({
        success: true,
        message: 'Contraseña actualizada exitosamente'
      });
    } catch (error) {
      logger.error('Error cambiando contraseña:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }
);

module.exports = router;