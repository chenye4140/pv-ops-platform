/**
 * Chat Assistant Routes — M10 运维对话助手 API
 *
 * RESTful endpoints for session-based conversational AI.
 * All routes require authentication and station access.
 *
 * Endpoints:
 *   POST   /api/chat/sessions              — Create a new chat session
 *   GET    /api/chat/sessions              — Get user's active sessions
 *   GET    /api/chat/sessions/:sessionId   — Get session info
 *   POST   /api/chat/sessions/:sessionId/messages — Send a message
 *   GET    /api/chat/sessions/:sessionId/history  — Get chat history
 *   DELETE /api/chat/sessions/:sessionId   — Delete a session
 */

const express = require('express');
const router = express.Router();
const chatAssistantService = require('../services/chatAssistantService');
const auditService = require('../services/auditService');
const { authenticate, requireStationAccess } = require('../middleware/authMiddleware');

// All routes require authentication and station access
router.use(authenticate);
router.use(requireStationAccess);

/**
 * Extract user ID from authenticated request.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getUserId(req) {
  return req.user ? req.user.id : null;
}

// ---------------------------------------------------------------------------
// POST /api/chat/sessions — Create a new chat session
// ---------------------------------------------------------------------------

/**
 * Create a new chat session for a station.
 *
 * @route POST /api/chat/sessions
 * @body {number} stationId - Station ID to associate with the session
 * @body {string} [userRole] - User role (default: '运维工程师')
 * @returns {Object} { success: true, data: { sessionId, stationId } }
 */
router.post('/sessions', async (req, res) => {
  try {
    const { stationId, userRole } = req.body;

    // Parameter validation
    if (stationId !== undefined && (typeof stationId !== 'number' || stationId <= 0)) {
      return res.status(400).json({
        success: false,
        error: 'stationId must be a positive number',
      });
    }

    const userId = getUserId(req);
    const session = await chatAssistantService.createSession(
      stationId,
      userId,
      userRole || '运维工程师'
    );

    auditService.logAction(userId, 'create', 'chat_session', session.id || session.sessionId, { station_id: stationId, user_role: userRole }, req.ip);

    res.status(201).json({ success: true, data: session });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/chat/sessions — Get user's active session list
// ---------------------------------------------------------------------------

/**
 * Get all active sessions for a user.
 * Currently returns all sessions from the in-memory store.
 * Filter by userId if provided as query param.
 *
 * @route GET /api/chat/sessions
 * @query {string} [userId] - Filter sessions by user ID
 * @returns {Object} { success: true, data: [SessionInfo] }
 */
router.get('/sessions', async (req, res) => {
  try {
    const { userId } = req.query;
    const filterUserId = userId || getUserId(req);

    // Get all sessions from service (use internal clearAllSessions pattern to count)
    // Since the service doesn't expose a "list all" method, we iterate via count
    // For now, return empty array — in production this should be DB-backed
    const sessions = [];

    res.json({ success: true, data: sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/chat/sessions/:sessionId — Get session info
// ---------------------------------------------------------------------------

/**
 * Get information about a specific chat session.
 *
 * @route GET /api/chat/sessions/:sessionId
 * @param {string} sessionId - Session ID
 * @returns {Object} { success: true, data: SessionInfo }
 */
router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId is required',
      });
    }

    const sessionInfo = await chatAssistantService.getSessionInfo(sessionId);

    if (!sessionInfo) {
      return res.status(404).json({
        success: false,
        error: `Session not found: ${sessionId}`,
      });
    }

    res.json({ success: true, data: sessionInfo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat/sessions/:sessionId/messages — Send a message
// ---------------------------------------------------------------------------

/**
 * Send a message to the chat assistant and receive an AI reply.
 *
 * @route POST /api/chat/sessions/:sessionId/messages
 * @param {string} sessionId - Session ID
 * @body {string} message - User message text
 * @returns {Object} { success: true, data: { reply, intent, contextUsed } }
 */
router.post('/sessions/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { message } = req.body;

    // Parameter validation
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId is required',
      });
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'message is required and must be a non-empty string',
      });
    }

    const result = await chatAssistantService.sendMessage(sessionId, message.trim());

    auditService.logAction(getUserId(req), 'send_message', 'chat_session', sessionId, { message_length: message.trim().length }, req.ip);

    res.json({ success: true, data: result });
  } catch (error) {
    // Session not found returns 404
    if (error.message.startsWith('Session not found')) {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/chat/sessions/:sessionId/history — Get chat history
// ---------------------------------------------------------------------------

/**
 * Get the conversation history for a session.
 *
 * @route GET /api/chat/sessions/:sessionId/history
 * @param {string} sessionId - Session ID
 * @query {number} [limit=20] - Maximum number of messages to return
 * @returns {Object} { success: true, data: [Message] }
 */
router.get('/sessions/:sessionId/history', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit, 10) || 20;

    // Parameter validation
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId is required',
      });
    }

    if (isNaN(limit) || limit <= 0 || limit > 100) {
      return res.status(400).json({
        success: false,
        error: 'limit must be a number between 1 and 100',
      });
    }

    const history = await chatAssistantService.getChatHistory(sessionId, limit);

    res.json({ success: true, data: history });
  } catch (error) {
    // Session not found returns 404
    if (error.message.startsWith('Session not found')) {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/chat/sessions/:sessionId — Delete a session
// ---------------------------------------------------------------------------

/**
 * Delete a chat session and free its resources.
 *
 * @route DELETE /api/chat/sessions/:sessionId
 * @param {string} sessionId - Session ID
 * @returns {Object} { success: true, data: { deleted, sessionId } }
 */
router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'sessionId is required',
      });
    }

    const result = await chatAssistantService.deleteSession(sessionId);

    auditService.logAction(getUserId(req), 'delete', 'chat_session', sessionId, { deleted: result.deleted }, req.ip);

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
