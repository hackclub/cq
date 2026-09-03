import crypto from "node:crypto";

const COLUMNS = 64;
const ROWS = 48;
const CHANNELS = 3;
const HEADER = Buffer.from("CQWM");
const TILE_COLUMNS = 16;
const TILE_ROWS = 24;
const PAGE_CODES = ["/admin", "/admin/users", "/admin/projects", "/admin/reviews", "/admin/funding", "/admin/orders", "/admin/shop", "/admin/countries", "/admin/notifications", "/admin/audit"];

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

function layout(size) {
  const result = Array.from({ length: size }, (_, index) => index);
  let state = crypto.createHash("sha256").update("CQWM2-tile-layout").digest(); let offset = 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    if (offset + 4 > state.length) { state = crypto.createHash("sha256").update(state).digest(); offset = 0; }
    const other = state.readUInt32BE(offset) % (index + 1); offset += 4;
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

const positions = layout(TILE_COLUMNS * TILE_ROWS * CHANNELS);

function pageCode(page) {
  const matched = PAGE_CODES.findIndex((candidate) => page === candidate || (candidate !== "/admin" && page.startsWith(`${candidate}/`)));
  return Math.max(0, matched);
}

function issue(config, user, session, page) {
  const suffix = String(user.id).replace(/^user_/, "");
  if (!/^[a-f0-9]{24}$/i.test(suffix)) throw new Error("Internal frequency identity is invalid.");
  const header = Buffer.alloc(10);
  HEADER.copy(header); header.writeUInt8(3, 4); header.writeUInt32BE(Math.floor(Date.now() / 1000), 5); header.writeUInt8(pageCode(page), 9);
  const unsigned = Buffer.concat([header, Buffer.from(suffix, "hex")]);
  return Buffer.concat([unsigned, crypto.sign(null, unsigned, config.internalFrequencyKey)]);
}

function cellsFor(payload) {
  const stream = bits(payload);
  if (stream.length > positions.length) throw new Error("Internal frequency data exceeds grid capacity.");
  const cells = Array.from({ length: COLUMNS * ROWS }, () => ({ fill: 0, line: 0, dot: 0 }));
  for (let tileRow = 0; tileRow < ROWS / TILE_ROWS; tileRow += 1) for (let tileColumn = 0; tileColumn < COLUMNS / TILE_COLUMNS; tileColumn += 1) {
    stream.forEach((value, index) => {
      const position = positions[index]; const localCell = Math.floor(position / CHANNELS);
      const row = tileRow * TILE_ROWS + Math.floor(localCell / TILE_COLUMNS); const column = tileColumn * TILE_COLUMNS + (localCell % TILE_COLUMNS);
      cells[row * COLUMNS + column][["fill", "line", "dot"][position % CHANNELS]] = value;
    });
  }
  return { columns: COLUMNS, rows: ROWS, cells };
}

export function createInternalFrequency(config, user, session, page) {
  if (!config.internalFrequencyKey || !user || !session || !page.startsWith("/admin")) return null;
  return cellsFor(issue(config, user, session, page));
}
