/**
 * PV Ops Platform WebSocket Client
 * Connects to the backend WebSocket server, handles auth, subscriptions,
 * and reconnection with exponential backoff.
 */
(function () {
  'use strict';

  const WS_URL = (typeof PV_WS_URL !== 'undefined')
    ? PV_WS_URL
    : 'ws://localhost:3001';

  const RECONNECT_BASE_DELAY = 1000;    // 1s
  const RECONNECT_MAX_DELAY = 30000;    // 30s
  const RECONNECT_FACTOR = 2;
  const AUTH_TIMEOUT = 5000;   // 5s to authenticate

  function PVWebSocketClient() {
    this.url = WS_URL;
    this.ws = null;
    this.reconnectDelay = RECONNECT_BASE_DELAY;
    this.reconnectTimer = null;
    this.authTimer = null;
    this.authenticated = false;
    this.subscriptions = {};  // topic -> [callbacks]
    this.status = 'disconnected';
    this.statusListeners = [];
    this.token = null;
    this._onMessage = this._onMessage.bind(this);
    this._onOpen = this._onOpen.bind(this);
    this._onClose = this._onClose.bind(this);
    this._onError = this._onError.bind(this);
  }

  /* ---------- Lifecycle ---------- */

  PVWebSocketClient.prototype.connect = function (token) {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      return; // already connecting or connected
    }
    if (token) this.token = token;

    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this._setStatus('error');
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = this._onOpen;
    this.ws.onmessage = this._onMessage;
    this.ws.onclose = this._onClose;
    this.ws.onerror = this._onError;

    this._setStatus('connecting');
  };

  PVWebSocketClient.prototype.disconnect = function () {
    this._clearReconnect();
    this._clearAuthTimer();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.authenticated = false;
    this._setStatus('disconnected');
  };

  /* ---------- Auth ---------- */

  PVWebSocketClient.prototype.authenticate = function (token) {
    if (token) this.token = token;
    if (!this.token) {
      console.warn('[pvWS] No token available for authentication');
      return;
    }
    if (!this.ws || this.ws.readyState !== 1) {
      console.warn('[pvWS] Cannot authenticate: not connected');
      return;
    }

    this.authenticated = false;
    this._send({ type: 'auth', token: this.token });

    // Timeout for auth
    this._clearAuthTimer();
    this.authTimer = setTimeout(() => {
      if (!this.authenticated) {
        console.warn('[pvWS] Authentication timeout');
        this._setStatus('error');
      }
    }, AUTH_TIMEOUT);
  };

  /* ---------- Subscribe / Unsubscribe ---------- */

  PVWebSocketClient.prototype.subscribe = function (topic, callback, room) {
    if (typeof topic !== 'string') return;
    if (typeof callback === 'function') {
      if (!this.subscriptions[topic]) this.subscriptions[topic] = [];
      this.subscriptions[topic].push(callback);
    }

    if (this.ws && this.ws.readyState === 1) {
      this._send({ type: 'subscribe', topic: topic, room: room || null });
    }
  };

  PVWebSocketClient.prototype.unsubscribe = function (topic, room) {
    if (topic) {
      if (this.subscriptions[topic]) {
        this.subscriptions[topic] = [];
      }
      if (this.ws && this.ws.readyState === 1) {
        this._send({ type: 'unsubscribe', topic: topic, room: room || null });
      }
    }
  };

  /* ---------- Status ---------- */

  PVWebSocketClient.prototype.onStatus = function (listener) {
    if (typeof listener === 'function') {
      this.statusListeners.push(listener);
    }
  };

  PVWebSocketClient.prototype.getStatus = function () {
    return this.status;
  };

  /* ---------- Internal ---------- */

  PVWebSocketClient.prototype._onOpen = function () {
    console.log('[pvWS] Connected');
    this.reconnectDelay = RECONNECT_BASE_DELAY; // reset backoff
    if (this.token) {
      this.authenticate();
    } else {
      this._setStatus('connected');
    }

    // Re-subscribe to previous topics
    var topics = Object.keys(this.subscriptions);
    for (var i = 0; i < topics.length; i++) {
      this._send({ type: 'subscribe', topic: topics[i], room: null });
    }
  };

  PVWebSocketClient.prototype._onMessage = function (event) {
    var msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case 'auth_success':
        this.authenticated = true;
        this._clearAuthTimer();
        this._setStatus('connected');
        console.log('[pvWS] Authenticated as:', msg.username);
        break;

      case 'error':
        console.warn('[pvWS] Server error:', msg.message);
        break;

      case 'subscribed':
        console.log('[pvWS] Subscribed to:', msg.topic, msg.room ? 'room:' + msg.room : '');
        break;

      case 'unsubscribed':
        break;

      case 'pong':
        break;

      case 'event':
        this._handleEvent(msg);
        break;
    }
  };

  PVWebSocketClient.prototype._onClose = function () {
    this.authenticated = false;
    this._setStatus('disconnected');
    this._scheduleReconnect();
  };

  PVWebSocketClient.prototype._onError = function () {
    // WebSocket error event doesn't give much detail
  };

  PVWebSocketClient.prototype._handleEvent = function (msg) {
    var topic = msg.topic;
    if (topic && this.subscriptions[topic]) {
      var callbacks = this.subscriptions[topic];
      for (var i = 0; i < callbacks.length; i++) {
        try {
          callbacks[i](msg.data, msg.event, msg);
        } catch (e) {
          console.error('[pvWS] Callback error:', e);
        }
      }
    }
  };

  PVWebSocketClient.prototype._send = function (data) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(data));
    }
  };

  PVWebSocketClient.prototype._setStatus = function (status) {
    this.status = status;
    for (var i = 0; i < this.statusListeners.length; i++) {
      try {
        this.statusListeners[i](status);
      } catch (e) {}
    }
  };

  PVWebSocketClient.prototype._scheduleReconnect = function () {
    this._clearReconnect();
    console.log('[pvWS] Reconnecting in', this.reconnectDelay, 'ms');
    var self = this;
    this.reconnectTimer = setTimeout(function () {
      self.connect();
    }, this.reconnectDelay);
    // Exponential backoff
    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_FACTOR,
      RECONNECT_MAX_DELAY
    );
  };

  PVWebSocketClient.prototype._clearReconnect = function () {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  };

  PVWebSocketClient.prototype._clearAuthTimer = function () {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  };

  // Expose global
  window.pvWS = new PVWebSocketClient();
})();
