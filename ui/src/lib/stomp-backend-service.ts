import { Client } from '@stomp/stompjs';
import { refreshToken } from './api';

export interface BackendStompMessage {
  [key: string]: unknown;
}

export interface BackendStompCallback {
  (message: BackendStompMessage): void;
}

class BackendStompService {
  private client: Client | null = null;
  private connectionPromise: Promise<Client> | null = null;
  private subscriptions: Map<string, { id: string; callbacks: Set<BackendStompCallback> }> = new Map();
  private isConnecting = false;
  // Track WS handshake failures (close before onConnect). After MAX_FAILURES we
  // deactivate the client so we stop spamming the gateway with 401s every 5 s
  // for the rest of the tab's lifetime. resetForRetry() clears this so a manual
  // sign-in / focus event can try again.
  private failureCount = 0;
  private successSinceActivate = false;
  private static readonly MAX_FAILURES = 3;
  private authBroken = false;
  // Each Client created by doConnect() captures its own epoch in closure;
  // callbacks (onConnect / onWebSocketClose / onStompError) arriving from
  // an obsolete Client (e.g. one superseded after a token refresh that
  // recreated the client) are silently discarded. Without this guard the
  // detached Client kept firing onWebSocketClose into the shared singleton
  // failureCount, producing "stopping reconnect loop 3, 4, 5" in the same
  // millisecond from three different live Clients piling up.
  private activeClientId = 0;

  constructor() {
    // A backend deploy drops the WS three times in a row → authBroken latches
    // and the service stays dead for the tab's lifetime. Focus / online are
    // the natural "user is back, infra is probably back" signals to retry.
    if (typeof window !== 'undefined') {
      const retry = () => {
        if (this.authBroken && this.subscriptions.size > 0) {
          console.log('[BackendSTOMP] focus/online — retrying after auth-broken stop');
          this.resetForRetry();
          void this.connect().catch(() => {});
        }
      };
      window.addEventListener('focus', retry);
      window.addEventListener('online', retry);
    }
  }

  private getWebSocketUrl(): string {
    if (typeof window !== 'undefined') {
      const hostname = window.location.hostname;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

      if (hostname === 'scrapalot.app' || hostname === 'www.scrapalot.app' || hostname === 'api.scrapalot.app' || hostname.endsWith('.scrapalot.app')) {
        return `${protocol}//api.scrapalot.app/stomp-backend/ws`;
      }

      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return `${protocol}//${hostname}:8091/stomp-backend/ws`;
      }

      return `${protocol}//${hostname}/stomp-backend/ws`;
    }

