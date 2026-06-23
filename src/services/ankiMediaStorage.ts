import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from '../firebase';

export async function uploadAnkiMedia(
  userId: string,
  filename: string,
  data: Uint8Array,
  mimeType: string,
): Promise<string> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const path = `anki-media/${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, data, { contentType: mimeType });
  return getDownloadURL(storageRef);
}
