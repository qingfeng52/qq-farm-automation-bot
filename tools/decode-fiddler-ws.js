#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const cryptoWasm = require('../core/src/utils/crypto-wasm');

function usage() {
    console.error('Usage: node tools/decode-fiddler-ws.js <raw_ws_txt> [output_json] [--raw-values]');
    process.exit(1);
}

const showRawValues = process.argv.includes('--raw-values');
const positionalArgs = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const inputPath = positionalArgs[0];
const outputPath = positionalArgs[1];
if (!inputPath) {
    usage();
}

const raw = fs.readFileSync(inputPath);

function readHeaders(buffer, offset) {
    const marker = Buffer.from('\r\n\r\n', 'latin1');
    const end = buffer.indexOf(marker, offset);
    if (end < 0) {
        return null;
    }
    const headerText = buffer.subarray(offset, end).toString('latin1');
    const headers = {};
    for (const line of headerText.split(/\r\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0) {
            continue;
        }
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return { headers, nextOffset: end + marker.length };
}

function parseFiddlerMessages(buffer) {
    const messages = [];
    let offset = 0;
    while (offset < buffer.length) {
        const parsed = readHeaders(buffer, offset);
        if (!parsed) {
            break;
        }
        const { headers, nextOffset } = parsed;
        const requestLength = Number(headers['Request-Length'] || 0);
        const responseLength = Number(headers['Response-Length'] || 0);
        const length = requestLength || responseLength;
        if (!length) {
            break;
        }
        const payload = buffer.subarray(nextOffset, nextOffset + length);
        messages.push({
            id: Number(headers.ID || messages.length + 1),
            direction: requestLength ? 'C->S' : 'S->C',
            at: headers.DoneRead || headers.DoneSend || '',
            rawLength: length,
            payload,
        });
        offset = nextOffset + length;
    }
    return messages;
}

function unframeWebSocket(buffer) {
    const frames = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
        const first = buffer[offset++];
        const second = buffer[offset++];
        const opcode = first & 0x0f;
        const masked = Boolean(second & 0x80);
        let length = second & 0x7f;
        if (length === 126) {
            if (offset + 2 > buffer.length) {
                throw new Error('truncated websocket extended length');
            }
            length = buffer.readUInt16BE(offset);
            offset += 2;
        } else if (length === 127) {
            if (offset + 8 > buffer.length) {
                throw new Error('truncated websocket extended length');
            }
            const value = buffer.readBigUInt64BE(offset);
            if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error('websocket frame too large');
            }
            length = Number(value);
            offset += 8;
        }
        let mask;
        if (masked) {
            if (offset + 4 > buffer.length) {
                throw new Error('truncated websocket mask');
            }
            mask = buffer.subarray(offset, offset + 4);
            offset += 4;
        }
        if (offset + length > buffer.length) {
            throw new Error('truncated websocket payload');
        }
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        offset += length;
        if (masked) {
            for (let i = 0; i < payload.length; i++) {
                payload[i] ^= mask[i % 4];
            }
        }
        frames.push({ opcode, payload });
    }
    return frames;
}

function readVarint(buffer, offset) {
    let value = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < buffer.length) {
        const byte = BigInt(buffer[pos++]);
        value |= (byte & 0x7fn) << shift;
        if ((byte & 0x80n) === 0n) {
            return { value, offset: pos };
        }
        shift += 7n;
        if (shift > 70n) {
            throw new Error('varint too long');
        }
    }
    throw new Error('truncated varint');
}

function toSafeNumber(value) {
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number(value);
    }
    return value.toString();
}

function parseFields(buffer, limitFields = 200) {
    const fields = [];
    let offset = 0;
    while (offset < buffer.length && fields.length < limitFields) {
        const tag = readVarint(buffer, offset);
        offset = tag.offset;
        const fieldNo = Number(tag.value >> 3n);
        const wireType = Number(tag.value & 7n);
        const field = { fieldNo, wireType };
        if (wireType === 0) {
            const item = readVarint(buffer, offset);
            offset = item.offset;
            field.value = toSafeNumber(item.value);
        } else if (wireType === 1) {
            field.value = formatHex(buffer.subarray(offset, offset + 8));
            offset += 8;
        } else if (wireType === 2) {
            const item = readVarint(buffer, offset);
            offset = item.offset;
            const length = Number(item.value);
            const bytes = buffer.subarray(offset, offset + length);
            offset += length;
            field.length = length;
            if (isProbablyText(bytes)) {
                field.text = formatText(bytes.toString('utf8'));
            } else if (length <= 32) {
                field.hex = formatHex(bytes);
            } else {
                field.hexPrefix = formatHex(bytes.subarray(0, 32), length);
            }
        } else if (wireType === 5) {
            field.value = formatHex(buffer.subarray(offset, offset + 4));
            offset += 4;
        } else {
            field.error = `unsupported wire type ${wireType}`;
            break;
        }
        fields.push(field);
    }
    return fields;
}

function formatHex(buffer, originalLength = buffer.length) {
    if (showRawValues) {
        return buffer.toString('hex');
    }
    return `<redacted ${originalLength} bytes>`;
}

function formatText(text) {
    if (showRawValues) {
        return text;
    }
    const redacted = text
        .replace(/https?:\/\/\S+/gi, '[URL]')
        .replace(/\b\d{5,}\b/g, '[ID]')
        .replace(/[A-Fa-f0-9]{24,}/g, '[HEX]');
    return redacted.length > 80 ? `${redacted.slice(0, 80)}...` : redacted;
}

