import { Client, StompSubscription } from '@stomp/stompjs';
import { getAuthHeaders, refreshToken } from './api';

// Type definitions
export interface StompMessage {
  jobId?: string;
  documentId?: string;
  progress?: number;
  message?: string;
  status?: string;
  [key: string]: unknown;
}

export interface StompSubscriptionCallback {
  (message: StompMessage): void;
}

class StompService {
  private client: Client | null = null;
  private subscriptions: Map<string, StompSubscription> = new Map();
  private connectionPromise: Promise<Client> | null = null;
  private subscribers: Map<string, Set<StompSubscriptionCallback>> = new Map();
  private isConnecting = false;

  private getWebSocketUrl(): string {
    // Check if we're in a browser environment
    if (typeof window !== 'undefined') {
      const hostname = window.location.hostname;
      const port = window.location.port;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

      // Production domains - use backend API subdomain
      if (hostname === 'scrapalot.app' || hostname === 'www.scrapalot.app' || hostname === 'api.scrapalot.app' || hostname.endsWith('.scrapalot.app')) {
        return `${protocol}//api.scrapalot.app/stomp-direct/ws`;
      }

      // Localhost development - use port 8090 (Python AI backend)
      // Using /stomp-direct/ws as the mounted /stomp app has CORS issues
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return `${protocol}//${hostname}:8090/stomp-direct/ws`;
      }

      // Docker/internal network detection
      // If accessing through proxy/gateway, explicitly connect to Python AI backend
      // Check if we're in Docker environment (internal IPs or specific ports)
      const isDockerEnvironment =
        hostname.startsWith('172.') || // Docker internal network
        port === '3000' ||              // Frontend dev port
        port === '80' || port === '443'; // Production proxy ports

      if (isDockerEnvironment) {
        // In Docker, we need to connect to the Python AI backend service
        // This assumes the frontend can reach scrapalot-chat on port 8090
        // If you get connection errors, check Docker networking
        console.warn('STOMP: Docker environment detected, attempting direct connection to Python AI backend');
        return `${protocol}//${hostname}:8090/stomp-direct/ws`;
      }

      // For other production domains, use current host with port if available
      const hostWithPort = port ? `${hostname}:${port}` : hostname;
      return `${protocol}//${hostWithPort}/stomp-direct/ws`;
    }

    // Fallback for non-browser environments
    return 'ws://localhost:8090/stomp-direct/ws';
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

  private async getValidToken(): Promise<string> {
    try {
      // Get auth headers, which should include the token
      const headers = getAuthHeaders();
      const authHeader = (headers as Record<string, string>)['Authorization'] || '';

      // Extract the token from the Authorization header
      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);

        // If token is expired or about to expire, refresh it first
        if (this.isTokenExpired(token)) {
          console.debug('STOMP: Token expired or expiring soon, refreshing');
          const refreshed = await refreshToken();
          if (refreshed?.access_token) {
            return refreshed.access_token;
          }
          console.error('STOMP: Token refresh failed');
          return '';
        }

        return token;
      }

