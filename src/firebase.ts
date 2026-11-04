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
