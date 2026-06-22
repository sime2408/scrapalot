import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface DatabaseOperation {
  timestamp: Date;
  operation: string;
  table?: string;
  details: string;
  database: 'postgresql' | 'neo4j';
}

export class DatabaseMonitor extends EventEmitter {
  private pgProcess: ChildProcess | null = null;
  private neo4jProcess: ChildProcess | null = null;
  private operations: DatabaseOperation[] = [];
  private isMonitoring: boolean = false;

  constructor() {
    super();
  }

  /**
   * Start monitoring both PostgreSQL and Neo4j
   */
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      throw new Error('Database monitoring already active');
    }

    this.isMonitoring = true;
    this.operations = [];

    try {
      await Promise.all([
        this.startPostgreSQLMonitoring(),
        this.startNeo4jMonitoring()
      ]);
      
      console.log('🗄️ Started database monitoring for PostgreSQL and Neo4j');
    } catch (error) {
      console.error('❌ Failed to start database monitoring:', error);
      this.isMonitoring = false;
      throw error;
    }
  }

  /**
   * Monitor PostgreSQL operations via Docker logs
   */
  private async startPostgreSQLMonitoring(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Monitor PostgreSQL container logs for SQL operations
      this.pgProcess = spawn('docker', [
        'logs',
        '--follow',
        '--timestamps',
        'pgvector' // Adjust container name if different
      ]);

      this.pgProcess.stdout?.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.parsePgLogLine(line);
        }
      });

      this.pgProcess.stderr?.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.parsePgLogLine(line);
        }
      });

      this.pgProcess.on('error', (error) => {
        console.error('PostgreSQL monitoring error:', error);
        reject(error);
      });

      this.pgProcess.on('spawn', () => {
        console.log('📊 PostgreSQL monitoring started');
        resolve();
      });
    });
  }

  /**
   * Monitor Neo4j operations via Docker logs
   */
  private async startNeo4jMonitoring(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Monitor Neo4j container logs for Cypher operations
      this.neo4jProcess = spawn('docker', [
        'logs',
        '--follow',
        '--timestamps',
        'neo4j' // Adjust container name if different
      ]);

      this.neo4jProcess.stdout?.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.parseNeo4jLogLine(line);
        }
      });

      this.neo4jProcess.stderr?.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.parseNeo4jLogLine(line);
        }
      });

      this.neo4jProcess.on('error', (error) => {
        console.error('Neo4j monitoring error:', error);
        reject(error);
      });

      this.neo4jProcess.on('spawn', () => {
        console.log('🕸️ Neo4j monitoring started');
        resolve();
      });
    });
  }

  /**
   * Parse PostgreSQL log lines for database operations
   */
  private parsePgLogLine(line: string): void {
    // PostgreSQL log patterns to monitor
    const patterns = [
      // INSERT operations
      { pattern: /INSERT INTO (\w+)/i, operation: 'INSERT' },
      // UPDATE operations  
      { pattern: /UPDATE (\w+)/i, operation: 'UPDATE' },
      // SELECT operations
      { pattern: /SELECT.*FROM (\w+)/i, operation: 'SELECT' },
      // CREATE operations
      { pattern: /CREATE (?:TABLE|INDEX) (\w+)/i, operation: 'CREATE' },
      // Embedding-specific operations
      { pattern: /scrapalot_embedding/i, operation: 'EMBEDDING_OP' },
      // Document operations
      { pattern: /documents.*INSERT|INSERT.*documents/i, operation: 'DOCUMENT_INSERT' },
      // Collection operations
      { pattern: /collections.*INSERT|INSERT.*collections/i, operation: 'COLLECTION_OP' },
      // Vector operations
      { pattern: /vector.*INSERT|INSERT.*vector/i, operation: 'VECTOR_INSERT' }
    ];

    for (const { pattern, operation } of patterns) {
      const match = line.match(pattern);
      if (match) {
        const dbOp: DatabaseOperation = {
          timestamp: this.extractTimestamp(line),
          operation,
          table: match[1] || 'unknown',
          details: line.substring(line.indexOf(' ') + 1), // Remove timestamp
          database: 'postgresql'
        };
        
        this.operations.push(dbOp);
        this.emit('operation', dbOp);
        break;
      }
    }

    // Also capture general SQL activity
    if (line.includes('LOG:') && (line.includes('SELECT') || line.includes('INSERT') || line.includes('UPDATE'))) {
      const dbOp: DatabaseOperation = {
        timestamp: this.extractTimestamp(line),
        operation: 'SQL_ACTIVITY',
        details: line.substring(line.indexOf(' ') + 1),
        database: 'postgresql'
      };
      
      this.operations.push(dbOp);
      this.emit('operation', dbOp);
    }
  }

  /**
   * Parse Neo4j log lines for graph operations
   */
  private parseNeo4jLogLine(line: string): void {
    // Neo4j log patterns to monitor
    const patterns = [
      // Cypher CREATE operations
      { pattern: /CREATE \((\w+)(?:\:(\w+))?\)/i, operation: 'CREATE_NODE' },
      // Cypher MERGE operations
      { pattern: /MERGE \((\w+)(?:\:(\w+))?\)/i, operation: 'MERGE_NODE' },
      // Cypher MATCH operations
      { pattern: /MATCH \((\w+)(?:\:(\w+))?\)/i, operation: 'MATCH' },
      // Relationship creation
      { pattern: /CREATE.*-\[(\w+)(?:\:(\w+))?\]-/i, operation: 'CREATE_RELATIONSHIP' },
      // Document nodes
      { pattern: /Document|Paragraph|Book|Collection/i, operation: 'SCRAPALOT_NODE' },
      // Transaction start/commit
      { pattern: /BEGIN|COMMIT/i, operation: 'TRANSACTION' }
    ];

    for (const { pattern, operation } of patterns) {
      const match = line.match(pattern);
      if (match) {
        const dbOp: DatabaseOperation = {
          timestamp: this.extractTimestamp(line),
          operation,
          table: match[2] || match[1] || 'graph',
          details: line.substring(line.indexOf(' ') + 1),
          database: 'neo4j'
        };
        
        this.operations.push(dbOp);
        this.emit('operation', dbOp);
        break;
      }
    }

    // Capture Cypher query execution
    if (line.includes('Cypher') || line.includes('CALL') || line.includes('WITH')) {
      const dbOp: DatabaseOperation = {
        timestamp: this.extractTimestamp(line),
        operation: 'CYPHER_QUERY',
        details: line.substring(line.indexOf(' ') + 1),
        database: 'neo4j'
      };
      
      this.operations.push(dbOp);
      this.emit('operation', dbOp);
    }
  }

  /**
   * Extract timestamp from Docker log line
   */
  private extractTimestamp(line: string): Date {
    const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/);
    if (timestampMatch) {
      return new Date(timestampMatch[1]);
    }
    return new Date();
  }

  /**
   * Get all operations for a specific database
   */
  getOperations(database?: 'postgresql' | 'neo4j'): DatabaseOperation[] {
    if (database) {
      return this.operations.filter(op => op.database === database);
    }
    return [...this.operations];
  }

  /**
   * Get operations within a time range
   */
  getOperationsSince(since: Date): DatabaseOperation[] {
    return this.operations.filter(op => op.timestamp >= since);
  }

  /**
   * Search for specific operation types
   */
  searchOperations(pattern: string | RegExp): DatabaseOperation[] {
    const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
    return this.operations.filter(op => 
      regex.test(op.operation) || regex.test(op.details) || (op.table && regex.test(op.table))
    );
  }

  /**
   * Get summary of operations by type
   */
  getOperationSummary(): Record<string, number> {
    const summary: Record<string, number> = {};
    
    for (const op of this.operations) {
      const key = `${op.database}_${op.operation}`;
      summary[key] = (summary[key] || 0) + 1;
    }
    
    return summary;
  }

  /**
   * Wait for specific database operations to occur
   */
  async waitForOperations(
    pattern: string | RegExp,
    database?: 'postgresql' | 'neo4j',
    timeout: number = 30000
  ): Promise<DatabaseOperation[]> {
    return new Promise((resolve, reject) => {
      const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
      const matchedOps: DatabaseOperation[] = [];
      
      const timeoutId = setTimeout(() => {
        this.off('operation', operationHandler);
        if (matchedOps.length > 0) {
          resolve(matchedOps);
        } else {
          reject(new Error(`Timeout waiting for database operations: ${pattern}`));
        }
      }, timeout);

      const operationHandler = (operation: DatabaseOperation) => {
        const matches = (
          (regex.test(operation.operation) || regex.test(operation.details) || 
           (operation.table && regex.test(operation.table))) &&
          (!database || operation.database === database)
        );
        
        if (matches) {
          matchedOps.push(operation);
          
          // For some operations, we might want to wait for multiple
          // For others, one might be enough
          if (matchedOps.length >= 1) {
            clearTimeout(timeoutId);
            this.off('operation', operationHandler);
            resolve(matchedOps);
          }
        }
      };

      this.on('operation', operationHandler);
    });
  }

  /**
   * Clear stored operations
   */
  clearOperations(): void {
    this.operations = [];
  }

  /**
   * Stop monitoring
   */
  async stopMonitoring(): Promise<void> {
    if (!this.isMonitoring) {
      return;
    }

    this.isMonitoring = false;

    if (this.pgProcess) {
      this.pgProcess.kill('SIGTERM');
      this.pgProcess = null;
    }

    if (this.neo4jProcess) {
      this.neo4jProcess.kill('SIGTERM');
      this.neo4jProcess = null;
    }

    console.log('🔚 Database monitoring stopped');
  }

  /**
   * Get monitoring status
   */
  isActive(): boolean {
    return this.isMonitoring;
  }

  /**
   * Print operation summary
   */
  printSummary(): void {
    const summary = this.getOperationSummary();
    const pgOps = this.getOperations('postgresql');
    const neo4jOps = this.getOperations('neo4j');
    
    console.log('\n🗄️ Database Operations Summary:');
    console.log('=' .repeat(50));
    console.log(`PostgreSQL operations: ${pgOps.length}`);
    console.log(`Neo4j operations: ${neo4jOps.length}`);
    console.log(`Total operations: ${this.operations.length}`);
    console.log('\nOperation breakdown:');
    
    for (const [key, count] of Object.entries(summary)) {
      console.log(`  ${key}: ${count}`);
    }
    
    if (this.operations.length > 0) {
      console.log('\nRecent operations:');
      const recent = this.operations.slice(-5);
      for (const op of recent) {
        console.log(`  [${op.database}] ${op.operation}: ${op.details.substring(0, 80)}...`);
      }
    }
    
    console.log('=' .repeat(50));
  }

  /**
   * Verify context expansion specific operations
   */
  verifyContextExpansion(): {
    documentProcessing: boolean;
    chunkingOperations: boolean;
    embeddingStorage: boolean;
    graphNodeCreation: boolean;
    summary: string[];
  } {
    const issues: string[] = [];
    
    // Check for document processing
    const documentOps = this.searchOperations(/document.*insert|insert.*document/i);
    const documentProcessing = documentOps.length > 0;
    if (!documentProcessing) {
      issues.push('No document insertion operations detected');
    }
    
    // Check for chunking operations (embeddings table)
    const chunkOps = this.searchOperations(/embedding|chunk|vector/i);
    const chunkingOperations = chunkOps.length > 0;
    if (!chunkingOperations) {
      issues.push('No chunking/embedding operations detected');
    }
    
    // Check for vector storage
    const vectorOps = this.searchOperations(/scrapalot_embedding|vector.*insert/i);
    const embeddingStorage = vectorOps.length > 0;
    if (!embeddingStorage) {
      issues.push('No vector embedding storage detected');
    }
    
    // Check for graph operations
    const graphOps = this.getOperations('neo4j');
    const graphNodeCreation = graphOps.length > 0;
    if (!graphNodeCreation) {
      issues.push('No Neo4j graph operations detected');
    }
    
    return {
      documentProcessing,
      chunkingOperations,
      embeddingStorage,
      graphNodeCreation,
      summary: issues
    };
  }
}

/**
 * Global singleton instance for easy usage across tests
 */
export const databaseMonitor = new DatabaseMonitor();