      // If we don't have a proper token format, log an error
      console.error('Invalid token format in auth headers');
      return '';
    } catch (error) {
      console.error('Error getting valid token:', error);
      return '';
    }
  }

  private async doConnect(): Promise<Client> {
    // Get a valid token for authentication
    const token = await this.getValidToken();

    if (!token) {
      this.isConnecting = false;
      this.connectionPromise = null;
      throw new Error('STOMP: No auth token available, skipping connection');
    }

    try {

      // Build WebSocket URL using helper (handles api.scrapalot.app routing)
      const wsUrl = this.getWebSocketUrl();

      return new Promise<Client>((resolve, reject) => {
        // Create STOMP client using native WebSocket with token in URL.
        // Use stompjs built-in reconnect (matches stomp-backend-service.ts)
        // — the previous custom backoff capped at 5 attempts (30s window)
        // and permanently gave up after that, leaving the service silently
        // dead through any network blip longer than 30 seconds.
        const client: Client = new Client({
          brokerURL: token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl,
          connectHeaders: {
            Authorization: token ? `Bearer ${token}` : '',
          },
          beforeConnect: async () => {
            // Refresh token on every (re)connect so an expired token
            // doesn't permanently kill the connection. getValidToken()
            // refreshes via the api.ts axios interceptor when needed.
            const freshToken = await this.getValidToken();
            if (freshToken) {
              client.brokerURL = `${wsUrl}?token=${encodeURIComponent(freshToken)}`;
              client.connectHeaders = { Authorization: `Bearer ${freshToken}` };
            }
          },
          debug: function (str) {
            // Filter out noisy PING/PONG heartbeat messages
            if (str.includes('>>> PING') || str.includes('<<< PONG') || str.includes('Received data')) {
              return;
            }
            console.debug('STOMP: ' + str);
          },
          reconnectDelay: 5000, // Built-in reconnect every 5s, retries forever until deactivate()
          heartbeatIncoming: 4000,
          heartbeatOutgoing: 4000,
        });
        this.client = client;

        // Handle connection events
        this.client.onConnect = () => {
          this.isConnecting = false;

          // Restore all previous subscriptions
          this.restoreSubscriptions();

          resolve(this.client!);
        };

        // Server (FastAPI websocket_manager) tags MESSAGE frames with
        // `subscription:<destination>` instead of `subscription:<sub-id>`,
        // so stompjs's _subscriptions[id] lookup returns undefined and the
        // user callback never fires. Fall through onUnhandledMessage and
        // dispatch by destination via our own subscribers Map. This is the
        // root cause of the "live progress sits frozen" bug.
        this.client.onUnhandledMessage = (message: { body: string; headers: Record<string, string> }) => {
          const dest = message.headers?.destination;
          if (!dest) return;
          const callbacks = this.subscribers.get(dest);
          if (!callbacks || callbacks.size === 0) return;
          let body: unknown;
          try {
            body = JSON.parse(message.body);
          } catch (parseError) {
            console.error(`STOMP: onUnhandledMessage parse error for ${dest}`, parseError);
            return;
          }
          callbacks.forEach(cb => {
            try {
              cb(body);
            } catch (callbackError) {
              console.error(`STOMP: onUnhandledMessage callback error for ${dest}`, callbackError);
            }
          });
        };

        this.client.onStompError = frame => {
          console.error('STOMP: Error', frame);
          this.isConnecting = false;
          reject(new Error(`STOMP error: ${frame.headers['message']}`));
        };

        this.client.onWebSocketClose = evt => {
          console.warn('STOMP: WebSocket closed', evt);
          // stompjs handles reconnection via reconnectDelay; just clear
          // our pending-promise state so the next connect() call starts
          // fresh if needed.
          this.isConnecting = false;
          this.connectionPromise = null;
          if (evt.code === 1006) {
            console.warn('STOMP: Abnormal closure (1006), built-in reconnect will retry every 5s');
          }
        };

        this.client.activate();
      });
    } catch (error) {
      console.error('STOMP: Connection error', error);
      this.isConnecting = false;
      this.connectionPromise = null;
      throw error;
    }
  }

  public async connect(): Promise<Client> {
    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    if (this.client?.connected) {
      return Promise.resolve(this.client);
    }

    this.isConnecting = true;

    this.connectionPromise = this.doConnect();

    return this.connectionPromise;
  }

  private restoreSubscriptions() {
    if (!this.client?.connected) return;

    // Re-subscribe to all previous topics
    for (const [destination, callbacks] of this.subscribers.entries()) {
      if (callbacks.size > 0) {
        this.subscribeInternal(destination);
      }
    }
  }

  private subscribeInternal(destination: string): StompSubscription | null {
    if (!this.client?.connected) {
      console.warn(`STOMP: Cannot subscribe to ${destination}, not connected`);
      return null;
    }

    try {
      // If a previous subscription exists for this destination, unsubscribe
      // it first so we don't end up with multiple stompjs sub-N callbacks
      // racing for the same broker subscription. Without this, restoreSubscriptions
      // on reconnect (and any duplicate subscribe call) creates a new sub-N
      // and the broker keeps tagging MESSAGE frames with the OLDEST id —
      // its handler closes over a stale `this.subscribers` reference if the
      // service instance was ever replaced (HMR / module reload), and the
      // user's callback never fires.
      const existing = this.subscriptions.get(destination);
      if (existing) {
        try {
          existing.unsubscribe();
        } catch (unsubErr) {
          console.warn(`STOMP: failed to clean up prior subscription for ${destination}`, unsubErr);
        }
        this.subscriptions.delete(destination);
      }

      const subscription = this.client.subscribe(destination, message => {
        try {
          const body = JSON.parse(message.body);
          console.debug(`STOMP: dispatching ${destination} → ${this.subscribers.get(destination)?.size ?? 0} subscribers`);

          // Notify all subscribers for this destination
          const callbacks = this.subscribers.get(destination);
          if (callbacks) {
            callbacks.forEach(callback => {
              try {
                callback(body);
              } catch (callbackError) {
                console.error(
                  `STOMP: Error in subscriber callback for ${destination}`,
                  callbackError
                );
              }
            });
          }
        } catch (parseError) {
          console.error(
            `STOMP: Error parsing message for ${destination}`,
            parseError
          );
        }
      });

      this.subscriptions.set(destination, subscription);
      return subscription;
    } catch (error) {
      console.error(`STOMP: Error subscribing to ${destination}`, error);
      return null;
    }
  }

  public async subscribe(
    destination: string,
    callback: StompSubscriptionCallback
  ): Promise<() => void> {
    try {
      // Ensure we're connected
      await this.connect();

      // Add the callback to our subscribers map
      if (!this.subscribers.has(destination)) {
        this.subscribers.set(destination, new Set());
      }

      this.subscribers.get(destination)!.add(callback);

      // Create the subscription if it doesn't exist
      if (!this.subscriptions.has(destination)) {
        this.subscribeInternal(destination);
      }

      // Return an unsubscribe function
      return () => {
        this.unsubscribe(destination, callback);
      };
    } catch (error) {
      console.error(`STOMP: Failed to subscribe to ${destination}`, error);
      return () => { }; // Return empty function on error
    }
  }

  public unsubscribe(destination: string, callback: StompSubscriptionCallback) {
    // Remove the callback from our subscribers
    const callbacks = this.subscribers.get(destination);
    if (callbacks) {
      callbacks.delete(callback);

      // If no more callbacks for this destination, unsubscribe completely
      if (callbacks.size === 0) {
        const subscription = this.subscriptions.get(destination);
        if (subscription) {
          try {
            subscription.unsubscribe();
          } catch (error) {
            console.error(
              `STOMP: Error unsubscribing from ${destination}`,
              error
            );
          }
          this.subscriptions.delete(destination);
        }
        this.subscribers.delete(destination);
      }
    }
  }

  public async subscribeToUserJobs(
    userId: string,
    callback: StompSubscriptionCallback
  ): Promise<() => void> {
    return this.subscribe(`/topic/user.${userId}.jobs`, callback);
  }

  public async subscribeToWorkspaceNotifications(
    userId: string,
    callback: StompSubscriptionCallback
  ): Promise<() => void> {
    return this.subscribe(`/topic/user.${userId}.workspaces`, callback);
  }

  public async send(destination: string, body: Record<string, unknown>): Promise<void> {
    try {
      // Ensure we're connected
      await this.connect();
    } catch (error) {
      console.error(`STOMP: Error sending to ${destination}`, error);
      throw error;
    }

    if (!this.client?.connected) {
      throw new Error('STOMP: Not connected');
    }

    try {
      this.client.publish({
        destination,
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      console.error(`STOMP: Error sending to ${destination}`, error);
      throw error;
    }
  }

  public disconnect() {
    console.debug('STOMP: Disconnecting and cleaning up');

    if (this.client) {
      // Clear all subscriptions
      this.subscriptions.forEach(subscription => {
        try {
          subscription.unsubscribe();
        } catch (error) {
          console.error('STOMP: Error unsubscribing', error);
        }
      });

      this.subscriptions.clear();
      this.subscribers.clear();

      try {
        void this.client.deactivate(); // Stops the built-in reconnect loop
      } catch (error) {
        console.error('STOMP: Error disconnecting', error);
      }

      this.client = null;
    }

    this.isConnecting = false;
    this.connectionPromise = null;
  }

  // Reset connection state to allow fresh connection attempt
  public reset() {
    console.debug('STOMP: Resetting connection state');
    this.disconnect();
  }
}

// Singleton instance
const stompService = new StompService();
export default stompService;
