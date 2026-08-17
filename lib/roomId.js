// URL-safe, unambiguous alphabet (no 0/o/1/l confusion)
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Generate a random room id, e.g. "k7x2qm" (browser crypto). */
export function newRoomId(length = 6) {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < length; i++) id += ALPHABET[bytes[i] % ALPHABET.length];
  return id;
}
