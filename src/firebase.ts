import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore, memoryLocalCache, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import firebaseConfig from '../firebase-applet-config.json';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const storage = getStorage(app);

function createFirestore() {
  const initialize = (settings: Parameters<typeof initializeFirestore>[1]) => (
    firebaseConfig.firestoreDatabaseId === '(default)'
      ? initializeFirestore(app, settings)
      : initializeFirestore(app, settings, firebaseConfig.firestoreDatabaseId)
  );

  try {
    return initialize({
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    return initialize({ localCache: memoryLocalCache() });
  }
}

// Use default database if id is (default), otherwise specify the id.
export const db = createFirestore();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  /** Firestore/JS SDK error code, e.g. 'permission-denied' — never user identifiers. */
  code: string;
  operationType: OperationType;
  path: string | null;
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  // Log only the error code/message plus the operation and path. User
  // identifiers (uid, email, provider info) must never reach the console log.
  const code = (error as { code?: unknown } | null)?.code;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    code: typeof code === 'string' ? code : 'unknown',
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
