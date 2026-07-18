export function bufferToBlobPart(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return bytes;
}