function isProbablyText(buffer) {
    if (!buffer.length) {
        return false;
    }
    const text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) {
        return false;
    }
    let printable = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code === 9 || code === 10 || code === 13 || code >= 32) {
            printable++;
        }
    }
    return printable / text.length > 0.9;
}

function decodeGateMessage(buffer) {
    const result = { bodyLength: 0 };
    let offset = 0;
    while (offset < buffer.length) {
        const tag = readVarint(buffer, offset);
        offset = tag.offset;
        const fieldNo = Number(tag.value >> 3n);
        const wireType = Number(tag.value & 7n);
        if (wireType !== 2) {
            break;
        }
        const len = readVarint(buffer, offset);
        offset = len.offset;
        const length = Number(len.value);
        const bytes = buffer.subarray(offset, offset + length);
        offset += length;
        if (fieldNo === 1) {
            result.meta = decodeGateMeta(bytes);
        } else if (fieldNo === 2) {
            result.bodyLength = length;
            result._bodyBytes = bytes;
            result.bodyHexPrefix = formatHex(bytes.subarray(0, 24), length);
            result.bodyFields = parseFields(bytes, 30);
        }
    }
    return result;
}

function decodeGateMeta(buffer) {
    const meta = {};
    let offset = 0;
    while (offset < buffer.length) {
        const tag = readVarint(buffer, offset);
        offset = tag.offset;
        const fieldNo = Number(tag.value >> 3n);
        const wireType = Number(tag.value & 7n);
        if (wireType === 0) {
            const item = readVarint(buffer, offset);
            offset = item.offset;
            const value = toSafeNumber(item.value);
            if (fieldNo === 3) meta.messageType = value;
            else if (fieldNo === 4) meta.clientSeq = value;
            else if (fieldNo === 5) meta.serverSeq = value;
            else if (fieldNo === 6) meta.errorCode = value;
            else meta[`field_${fieldNo}`] = value;
        } else if (wireType === 2) {
            const item = readVarint(buffer, offset);
            offset = item.offset;
            const length = Number(item.value);
            const bytes = buffer.subarray(offset, offset + length);
            offset += length;
            if (fieldNo === 1) meta.serviceName = bytes.toString('utf8');
            else if (fieldNo === 2) meta.methodName = bytes.toString('utf8');
            else if (fieldNo === 7) meta.errorMessage = bytes.toString('utf8');
            else if (fieldNo === 8) {
                meta.metadataCount = (meta.metadataCount || 0) + 1;
            } else {
                meta[`field_${fieldNo}`] = `<${length} bytes>`;
            }
        } else {
            meta[`field_${fieldNo}`] = `<wire ${wireType}>`;
            break;
        }
    }
    return meta;
}

async function main() {
    const messages = parseFiddlerMessages(raw);
    const decoded = [];
    for (const message of messages) {
        try {
            for (const frame of unframeWebSocket(message.payload)) {
                const gate = frame.opcode === 2 ? decodeGateMessage(frame.payload) : null;
                if (gate && gate._bodyBytes && message.direction === 'C->S') {
                    try {
                        const decrypted = await cryptoWasm.decryptBuffer(gate._bodyBytes);
                        gate.bodyEncoding = 'encrypted-tsdk';
                        gate.bodyHexPrefix = formatHex(decrypted.subarray(0, 24), decrypted.length);
                        gate.bodyFields = parseFields(decrypted, 30);
                    } catch (error) {
                        gate.bodyDecodeError = error.message;
                    }
                } else if (gate && gate._bodyBytes) {
                    gate.bodyEncoding = 'plain';
                }
                if (gate) {
                    delete gate._bodyBytes;
                }
                decoded.push({
                    id: message.id,
                    direction: message.direction,
                    at: message.at,
                    rawLength: message.rawLength,
                    opcode: frame.opcode,
                    wsPayloadLength: frame.payload.length,
                    ...gate,
                });
            }
        } catch (error) {
            decoded.push({
                id: message.id,
                direction: message.direction,
                at: message.at,
                rawLength: message.rawLength,
                error: error.message,
            });
        }
    }

    const serviceCounts = {};
    for (const item of decoded) {
        const meta = item.meta || {};
        const key = `${meta.serviceName || '(unknown)'}.${meta.methodName || '(unknown)'}`;
        serviceCounts[key] = (serviceCounts[key] || 0) + 1;
    }

    const report = {
        input: path.resolve(inputPath),
        fiddlerMessageCount: messages.length,
        websocketFrameCount: decoded.length,
        serviceCounts,
        frames: decoded,
    };

    if (outputPath) {
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }

    for (const item of decoded) {
        const meta = item.meta || {};
        const service = meta.serviceName || '(unknown)';
        const method = meta.methodName || '(unknown)';
        const seq = meta.clientSeq || meta.serverSeq || '';
        const err = meta.errorCode ? ` error=${meta.errorCode}:${meta.errorMessage || ''}` : '';
        const body = item.bodyEncoding ? ` body=${item.bodyLength || 0}/${item.bodyEncoding}` : ` body=${item.bodyLength || 0}`;
        console.log(`${String(item.id).padStart(3, ' ')} ${item.direction.padEnd(4)} type=${meta.messageType || '?'} seq=${seq} ${service}.${method}${body}${err}`);
    }

    console.error(`\nDecoded ${decoded.length} websocket frames from ${messages.length} Fiddler messages.`);
    if (outputPath) {
        console.error(`Wrote ${path.resolve(outputPath)}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
