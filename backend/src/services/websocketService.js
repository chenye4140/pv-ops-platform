const WebSocket = require('ws');
const authService = require('./authService');

const WS_PORT = process.env.WS_PORT || 3001;
const HEARTBEAT_INTERVAL = 30000; // 30s ping interval
const PING_TIMEOUT = 10000; // 10s pong timeout

const VALID_TOPICS = ['alerts', 'workorders', 'power-data', 'inspections'];

// userId -> Set of WebSocket connections
const userConnections = new Map();

// topic -> Set of WebSocket connections
const topicSubscriptions = new Map();

// room (station_id) -> topic -> Set of WebSocket connections
const roomSubscriptions = new Map();

// All connected WebSocket instances for broadcasting
const allConnections = new Set();

VALID_TOPICS.forEach(topic => {
  topicSubscriptions.set(topic, new Set());
});

let wss = null;
let heartbeatTimer = null;

function startWSServer() {
  return new Promise((resolve) => {
    wss = new WebSocket.Server({ port: WS_PORT }, () => {
      console.log(`🔌 WebSocket server listening on ws://localhost:${WS_PORT}`);
      resolve(wss);
    });

    // Start heartbeat
    heartbeatTimer = setInterval(pingAll, HEARTBEAT_INTERVAL);

    wss.on('connection', (ws, req) => {
      handleConnection(ws, req);
    });

    wss.on('error', (err) => {
      console.error('WebSocket server error:', err.message);
    });
  });
}

function handleConnection(ws, req) {
  let userId = null;
  let isAlive = true;

  // Mark as alive on pong
  ws.on('pong', () => {
    isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    switch (msg.type) {
      case 'auth':
        handleAuth(ws, msg.token);
        break;
      case 'subscribe':
        handleSubscribe(ws, msg.topic, msg.room);
        break;
      case 'unsubscribe':
        handleUnsubscribe(ws, msg.topic, msg.room);
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
    }
  });

  ws.on('close', () => {
    cleanupConnection(ws, userId);
  });

  ws.on('error', (err) => {
    console.error('WebSocket connection error:', err.message);
    cleanupConnection(ws, userId);
  });
}

function handleAuth(ws, token) {
  if (!token) {
    ws.send(JSON.stringify({ type: 'error', message: 'Token required' }));
    ws.close(1008, 'Authentication required');
    return;
  }

  try {
    const decoded = authService.verifyToken(token);
    userId = decoded.userId;

    // Register connection
    if (!userConnections.has(userId)) {
      userConnections.set(userId, new Set());
    }
    userConnections.get(userId).add(ws);

    allConnections.add(ws);

    ws.send(JSON.stringify({
      type: 'auth_success',
      userId,
      username: decoded.username,
      role: decoded.role,
      message: 'Authenticated successfully'
    }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
    ws.close(1008, 'Authentication failed');
  }
}

function handleSubscribe(ws, topic, room) {
  if (!topic || !VALID_TOPICS.includes(topic)) {
    ws.send(JSON.stringify({ type: 'error', message: `Invalid topic. Valid: ${VALID_TOPICS.join(', ')}` }));
    return;
  }

  // Topic subscription
  if (!topicSubscriptions.has(topic)) {
    topicSubscriptions.set(topic, new Set());
  }
  topicSubscriptions.get(topic).add(ws);

  // Room subscription (optional)
  if (room) {
    if (!roomSubscriptions.has(room)) {
      roomSubscriptions.set(room, {});
    }
    if (!roomSubscriptions.get(room)[topic]) {
      roomSubscriptions.get(room)[topic] = new Set();
    }
    roomSubscriptions.get(room)[topic].add(ws);
  }

  ws.send(JSON.stringify({
    type: 'subscribed',
    topic,
    room: room || null
  }));
}

function handleUnsubscribe(ws, topic, room) {
  if (topic && topicSubscriptions.has(topic)) {
    topicSubscriptions.get(topic).delete(ws);
  }

  if (room && roomSubscriptions.has(room)) {
    const roomTopics = roomSubscriptions.get(room);
    if (topic && roomTopics[topic]) {
      roomTopics[topic].delete(ws);
    }
  }

  ws.send(JSON.stringify({
    type: 'unsubscribed',
    topic: topic || 'all',
    room: room || null
  }));
}

function cleanupConnection(ws, uid) {
  allConnections.delete(ws);

  // Remove from topic subscriptions
  topicSubscriptions.forEach(conns => conns.delete(ws));

  // Remove from room subscriptions
  roomSubscriptions.forEach(roomTopics => {
    Object.values(roomTopics).forEach(conns => conns.delete(ws));
  });

  // Remove from user connections
  if (uid && userConnections.has(uid)) {
    userConnections.get(uid).delete(ws);
    if (userConnections.get(uid).size === 0) {
      userConnections.delete(uid);
    }
  }
}

function pingAll() {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}

/**
 * Broadcast an event to all subscribers of a topic.
 * Optionally filter by room (station_id).
 *
 * @param {string} event - Event name (e.g., 'created', 'updated')
 * @param {*} data - Payload data
 * @param {string} topic - One of the valid topics
 * @param {string} [room] - Optional room/station_id filter
 */
function broadcast(event, data, topic, room) {
  if (!topic || !VALID_TOPICS.includes(topic)) {
    console.warn(`[WS] Invalid topic: ${topic}`);
    return;
  }

  const payload = JSON.stringify({
    type: 'event',
    event,
    topic,
    data,
    timestamp: new Date().toISOString()
  });

  const targets = new Set();

  // Global topic subscribers
  if (topicSubscriptions.has(topic)) {
    topicSubscriptions.get(topic).forEach(ws => targets.add(ws));
  }

  // Room-specific subscribers
  if (room && roomSubscriptions.has(room)) {
    const roomTopics = roomSubscriptions.get(room);
    if (roomTopics[topic]) {
      roomTopics[topic].forEach(ws => targets.add(ws));
    }
  }

  let sent = 0;
  targets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      sent++;
    }
  });

  console.log(`[WS] Broadcast "${event}" on "${topic}"${room ? ` room:${room}` : ''} → ${sent} clients`);
}

function getStats() {
  return {
    totalConnections: wss ? wss.clients.size : 0,
    uniqueUsers: userConnections.size,
    topics: Object.fromEntries(
      Array.from(topicSubscriptions.entries()).map(([topic, conns]) => [topic, conns.size])
    ),
    rooms: Object.fromEntries(
      Array.from(roomSubscriptions.entries()).map(([room, topics]) => {
        const counts = {};
        Object.entries(topics).forEach(([topic, conns]) => {
          counts[topic] = conns.size;
        });
        return [room, counts];
      })
    ),
    uptime: heartbeatTimer ? 'running' : 'stopped'
  };
}

function getWSS() {
  return wss;
}

function stopWSServer() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (wss) {
    wss.clients.forEach(ws => ws.close());
    wss.close();
    wss = null;
  }
}

module.exports = {
  startWSServer,
  broadcast,
  getStats,
  getWSS,
  stopWSServer,
};
