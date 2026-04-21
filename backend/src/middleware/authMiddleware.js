const authService = require('../services/authService');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = authService.verifyToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token expired' });
    }
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Role '${req.user.role}' is not authorized. Required: ${roles.join(', ')}`,
      });
    }

    next();
  };
}

function requireStationAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  // Admins have access to all stations
  if (req.user.role === 'admin') {
    return next();
  }

  // If user has no station restriction (stationIds is null), they have access to all
  if (!req.user.stationIds) {
    return next();
  }

  const stationId = req.params.id || req.params.stationId || req.params.station_id || req.query.station_id || req.query.stationId;

  if (!stationId) {
    // No station ID in request, allow to proceed
    return next();
  }

  const stationIdNum = parseInt(stationId, 10);
  if (req.user.stationIds.includes(stationIdNum)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    error: 'Access denied: you do not have permission to access this station',
  });
}

module.exports = {
  authenticate,
  requireRole,
  requireStationAccess,
};
