import { version } from './Constants';

export const STORES = {
  TERRAIN: 'terrain',
  ENVIRONMENT: 'environment',
  PREVIEWS: 'environment-icons',
  SETTINGS: 'settings',
  CUSTOM_BLOCKS: 'custom-blocks',
  CUSTOM_MODELS: 'custom-models',
  UNDO: 'undo-states',
  REDO: 'redo-states'
};

export class DatabaseManager {
  static DB_NAME = 'hytopia-world-editor-' + version;
  static DB_VERSION = 1;  // Incremented version number
  static dbConnection = null;  // Add static property to store connection

  static async openDB() {
    // Return existing connection if available
    if (this.dbConnection) {
      return Promise.resolve(this.dbConnection);
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.dbConnection = request.result;
        resolve(request.result);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Create all stores if they don't exist
        Object.values(STORES).forEach(storeName => {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName);
          }
        });
      };
    });
  }

  /// provides the existing connection or opens a new one if it doesn't exist
  static async getConnection() {
    if (!this.dbConnection || this.dbConnection.closed) {
      this.dbConnection = await this.openDB();
    }
    return this.dbConnection;
  }

  /// Get direct access to the database connection
  /// Used for more efficient direct operations
  static async getDBConnection() {
    return this.getConnection();
  }

  static async saveData(storeName, key, data) {
    const db = await this.getConnection();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(data, key);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  static async getData(storeName, key) {
    try {
      const db = await this.getConnection();
      return new Promise((resolve, reject) => {
        try {
          const transaction = db.transaction(storeName, 'readonly');
          const store = transaction.objectStore(storeName);
          const request = store.get(key);
          
          request.onerror = (event) => {
            console.error(`Error retrieving data from ${storeName} with key ${key}:`, event.target.error);
            resolve(null); // Return null instead of rejecting
          };
          
          request.onsuccess = () => {
            // Always return a valid value even if result is undefined
            resolve(request.result !== undefined ? request.result : null);
          };
        } catch (innerError) {
          console.error(`Exception during read transaction for ${storeName}:`, innerError);
          resolve(null); // Return null instead of rejecting
        }
      });
    } catch (error) {
      console.error(`Error accessing store ${storeName} for reading:`, error);
      return null; // Return null instead of throwing
    }
  }

  static async deleteData(storeName, key) {
    const db = await this.getConnection();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  static async clearStore(storeName) {
    try {
      const db = await this.getConnection();
      
      // Check if store exists
      if (!db.objectStoreNames.contains(storeName)) {
        console.log(`Store ${storeName} does not exist, skipping clear`);
        return;
      }

      return new Promise((resolve, reject) => {
        try {
          const transaction = db.transaction(storeName, 'readwrite');
          const store = transaction.objectStore(storeName);
          const request = store.clear();
          
          request.onerror = (event) => {
            console.error(`Error clearing store ${storeName}:`, event.target.error);
            // Resolve anyway to continue with other stores
            resolve();
          };
          
          request.onsuccess = () => {
            console.log(`Successfully cleared store: ${storeName}`);
            resolve();
          };
          
          // Add transaction error handler
          transaction.onerror = (event) => {
            console.error(`Transaction error clearing store ${storeName}:`, event.target.error);
            // Resolve anyway to continue with other stores
            resolve();
          };
        } catch (innerError) {
          console.error(`Exception during transaction setup for ${storeName}:`, innerError);
          // Resolve anyway to continue with other stores
          resolve();
        }
      });
    } catch (error) {
      console.error(`Error accessing store ${storeName}:`, error);
      // Return resolved promise to continue with other stores
      return Promise.resolve();
    }
  }

  static async clearDatabase() {
    // Show confirmation dialog
    const confirmed = window.confirm("Warning: This will clear all data including the terrain, environment, and custom blocks. \n\nAre you sure you want to continue?");
    
    if (!confirmed) {
      return; // User cancelled the operation
    }

    try {
      console.log("Starting database clearing process...");
      
      // Set a global flag to indicate database clearing in progress
      // This can be checked by beforeUnload handlers to avoid accessing cleared data
      window.IS_DATABASE_CLEARING = true;
      
      let clearedStores = 0;
      
      // Clear all stores sequentially
      for (const storeName of Object.values(STORES)) {
        try {
          await this.clearStore(storeName);
          clearedStores++;
          console.log(`Cleared store ${storeName} (${clearedStores}/${Object.values(STORES).length})`);
        } catch (storeError) {
          console.error(`Failed to clear store ${storeName}, continuing with others:`, storeError);
          // Continue with other stores regardless of individual failures
        }
      }
      
      console.log(`Database clearing complete. Cleared ${clearedStores}/${Object.values(STORES).length} stores.`);
      
      // Remove any beforeunload handlers temporarily to prevent them from running
      const existingBeforeUnloadHandler = window.onbeforeunload;
      window.onbeforeunload = null;
      
      // Wait a short delay before reloading to ensure any pending operations complete
      setTimeout(() => {
        try {
          // Reload the page to start fresh
          window.location.href = window.location.href;
        } catch (reloadError) {
          console.error('Error during reload:', reloadError);
          alert('Database cleared, but there was an error refreshing the page. Please refresh manually.');
        }
      }, 100);
    } catch (error) {
      window.IS_DATABASE_CLEARING = false; // Reset the flag
      console.error('Unhandled error during database clearing:', error);
      alert('There was an error clearing the database. Please check the console for details.');
    }
  }
}
