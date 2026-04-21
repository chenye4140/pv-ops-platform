/**
 * Rate Limiting Middleware
 *
 * Protects the API from abuse with tiered rate limits:
 * - General API: 200 requests per 15 minutes per IP
 * - Auth endpoints: 20 requests per 15 minutes per IP (stricter for login/register)
 * - Backup endpoints: 10 requests per 15 minutes per IP (expensive operations)
 */
const rateLimit = require('express-rate-limit');

// Default API rate limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: '请求过于频繁，请稍后再试',
  },
});

// Stricter limit for auth endpoints (login/register)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: '登录尝试过于频繁，请15分钟后再试',
  },
});

// Very strict limit for backup operations (expensive disk I/O)
const backupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: '备份操作过于频繁，请稍后再试',
  },
});

module.exports = {
  apiLimiter,
  authLimiter,
  backupLimiter,
};
