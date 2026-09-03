import crypto from "node:crypto";

const COLUMNS = 64;
const ROWS = 48;
const CHANNELS = 3;
const HEADER = Buffer.from("CQWM");

function bytes(value, limit) {
  const result = Buffer.from(String(value || "").trim(), "utf8");
  if (!result.length || result.length > limit) throw new Error("Internal frequency data is invalid.");
  return result;
}

function bits(input) {
  const result = [];
  for (const byte of input) for (let shift = 7; shift >= 0; shift -= 1) result.push((byte >> shift) & 1);
  return result;
}

function layout() {
  const result = Array.from({ length: COLUMNS * ROWS * CHANNELS }, (_, index) => index);
  let state = crypto.createHash("sha256").update("CQWM1-grid-layout").digest(); let offset = 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    if (offset + 4 > state.length) { state = crypto.createHash("sha256").update(state).digest(); offset = 0; }
    const other = state.readUInt32BE(offset) % (index + 1); offset += 4;
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

const positions = layout();

function issue(config, user, session, page) {
  const userId = bytes(user.id, 64); const name = bytes(user.name, 96); const path = bytes(page, 64);
  const nonce = Buffer.from(String(session.id).slice(0, 16), "base64url");
  const header = Buffer.alloc(13);
  HEADER.copy(header); header.writeUInt8(1, 4); header.writeUInt32BE(Math.floor(Date.now() / 1000), 5);
  header.writeUInt8(userId.length, 9); header.writeUInt8(name.length, 10); header.writeUInt8(path.length, 11); header.writeUInt8(nonce.length, 12);
  const unsigned = Buffer.concat([header, userId, name, path, nonce]);
  return Buffer.concat([unsigned, crypto.sign(null, unsigned, config.internalFrequencyKey)]);
}

function cellsFor(payload) {
  const length = Buffer.alloc(2); length.writeUInt16BE(payload.length);
  const stream = bits(Buffer.concat([length, payload]));
  if (stream.length * 3 > positions.length) throw new Error("Internal frequency data exceeds grid capacity.");
  const cells = Array.from({ length: COLUMNS * ROWS }, () => ({ fill: 0, line: 0, dot: 0 }));
  stream.forEach((value, index) => {
    for (let copy = 0; copy < 3; copy += 1) {
      const position = positions[index * 3 + copy];
      cells[Math.floor(position / CHANNELS)][["fill", "line", "dot"][position % CHANNELS]] = value;
    }
  });
  return { columns: COLUMNS, rows: ROWS, cells };
}

export function createInternalFrequency(config, user, session, page) {
  if (!config.internalFrequencyKey || !user || !session || !page.startsWith("/admin")) return null;
  return cellsFor(issue(config, user, session, page));
}