    return 'ws://localhost:8091/stomp-backend/ws';
  }

  private getToken(): string | null {
    // Tokens live in localStorage when the user opted into "Remember me"
    // and in sessionStorage otherwise (api.ts:1741-1744). Reading only
    // one of the two leaves session-storage users with a STOMP that
    // never finds a token — they hit the "No token / waiting 2s" loop
    // forever despite being logged in. Match the read pattern used by
    // api.ts and api-subscriptions.ts.
    try {
      const stored =
        localStorage.getItem('auth_tokens') ||
        sessionStorage.getItem('auth_tokens');
      if (stored) {
        const tokens = JSON.parse(stored);
        return tokens.access_token || null;
      }
    } catch {
      // ignore
    }
    return null;
  }

  private isTokenExpired(token: string, bufferSeconds = 60): boolean {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (!payload.exp) return false;
      return Date.now() >= (payload.exp - bufferSeconds) * 1000;
    } catch {
      return true;
    }
  }

  private async doConnect(): Promise<Client> {
    this.isConnecting = true;

    // Tear down any prior Client. stompjs Client objects own their own
    // internal reconnect loop after a WS close — without an explicit
    // deactivate() they keep firing onWebSocketClose long after we've
    // moved on, which is what corrupted the shared failureCount.
    const previousClient = this.client;
    this.client = null;
    if (previousClient) {
      void previousClient.deactivate();
    }
    const myEpoch = ++this.activeClientId;

    let token = this.getToken();

    // If no token, wait briefly and retry (token might be setting after OAuth redirect)
    if (!token) {
      console.warn('[BackendSTOMP] No token yet, waiting 2s...');
      await new Promise(r => setTimeout(r, 2000));
      token = this.getToken();
    }

    // If token is expired, try to refresh
    if (token && this.isTokenExpired(token)) {
      console.warn('[BackendSTOMP] Token expired, refreshing...');
      try {
        await refreshToken();
        token = this.getToken();
      } catch {
        console.error('[BackendSTOMP] Token refresh failed');
      }
    }

    if (!token) {
      console.error('[BackendSTOMP] No auth token available');
      this.isConnecting = false;
      this.connectionPromise = null;
      throw new Error('No auth token');
    }

    const wsUrl = this.getWebSocketUrl();
    const urlWithToken = `${wsUrl}?token=${encodeURIComponent(token)}`;
    console.log('[BackendSTOMP] Connecting to:', wsUrl);

    return new Promise<Client>((resolve, reject) => {
      const client = new Client({
        brokerURL: urlWithToken,
        connectHeaders: {
          Authorization: `Bearer ${token}`,
        },
        heartbeatIncoming: 10000,
        heartbeatOutgoing: 10000,
        reconnectDelay: 5000,
        beforeConnect: async () => {
          // Refresh token before each reconnect attempt. If it is missing or
          // can't be refreshed, deactivate the client — otherwise stompjs
          // will keep banging on the gateway with an expired query-param
          // token every 5 s and produce 401-handshake spam in scrapalot-gw.
          let freshToken = this.getToken();
          if (freshToken && this.isTokenExpired(freshToken)) {
            try {
              await refreshToken();
              freshToken = this.getToken();
            } catch {
              freshToken = null;
            }
          }
          if (!freshToken) {
            console.warn('[BackendSTOMP] beforeConnect: no usable token, stopping reconnect loop');
            this.authBroken = true;
            // Deactivate without awaiting so we don't deadlock the connect callback.
            void client.deactivate();
            return;
          }
          client.brokerURL = `${wsUrl}?token=${encodeURIComponent(freshToken)}`;
          client.connectHeaders = { Authorization: `Bearer ${freshToken}` };
        },
        onConnect: () => {
          if (myEpoch !== this.activeClientId) {
            // Superseded by a fresher Client (e.g. a re-entrant connect()
            // after token refresh). Bow out so we don't claim the slot.
            void client.deactivate();
            return;
          }
          console.log('[BackendSTOMP] Connected to Kotlin backend');
          this.client = client;
          this.isConnecting = false;
          this.failureCount = 0;
          this.successSinceActivate = true;
          this.authBroken = false;
          this.resubscribeAll();
          resolve(client);
        },
        onStompError: (frame) => {
          if (myEpoch !== this.activeClientId) {
            void client.deactivate();
            return;
          }
          console.error('[BackendSTOMP] STOMP Error:', frame.headers?.message);
          this.isConnecting = false;
          this.connectionPromise = null;
          reject(new Error(frame.headers?.message || 'STOMP error'));
        },
        onWebSocketClose: (evt) => {
          if (myEpoch !== this.activeClientId) {
            // Stale Client from an earlier doConnect() iteration. Don't
            // pollute the singleton's failure counter with its leftovers.
            return;
          }
          console.warn('[BackendSTOMP] WebSocket closed, code:', evt?.code, 'reason:', evt?.reason);
          this.client = null;
          this.connectionPromise = null;
          this.isConnecting = false;
          // A close that arrived before any successful onConnect is an auth /
          // handshake failure (gateway → backend returned 401, browser surfaces
          // it as code 1006). Count those; after 3 we stop the reconnect loop.
          if (!this.successSinceActivate) {
            this.failureCount += 1;
            if (this.failureCount >= BackendStompService.MAX_FAILURES) {
              console.warn(
                '[BackendSTOMP] %d consecutive handshake failures — stopping reconnect loop',
                this.failureCount,
              );
              this.authBroken = true;
              void client.deactivate();
            }
          }
          this.successSinceActivate = false;
        },
        onWebSocketError: (evt) => {
          if (myEpoch !== this.activeClientId) return;
          console.error('[BackendSTOMP] WebSocket error:', evt);
        },
      });

      this.successSinceActivate = false;
      client.activate();
    });
  }

  async connect(): Promise<Client> {
    if (this.client?.connected) return this.client;
    if (this.connectionPromise) return this.connectionPromise;
    if (this.authBroken) {
      throw new Error('Backend STOMP auth broken — call resetForRetry() after re-login');
    }

    this.connectionPromise = this.doConnect();

    return this.connectionPromise;
  }

  /**
   * Clear the auth-broken flag and failure counter so the next subscribe()
   * or send() can re-attempt a fresh connection. Call after the user has
   * re-authenticated (login event, focus event, refreshed token, etc.).
   */
  resetForRetry(): void {
    this.failureCount = 0;
    this.authBroken = false;
  }

  /**
   * UNSUBSCRIBE only makes sense on a live connection; on a dead one the
   * broker already forgot the subscription. stompjs Client.unsubscribe()
   * throws TypeError("There is no underlying STOMP connection") when the
   * WS is down — and the cleanup closures below run inside React effect
   * cleanup, where a synchronous throw escalates to the nearest
   * ErrorBoundary (full-screen crash). Always go through this guard.
   */
  private safeUnsubscribe(id: string): void {
    const client = this.client;
    if (!client?.connected) return;
    try {
      client.unsubscribe(id);
    } catch (e) {
      console.warn('[BackendSTOMP] unsubscribe failed:', e);
    }
  }

  async subscribe(destination: string, callback: BackendStompCallback): Promise<() => void> {
    const client = await this.connect();

    const existing = this.subscriptions.get(destination);
    if (existing) {
      existing.callbacks.add(callback);
      return () => {
        existing.callbacks.delete(callback);
        if (existing.callbacks.size === 0) {
          this.safeUnsubscribe(existing.id);
          this.subscriptions.delete(destination);
        }
      };
    }

    const sub = client.subscribe(destination, (message) => {
      try {
        const body = JSON.parse(message.body);
        const entry = this.subscriptions.get(destination);
        entry?.callbacks.forEach(cb => cb(body));
      } catch (e) {
        console.error('[BackendSTOMP] Parse error:', e);
      }
    });

    this.subscriptions.set(destination, {
      id: sub.id,
      callbacks: new Set([callback]),
    });

    return () => {
      const entry = this.subscriptions.get(destination);
      if (entry) {
        entry.callbacks.delete(callback);
        if (entry.callbacks.size === 0) {
          this.safeUnsubscribe(entry.id);
          this.subscriptions.delete(destination);
        }
      }
    };
  }

  async send(destination: string, body: Record<string, unknown>): Promise<void> {
    const client = await this.connect();
    if (!client.connected) {
      // WS can drop between connect() resolving a cached client and publish;
      // surface a regular Error instead of stompjs' TypeError.
      throw new Error(`[BackendSTOMP] Not connected, cannot send to ${destination}`);
    }
    client.publish({
      destination,
      body: JSON.stringify(body),
    });
  }

  private resubscribeAll(): void {
    if (!this.client?.connected) return;

    const entries = Array.from(this.subscriptions.entries());
    for (const [destination, entry] of entries) {
      const sub = this.client.subscribe(destination, (message) => {
        try {
          const body = JSON.parse(message.body);
          const current = this.subscriptions.get(destination);
          current?.callbacks.forEach(cb => cb(body));
        } catch (e) {
          console.error('[BackendSTOMP] Parse error on resubscribe:', e);
        }
      });
      entry.id = sub.id;
    }
  }

  disconnect(): void {
    // Bump epoch so any in-flight Client's callbacks become no-ops the
    // moment we tell it to deactivate. Otherwise the closure-captured
    // myEpoch would still match this.activeClientId and the stale
    // Client could fire one last onWebSocketClose into our counters.
    this.activeClientId += 1;
    if (this.client) {
      void this.client.deactivate();
      this.client = null;
    }
    this.connectionPromise = null;
    this.subscriptions.clear();
    this.failureCount = 0;
    this.successSinceActivate = false;
    this.authBroken = false;
  }
}

const backendStompService = new BackendStompService();
export default backendStompService;
