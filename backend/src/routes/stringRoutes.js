const express = require('express');
const router = express.Router();
const powerDataService = require('../services/powerDataService');
const { authenticate, requireStationAccess } = require('../middleware/authMiddleware');

router.use(authenticate);
router.use(requireStationAccess);

// GET /api/strings/:id/power?start=&end=
// Convenience route matching frontend calls
router.get('/:id/power', (req, res) => {
  try {
    const { start, end } = req.query;
    const data = powerDataService.getByStringId(req.params.id, start, end);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
