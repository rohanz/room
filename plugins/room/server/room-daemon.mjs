#!/usr/bin/env node
import { createRequire as __roomCreateRequire } from 'node:module'; import { fileURLToPath as __roomFileURLToPath } from 'node:url'; import { dirname as __roomDirname } from 'node:path'; const require = __roomCreateRequire(import.meta.url); const __filename = __roomFileURLToPath(import.meta.url); const __dirname = __roomDirname(__filename);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to2, from2, except, desc) => {
  if (from2 && typeof from2 === "object" || typeof from2 === "function") {
    for (let key of __getOwnPropNames(from2))
      if (!__hasOwnProp.call(to2, key) && key !== except)
        __defProp(to2, key, { get: () => from2[key], enumerable: !(desc = __getOwnPropDesc(from2, key)) || desc.enumerable });
  }
  return to2;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/lib0/math.js
var floor, abs, min, max, isNaN, isNegativeZero;
var init_math = __esm({
  "node_modules/lib0/math.js"() {
    "use strict";
    floor = Math.floor;
    abs = Math.abs;
    min = (a, b) => a < b ? a : b;
    max = (a, b) => a > b ? a : b;
    isNaN = Number.isNaN;
    isNegativeZero = (n) => n !== 0 ? n < 0 : 1 / n < 0;
  }
});

// node_modules/lib0/binary.js
var BIT1, BIT2, BIT3, BIT4, BIT6, BIT7, BIT8, BIT18, BIT19, BIT20, BIT21, BIT22, BIT23, BIT24, BIT25, BIT26, BIT27, BIT28, BIT29, BIT30, BIT31, BIT32, BITS5, BITS6, BITS7, BITS17, BITS18, BITS19, BITS20, BITS21, BITS22, BITS23, BITS24, BITS25, BITS26, BITS27, BITS28, BITS29, BITS30, BITS31;
var init_binary = __esm({
  "node_modules/lib0/binary.js"() {
    "use strict";
    BIT1 = 1;
    BIT2 = 2;
    BIT3 = 4;
    BIT4 = 8;
    BIT6 = 32;
    BIT7 = 64;
    BIT8 = 128;
    BIT18 = 1 << 17;
    BIT19 = 1 << 18;
    BIT20 = 1 << 19;
    BIT21 = 1 << 20;
    BIT22 = 1 << 21;
    BIT23 = 1 << 22;
    BIT24 = 1 << 23;
    BIT25 = 1 << 24;
    BIT26 = 1 << 25;
    BIT27 = 1 << 26;
    BIT28 = 1 << 27;
    BIT29 = 1 << 28;
    BIT30 = 1 << 29;
    BIT31 = 1 << 30;
    BIT32 = 1 << 31;
    BITS5 = 31;
    BITS6 = 63;
    BITS7 = 127;
    BITS17 = BIT18 - 1;
    BITS18 = BIT19 - 1;
    BITS19 = BIT20 - 1;
    BITS20 = BIT21 - 1;
    BITS21 = BIT22 - 1;
    BITS22 = BIT23 - 1;
    BITS23 = BIT24 - 1;
    BITS24 = BIT25 - 1;
    BITS25 = BIT26 - 1;
    BITS26 = BIT27 - 1;
    BITS27 = BIT28 - 1;
    BITS28 = BIT29 - 1;
    BITS29 = BIT30 - 1;
    BITS30 = BIT31 - 1;
    BITS31 = 2147483647;
  }
});

// node_modules/lib0/number.js
var MAX_SAFE_INTEGER, MIN_SAFE_INTEGER, LOWEST_INT32, isInteger, isNaN2, parseInt;
var init_number = __esm({
  "node_modules/lib0/number.js"() {
    "use strict";
    init_math();
    MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
    MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
    LOWEST_INT32 = 1 << 31;
    isInteger = Number.isInteger || ((num) => typeof num === "number" && isFinite(num) && floor(num) === num);
    isNaN2 = Number.isNaN;
    parseInt = Number.parseInt;
  }
});

// node_modules/lib0/set.js
var create;
var init_set = __esm({
  "node_modules/lib0/set.js"() {
    "use strict";
    create = () => /* @__PURE__ */ new Set();
  }
});

// node_modules/lib0/array.js
var last, appendTo, from, isArray;
var init_array = __esm({
  "node_modules/lib0/array.js"() {
    "use strict";
    last = (arr) => arr[arr.length - 1];
    appendTo = (dest, src) => {
      for (let i = 0; i < src.length; i++) {
        dest.push(src[i]);
      }
    };
    from = Array.from;
    isArray = Array.isArray;
  }
});

// node_modules/lib0/string.js
var fromCharCode, fromCodePoint, MAX_UTF16_CHARACTER, toLowerCase, trimLeftRegex, trimLeft, fromCamelCaseRegex, fromCamelCase, _encodeUtf8Polyfill, utf8TextEncoder, _encodeUtf8Native, encodeUtf8, utf8TextDecoder;
var init_string = __esm({
  "node_modules/lib0/string.js"() {
    "use strict";
    fromCharCode = String.fromCharCode;
    fromCodePoint = String.fromCodePoint;
    MAX_UTF16_CHARACTER = fromCharCode(65535);
    toLowerCase = (s) => s.toLowerCase();
    trimLeftRegex = /^\s*/g;
    trimLeft = (s) => s.replace(trimLeftRegex, "");
    fromCamelCaseRegex = /([A-Z])/g;
    fromCamelCase = (s, separator) => trimLeft(s.replace(fromCamelCaseRegex, (match) => `${separator}${toLowerCase(match)}`));
    _encodeUtf8Polyfill = (str) => {
      const encodedString = unescape(encodeURIComponent(str));
      const len = encodedString.length;
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        buf[i] = /** @type {number} */
        encodedString.codePointAt(i);
      }
      return buf;
    };
    utf8TextEncoder = /** @type {TextEncoder} */
    typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    _encodeUtf8Native = (str) => utf8TextEncoder.encode(str);
    encodeUtf8 = utf8TextEncoder ? _encodeUtf8Native : _encodeUtf8Polyfill;
    utf8TextDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    if (utf8TextDecoder && utf8TextDecoder.decode(new Uint8Array()).length === 1) {
      utf8TextDecoder = null;
    }
  }
});

// node_modules/lib0/encoding.js
var Encoder, createEncoder, length, toUint8Array, verifyLen, write, writeUint8, writeVarUint, writeVarInt, _strBuffer, _maxStrBSize, _writeVarStringNative, _writeVarStringPolyfill, writeVarString, writeUint8Array, writeVarUint8Array, writeOnDataView, writeFloat32, writeFloat64, writeBigInt64, floatTestBed, isFloat32, writeAny, RleEncoder, flushUintOptRleEncoder, UintOptRleEncoder, flushIntDiffOptRleEncoder, IntDiffOptRleEncoder, StringEncoder;
var init_encoding = __esm({
  "node_modules/lib0/encoding.js"() {
    "use strict";
    init_math();
    init_number();
    init_binary();
    init_string();
    init_array();
    Encoder = class {
      constructor() {
        this.cpos = 0;
        this.cbuf = new Uint8Array(100);
        this.bufs = [];
      }
    };
    createEncoder = () => new Encoder();
    length = (encoder3) => {
      let len = encoder3.cpos;
      for (let i = 0; i < encoder3.bufs.length; i++) {
        len += encoder3.bufs[i].length;
      }
      return len;
    };
    toUint8Array = (encoder3) => {
      const uint8arr = new Uint8Array(length(encoder3));
      let curPos = 0;
      for (let i = 0; i < encoder3.bufs.length; i++) {
        const d = encoder3.bufs[i];
        uint8arr.set(d, curPos);
        curPos += d.length;
      }
      uint8arr.set(new Uint8Array(encoder3.cbuf.buffer, 0, encoder3.cpos), curPos);
      return uint8arr;
    };
    verifyLen = (encoder3, len) => {
      const bufferLen = encoder3.cbuf.length;
      if (bufferLen - encoder3.cpos < len) {
        encoder3.bufs.push(new Uint8Array(encoder3.cbuf.buffer, 0, encoder3.cpos));
        encoder3.cbuf = new Uint8Array(max(bufferLen, len) * 2);
        encoder3.cpos = 0;
      }
    };
    write = (encoder3, num) => {
      const bufferLen = encoder3.cbuf.length;
      if (encoder3.cpos === bufferLen) {
        encoder3.bufs.push(encoder3.cbuf);
        encoder3.cbuf = new Uint8Array(bufferLen * 2);
        encoder3.cpos = 0;
      }
      encoder3.cbuf[encoder3.cpos++] = num;
    };
    writeUint8 = write;
    writeVarUint = (encoder3, num) => {
      while (num > BITS7) {
        write(encoder3, BIT8 | BITS7 & num);
        num = floor(num / 128);
      }
      write(encoder3, BITS7 & num);
    };
    writeVarInt = (encoder3, num) => {
      const isNegative = isNegativeZero(num);
      if (isNegative) {
        num = -num;
      }
      write(encoder3, (num > BITS6 ? BIT8 : 0) | (isNegative ? BIT7 : 0) | BITS6 & num);
      num = floor(num / 64);
      while (num > 0) {
        write(encoder3, (num > BITS7 ? BIT8 : 0) | BITS7 & num);
        num = floor(num / 128);
      }
    };
    _strBuffer = new Uint8Array(3e4);
    _maxStrBSize = _strBuffer.length / 3;
    _writeVarStringNative = (encoder3, str) => {
      if (str.length < _maxStrBSize) {
        const written = utf8TextEncoder.encodeInto(str, _strBuffer).written || 0;
        writeVarUint(encoder3, written);
        for (let i = 0; i < written; i++) {
          write(encoder3, _strBuffer[i]);
        }
      } else {
        writeVarUint8Array(encoder3, encodeUtf8(str));
      }
    };
    _writeVarStringPolyfill = (encoder3, str) => {
      const encodedString = unescape(encodeURIComponent(str));
      const len = encodedString.length;
      writeVarUint(encoder3, len);
      for (let i = 0; i < len; i++) {
        write(
          encoder3,
          /** @type {number} */
          encodedString.codePointAt(i)
        );
      }
    };
    writeVarString = utf8TextEncoder && /** @type {any} */
    utf8TextEncoder.encodeInto ? _writeVarStringNative : _writeVarStringPolyfill;
    writeUint8Array = (encoder3, uint8Array) => {
      const bufferLen = encoder3.cbuf.length;
      const cpos = encoder3.cpos;
      const leftCopyLen = min(bufferLen - cpos, uint8Array.length);
      const rightCopyLen = uint8Array.length - leftCopyLen;
      encoder3.cbuf.set(uint8Array.subarray(0, leftCopyLen), cpos);
      encoder3.cpos += leftCopyLen;
      if (rightCopyLen > 0) {
        encoder3.bufs.push(encoder3.cbuf);
        encoder3.cbuf = new Uint8Array(max(bufferLen * 2, rightCopyLen));
        encoder3.cbuf.set(uint8Array.subarray(leftCopyLen));
        encoder3.cpos = rightCopyLen;
      }
    };
    writeVarUint8Array = (encoder3, uint8Array) => {
      writeVarUint(encoder3, uint8Array.byteLength);
      writeUint8Array(encoder3, uint8Array);
    };
    writeOnDataView = (encoder3, len) => {
      verifyLen(encoder3, len);
      const dview = new DataView(encoder3.cbuf.buffer, encoder3.cpos, len);
      encoder3.cpos += len;
      return dview;
    };
    writeFloat32 = (encoder3, num) => writeOnDataView(encoder3, 4).setFloat32(0, num, false);
    writeFloat64 = (encoder3, num) => writeOnDataView(encoder3, 8).setFloat64(0, num, false);
    writeBigInt64 = (encoder3, num) => (
      /** @type {any} */
      writeOnDataView(encoder3, 8).setBigInt64(0, num, false)
    );
    floatTestBed = new DataView(new ArrayBuffer(4));
    isFloat32 = (num) => {
      floatTestBed.setFloat32(0, num);
      return floatTestBed.getFloat32(0) === num;
    };
    writeAny = (encoder3, data) => {
      switch (typeof data) {
        case "string":
          write(encoder3, 119);
          writeVarString(encoder3, data);
          break;
        case "number":
          if (isInteger(data) && abs(data) <= BITS31) {
            write(encoder3, 125);
            writeVarInt(encoder3, data);
          } else if (isFloat32(data)) {
            write(encoder3, 124);
            writeFloat32(encoder3, data);
          } else {
            write(encoder3, 123);
            writeFloat64(encoder3, data);
          }
          break;
        case "bigint":
          write(encoder3, 122);
          writeBigInt64(encoder3, data);
          break;
        case "object":
          if (data === null) {
            write(encoder3, 126);
          } else if (isArray(data)) {
            write(encoder3, 117);
            writeVarUint(encoder3, data.length);
            for (let i = 0; i < data.length; i++) {
              writeAny(encoder3, data[i]);
            }
          } else if (data instanceof Uint8Array) {
            write(encoder3, 116);
            writeVarUint8Array(encoder3, data);
          } else {
            write(encoder3, 118);
            const keys3 = Object.keys(data);
            writeVarUint(encoder3, keys3.length);
            for (let i = 0; i < keys3.length; i++) {
              const key = keys3[i];
              writeVarString(encoder3, key);
              writeAny(encoder3, data[key]);
            }
          }
          break;
        case "boolean":
          write(encoder3, data ? 120 : 121);
          break;
        default:
          write(encoder3, 127);
      }
    };
    RleEncoder = class extends Encoder {
      /**
       * @param {function(Encoder, T):void} writer
       */
      constructor(writer) {
        super();
        this.w = writer;
        this.s = null;
        this.count = 0;
      }
      /**
       * @param {T} v
       */
      write(v) {
        if (this.s === v) {
          this.count++;
        } else {
          if (this.count > 0) {
            writeVarUint(this, this.count - 1);
          }
          this.count = 1;
          this.w(this, v);
          this.s = v;
        }
      }
    };
    flushUintOptRleEncoder = (encoder3) => {
      if (encoder3.count > 0) {
        writeVarInt(encoder3.encoder, encoder3.count === 1 ? encoder3.s : -encoder3.s);
        if (encoder3.count > 1) {
          writeVarUint(encoder3.encoder, encoder3.count - 2);
        }
      }
    };
    UintOptRleEncoder = class {
      constructor() {
        this.encoder = new Encoder();
        this.s = 0;
        this.count = 0;
      }
      /**
       * @param {number} v
       */
      write(v) {
        if (this.s === v) {
          this.count++;
        } else {
          flushUintOptRleEncoder(this);
          this.count = 1;
          this.s = v;
        }
      }
      /**
       * Flush the encoded state and transform this to a Uint8Array.
       *
       * Note that this should only be called once.
       */
      toUint8Array() {
        flushUintOptRleEncoder(this);
        return toUint8Array(this.encoder);
      }
    };
    flushIntDiffOptRleEncoder = (encoder3) => {
      if (encoder3.count > 0) {
        const encodedDiff = encoder3.diff * 2 + (encoder3.count === 1 ? 0 : 1);
        writeVarInt(encoder3.encoder, encodedDiff);
        if (encoder3.count > 1) {
          writeVarUint(encoder3.encoder, encoder3.count - 2);
        }
      }
    };
    IntDiffOptRleEncoder = class {
      constructor() {
        this.encoder = new Encoder();
        this.s = 0;
        this.count = 0;
        this.diff = 0;
      }
      /**
       * @param {number} v
       */
      write(v) {
        if (this.diff === v - this.s) {
          this.s = v;
          this.count++;
        } else {
          flushIntDiffOptRleEncoder(this);
          this.count = 1;
          this.diff = v - this.s;
          this.s = v;
        }
      }
      /**
       * Flush the encoded state and transform this to a Uint8Array.
       *
       * Note that this should only be called once.
       */
      toUint8Array() {
        flushIntDiffOptRleEncoder(this);
        return toUint8Array(this.encoder);
      }
    };
    StringEncoder = class {
      constructor() {
        this.sarr = [];
        this.s = "";
        this.lensE = new UintOptRleEncoder();
      }
      /**
       * @param {string} string
       */
      write(string) {
        this.s += string;
        if (this.s.length > 19) {
          this.sarr.push(this.s);
          this.s = "";
        }
        this.lensE.write(string.length);
      }
      toUint8Array() {
        const encoder3 = new Encoder();
        this.sarr.push(this.s);
        this.s = "";
        writeVarString(encoder3, this.sarr.join(""));
        writeUint8Array(encoder3, this.lensE.toUint8Array());
        return toUint8Array(encoder3);
      }
    };
  }
});

// node_modules/lib0/error.js
var create2, methodUnimplemented, unexpectedCase;
var init_error = __esm({
  "node_modules/lib0/error.js"() {
    "use strict";
    create2 = (s) => new Error(s);
    methodUnimplemented = () => {
      throw create2("Method unimplemented");
    };
    unexpectedCase = () => {
      throw create2("Unexpected case");
    };
  }
});

// node_modules/lib0/decoding.js
var errorUnexpectedEndOfArray, errorIntegerOutOfRange, Decoder, createDecoder, hasContent, readUint8Array, readVarUint8Array, readUint8, readVarUint, readVarInt, peekVarUint, _readVarStringPolyfill, _readVarStringNative, readVarString, readFromDataView, readFloat32, readFloat64, readBigInt64, readAnyLookupTable, readAny, RleDecoder, UintOptRleDecoder, IntDiffOptRleDecoder, StringDecoder;
var init_decoding = __esm({
  "node_modules/lib0/decoding.js"() {
    "use strict";
    init_binary();
    init_math();
    init_number();
    init_string();
    init_error();
    errorUnexpectedEndOfArray = create2("Unexpected end of array");
    errorIntegerOutOfRange = create2("Integer out of Range");
    Decoder = class {
      /**
       * @param {Uint8Array<Buf>} uint8Array Binary data to decode
       */
      constructor(uint8Array) {
        this.arr = uint8Array;
        this.pos = 0;
      }
    };
    createDecoder = (uint8Array) => new Decoder(uint8Array);
    hasContent = (decoder) => decoder.pos !== decoder.arr.length;
    readUint8Array = (decoder, len) => {
      const view = new Uint8Array(decoder.arr.buffer, decoder.pos + decoder.arr.byteOffset, len);
      decoder.pos += len;
      return view;
    };
    readVarUint8Array = (decoder) => readUint8Array(decoder, readVarUint(decoder));
    readUint8 = (decoder) => decoder.arr[decoder.pos++];
    readVarUint = (decoder) => {
      let num = 0;
      let mult = 1;
      const len = decoder.arr.length;
      while (decoder.pos < len) {
        const r = decoder.arr[decoder.pos++];
        num = num + (r & BITS7) * mult;
        mult *= 128;
        if (r < BIT8) {
          return num;
        }
        if (num > MAX_SAFE_INTEGER) {
          throw errorIntegerOutOfRange;
        }
      }
      throw errorUnexpectedEndOfArray;
    };
    readVarInt = (decoder) => {
      let r = decoder.arr[decoder.pos++];
      let num = r & BITS6;
      let mult = 64;
      const sign = (r & BIT7) > 0 ? -1 : 1;
      if ((r & BIT8) === 0) {
        return sign * num;
      }
      const len = decoder.arr.length;
      while (decoder.pos < len) {
        r = decoder.arr[decoder.pos++];
        num = num + (r & BITS7) * mult;
        mult *= 128;
        if (r < BIT8) {
          return sign * num;
        }
        if (num > MAX_SAFE_INTEGER) {
          throw errorIntegerOutOfRange;
        }
      }
      throw errorUnexpectedEndOfArray;
    };
    peekVarUint = (decoder) => {
      const pos = decoder.pos;
      const s = readVarUint(decoder);
      decoder.pos = pos;
      return s;
    };
    _readVarStringPolyfill = (decoder) => {
      let remainingLen = readVarUint(decoder);
      if (remainingLen === 0) {
        return "";
      } else {
        let encodedString = String.fromCodePoint(readUint8(decoder));
        if (--remainingLen < 100) {
          while (remainingLen--) {
            encodedString += String.fromCodePoint(readUint8(decoder));
          }
        } else {
          while (remainingLen > 0) {
            const nextLen = remainingLen < 1e4 ? remainingLen : 1e4;
            const bytes = decoder.arr.subarray(decoder.pos, decoder.pos + nextLen);
            decoder.pos += nextLen;
            encodedString += String.fromCodePoint.apply(
              null,
              /** @type {any} */
              bytes
            );
            remainingLen -= nextLen;
          }
        }
        return decodeURIComponent(escape(encodedString));
      }
    };
    _readVarStringNative = (decoder) => (
      /** @type any */
      utf8TextDecoder.decode(readVarUint8Array(decoder))
    );
    readVarString = utf8TextDecoder ? _readVarStringNative : _readVarStringPolyfill;
    readFromDataView = (decoder, len) => {
      const dv = new DataView(decoder.arr.buffer, decoder.arr.byteOffset + decoder.pos, len);
      decoder.pos += len;
      return dv;
    };
    readFloat32 = (decoder) => readFromDataView(decoder, 4).getFloat32(0, false);
    readFloat64 = (decoder) => readFromDataView(decoder, 8).getFloat64(0, false);
    readBigInt64 = (decoder) => (
      /** @type {any} */
      readFromDataView(decoder, 8).getBigInt64(0, false)
    );
    readAnyLookupTable = [
      (decoder) => void 0,
      // CASE 127: undefined
      (decoder) => null,
      // CASE 126: null
      readVarInt,
      // CASE 125: integer
      readFloat32,
      // CASE 124: float32
      readFloat64,
      // CASE 123: float64
      readBigInt64,
      // CASE 122: bigint
      (decoder) => false,
      // CASE 121: boolean (false)
      (decoder) => true,
      // CASE 120: boolean (true)
      readVarString,
      // CASE 119: string
      (decoder) => {
        const len = readVarUint(decoder);
        const obj = {};
        for (let i = 0; i < len; i++) {
          const key = readVarString(decoder);
          obj[key] = readAny(decoder);
        }
        return obj;
      },
      (decoder) => {
        const len = readVarUint(decoder);
        const arr = [];
        for (let i = 0; i < len; i++) {
          arr.push(readAny(decoder));
        }
        return arr;
      },
      readVarUint8Array
      // CASE 116: Uint8Array
    ];
    readAny = (decoder) => readAnyLookupTable[127 - readUint8(decoder)](decoder);
    RleDecoder = class extends Decoder {
      /**
       * @param {Uint8Array} uint8Array
       * @param {function(Decoder):T} reader
       */
      constructor(uint8Array, reader) {
        super(uint8Array);
        this.reader = reader;
        this.s = null;
        this.count = 0;
      }
      read() {
        if (this.count === 0) {
          this.s = this.reader(this);
          if (hasContent(this)) {
            this.count = readVarUint(this) + 1;
          } else {
            this.count = -1;
          }
        }
        this.count--;
        return (
          /** @type {T} */
          this.s
        );
      }
    };
    UintOptRleDecoder = class extends Decoder {
      /**
       * @param {Uint8Array} uint8Array
       */
      constructor(uint8Array) {
        super(uint8Array);
        this.s = 0;
        this.count = 0;
      }
      read() {
        if (this.count === 0) {
          this.s = readVarInt(this);
          const isNegative = isNegativeZero(this.s);
          this.count = 1;
          if (isNegative) {
            this.s = -this.s;
            this.count = readVarUint(this) + 2;
          }
        }
        this.count--;
        return (
          /** @type {number} */
          this.s
        );
      }
    };
    IntDiffOptRleDecoder = class extends Decoder {
      /**
       * @param {Uint8Array} uint8Array
       */
      constructor(uint8Array) {
        super(uint8Array);
        this.s = 0;
        this.count = 0;
        this.diff = 0;
      }
      /**
       * @return {number}
       */
      read() {
        if (this.count === 0) {
          const diff = readVarInt(this);
          const hasCount = diff & 1;
          this.diff = floor(diff / 2);
          this.count = 1;
          if (hasCount) {
            this.count = readVarUint(this) + 2;
          }
        }
        this.s += this.diff;
        this.count--;
        return this.s;
      }
    };
    StringDecoder = class {
      /**
       * @param {Uint8Array} uint8Array
       */
      constructor(uint8Array) {
        this.decoder = new UintOptRleDecoder(uint8Array);
        this.str = readVarString(this.decoder);
        this.spos = 0;
      }
      /**
       * @return {string}
       */
      read() {
        const end = this.spos + this.decoder.read();
        const res = this.str.slice(this.spos, end);
        this.spos = end;
        return res;
      }
    };
  }
});

// packages/shared/src/types.ts
var init_types = __esm({
  "packages/shared/src/types.ts"() {
    "use strict";
  }
});

// packages/shared/src/identity.ts
function validParticipantName(name) {
  return name.length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(name);
}
function isAgentic(kind) {
  return kind !== void 0 && kind !== "human";
}
function displayName(id2) {
  const owner = "owner" in id2 ? id2.owner : void 0;
  const label = "label" in id2 ? id2.label : void 0;
  switch (id2.kind) {
    case "agent":
      return id2.name.includes("+") ? id2.name : `${owner ?? id2.name}'s agent`;
    case "bot":
      return `${label ?? id2.name} [bot]`;
    case "ci":
      return `${label ?? id2.name} [ci]`;
    default:
      return id2.name;
  }
}
function newId(prefix2 = "") {
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix2}${Date.now().toString(36)}${r}`;
}
var PALETTE;
var init_identity = __esm({
  "packages/shared/src/identity.ts"() {
    "use strict";
    PALETTE = ["#2e86de", "#c9761a", "#6d4fc2", "#27ae60", "#c0392b", "#b5179e", "#0f8b8d", "#8d6e63"];
  }
});

// node_modules/lib0/map.js
var create3, copy, setIfUndefined, any;
var init_map = __esm({
  "node_modules/lib0/map.js"() {
    "use strict";
    create3 = () => /* @__PURE__ */ new Map();
    copy = (m) => {
      const r = create3();
      m.forEach((v, k) => {
        r.set(k, v);
      });
      return r;
    };
    setIfUndefined = (map, key, createT) => {
      let set = map.get(key);
      if (set === void 0) {
        map.set(key, set = createT());
      }
      return set;
    };
    any = (m, f) => {
      for (const [key, value2] of m) {
        if (f(value2, key)) {
          return true;
        }
      }
      return false;
    };
  }
});

// node_modules/lib0/observable.js
var ObservableV2, Observable;
var init_observable = __esm({
  "node_modules/lib0/observable.js"() {
    "use strict";
    init_map();
    init_set();
    init_array();
    ObservableV2 = class {
      constructor() {
        this._observers = create3();
      }
      /**
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name
       * @param {EVENTS[NAME]} f
       */
      on(name, f) {
        setIfUndefined(
          this._observers,
          /** @type {string} */
          name,
          create
        ).add(f);
        return f;
      }
      /**
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name
       * @param {EVENTS[NAME]} f
       */
      once(name, f) {
        const _f = (...args3) => {
          this.off(
            name,
            /** @type {any} */
            _f
          );
          f(...args3);
        };
        this.on(
          name,
          /** @type {any} */
          _f
        );
      }
      /**
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name
       * @param {EVENTS[NAME]} f
       */
      off(name, f) {
        const observers = this._observers.get(name);
        if (observers !== void 0) {
          observers.delete(f);
          if (observers.size === 0) {
            this._observers.delete(name);
          }
        }
      }
      /**
       * Emit a named event. All registered event listeners that listen to the
       * specified name will receive the event.
       *
       * @todo This should catch exceptions
       *
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name The event name.
       * @param {Parameters<EVENTS[NAME]>} args The arguments that are applied to the event listener.
       */
      emit(name, args3) {
        return from((this._observers.get(name) || create3()).values()).forEach((f) => f(...args3));
      }
      destroy() {
        this._observers = create3();
      }
    };
    Observable = class {
      constructor() {
        this._observers = create3();
      }
      /**
       * @param {N} name
       * @param {function} f
       */
      on(name, f) {
        setIfUndefined(this._observers, name, create).add(f);
      }
      /**
       * @param {N} name
       * @param {function} f
       */
      once(name, f) {
        const _f = (...args3) => {
          this.off(name, _f);
          f(...args3);
        };
        this.on(name, _f);
      }
      /**
       * @param {N} name
       * @param {function} f
       */
      off(name, f) {
        const observers = this._observers.get(name);
        if (observers !== void 0) {
          observers.delete(f);
          if (observers.size === 0) {
            this._observers.delete(name);
          }
        }
      }
      /**
       * Emit a named event. All registered event listeners that listen to the
       * specified name will receive the event.
       *
       * @todo This should catch exceptions
       *
       * @param {N} name The event name.
       * @param {Array<any>} args The arguments that are applied to the event listener.
       */
      emit(name, args3) {
        return from((this._observers.get(name) || create3()).values()).forEach((f) => f(...args3));
      }
      destroy() {
        this._observers = create3();
      }
    };
  }
});

// node_modules/lib0/webcrypto.node.js
import { webcrypto } from "node:crypto";
var subtle, getRandomValues;
var init_webcrypto_node = __esm({
  "node_modules/lib0/webcrypto.node.js"() {
    "use strict";
    subtle = /** @type {any} */
    webcrypto.subtle;
    getRandomValues = /** @type {any} */
    webcrypto.getRandomValues.bind(webcrypto);
  }
});

// node_modules/lib0/random.js
var uint32, uuidv4Template, uuidv4;
var init_random = __esm({
  "node_modules/lib0/random.js"() {
    "use strict";
    init_webcrypto_node();
    uint32 = () => getRandomValues(new Uint32Array(1))[0];
    uuidv4Template = "10000000-1000-4000-8000" + -1e11;
    uuidv4 = () => uuidv4Template.replace(
      /[018]/g,
      /** @param {number} c */
      (c) => (c ^ uint32() & 15 >> c / 4).toString(16)
    );
  }
});

// node_modules/lib0/time.js
var getUnixTime;
var init_time = __esm({
  "node_modules/lib0/time.js"() {
    "use strict";
    getUnixTime = Date.now;
  }
});

// node_modules/lib0/promise.js
var create4, all;
var init_promise = __esm({
  "node_modules/lib0/promise.js"() {
    "use strict";
    create4 = (f) => (
      /** @type {Promise<T>} */
      new Promise(f)
    );
    all = Promise.all.bind(Promise);
  }
});

// node_modules/lib0/conditions.js
var undefinedToNull;
var init_conditions = __esm({
  "node_modules/lib0/conditions.js"() {
    "use strict";
    undefinedToNull = (v) => v === void 0 ? null : v;
  }
});

// node_modules/lib0/storage.js
var VarStoragePolyfill, _localStorage, usePolyfill, varStorage;
var init_storage = __esm({
  "node_modules/lib0/storage.js"() {
    "use strict";
    VarStoragePolyfill = class {
      constructor() {
        this.map = /* @__PURE__ */ new Map();
      }
      /**
       * @param {string} key
       * @param {any} newValue
       */
      setItem(key, newValue) {
        this.map.set(key, newValue);
      }
      /**
       * @param {string} key
       */
      getItem(key) {
        return this.map.get(key);
      }
    };
    _localStorage = new VarStoragePolyfill();
    usePolyfill = true;
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        _localStorage = localStorage;
        usePolyfill = false;
      }
    } catch (e) {
    }
    varStorage = _localStorage;
  }
});

// node_modules/lib0/trait/equality.js
var EqualityTraitSymbol, equals;
var init_equality = __esm({
  "node_modules/lib0/trait/equality.js"() {
    "use strict";
    EqualityTraitSymbol = /* @__PURE__ */ Symbol("Equality");
    equals = (a, b) => a === b || !!a?.[EqualityTraitSymbol]?.(b) || false;
  }
});

// node_modules/lib0/object.js
var assign, keys2, forEach, size, isEmpty, every, hasProperty, equalFlat, freeze2, deepFreeze;
var init_object = __esm({
  "node_modules/lib0/object.js"() {
    "use strict";
    init_equality();
    assign = Object.assign;
    keys2 = Object.keys;
    forEach = (obj, f) => {
      for (const key in obj) {
        f(obj[key], key);
      }
    };
    size = (obj) => keys2(obj).length;
    isEmpty = (obj) => {
      for (const _k in obj) {
        return false;
      }
      return true;
    };
    every = (obj, f) => {
      for (const key in obj) {
        if (!f(obj[key], key)) {
          return false;
        }
      }
      return true;
    };
    hasProperty = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    equalFlat = (a, b) => a === b || size(a) === size(b) && every(a, (val, key) => (val !== void 0 || hasProperty(b, key)) && equals(b[key], val));
    freeze2 = Object.freeze;
    deepFreeze = (o) => {
      for (const key in o) {
        const c = o[key];
        if (typeof c === "object" || typeof c === "function") {
          deepFreeze(o[key]);
        }
      }
      return freeze2(o);
    };
  }
});

// node_modules/lib0/function.js
var callAll, id, equalityDeep, isOneOf;
var init_function = __esm({
  "node_modules/lib0/function.js"() {
    "use strict";
    init_object();
    init_equality();
    callAll = (fs11, args3, i = 0) => {
      try {
        for (; i < fs11.length; i++) {
          fs11[i](...args3);
        }
      } finally {
        if (i < fs11.length) {
          callAll(fs11, args3, i + 1);
        }
      }
    };
    id = (a) => a;
    equalityDeep = (a, b) => {
      if (a === b) {
        return true;
      }
      if (a == null || b == null || a.constructor !== b.constructor && (a.constructor || Object) !== (b.constructor || Object)) {
        return false;
      }
      if (a[EqualityTraitSymbol] != null) {
        return a[EqualityTraitSymbol](b);
      }
      switch (a.constructor) {
        case ArrayBuffer:
          a = new Uint8Array(a);
          b = new Uint8Array(b);
        // eslint-disable-next-line no-fallthrough
        case Uint8Array: {
          if (a.byteLength !== b.byteLength) {
            return false;
          }
          for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
              return false;
            }
          }
          break;
        }
        case Set: {
          if (a.size !== b.size) {
            return false;
          }
          for (const value2 of a) {
            if (!b.has(value2)) {
              return false;
            }
          }
          break;
        }
        case Map: {
          if (a.size !== b.size) {
            return false;
          }
          for (const key of a.keys()) {
            if (!b.has(key) || !equalityDeep(a.get(key), b.get(key))) {
              return false;
            }
          }
          break;
        }
        case void 0:
        case Object:
          if (size(a) !== size(b)) {
            return false;
          }
          for (const key in a) {
            if (!hasProperty(a, key) || !equalityDeep(a[key], b[key])) {
              return false;
            }
          }
          break;
        case Array:
          if (a.length !== b.length) {
            return false;
          }
          for (let i = 0; i < a.length; i++) {
            if (!equalityDeep(a[i], b[i])) {
              return false;
            }
          }
          break;
        default:
          return false;
      }
      return true;
    };
    isOneOf = (value2, options) => options.includes(value2);
  }
});

// node_modules/lib0/environment.js
var isNode, isMac, params, args, computeParams, hasParam, getVariable, hasConf, production, forceColor, supportsColor;
var init_environment = __esm({
  "node_modules/lib0/environment.js"() {
    "use strict";
    init_map();
    init_string();
    init_conditions();
    init_storage();
    init_function();
    isNode = typeof process !== "undefined" && process.release && /node|io\.js/.test(process.release.name) && Object.prototype.toString.call(typeof process !== "undefined" ? process : 0) === "[object process]";
    isMac = typeof navigator !== "undefined" ? /Mac/.test(navigator.platform) : false;
    args = [];
    computeParams = () => {
      if (params === void 0) {
        if (isNode) {
          params = create3();
          const pargs = process.argv;
          let currParamName = null;
          for (let i = 0; i < pargs.length; i++) {
            const parg = pargs[i];
            if (parg[0] === "-") {
              if (currParamName !== null) {
                params.set(currParamName, "");
              }
              currParamName = parg;
            } else {
              if (currParamName !== null) {
                params.set(currParamName, parg);
                currParamName = null;
              } else {
                args.push(parg);
              }
            }
          }
          if (currParamName !== null) {
            params.set(currParamName, "");
          }
        } else if (typeof location === "object") {
          params = create3();
          (location.search || "?").slice(1).split("&").forEach((kv) => {
            if (kv.length !== 0) {
              const [key, value2] = kv.split("=");
              params.set(`--${fromCamelCase(key, "-")}`, value2);
              params.set(`-${fromCamelCase(key, "-")}`, value2);
            }
          });
        } else {
          params = create3();
        }
      }
      return params;
    };
    hasParam = (name) => computeParams().has(name);
    getVariable = (name) => isNode ? undefinedToNull(process.env[name.toUpperCase().replaceAll("-", "_")]) : undefinedToNull(varStorage.getItem(name));
    hasConf = (name) => hasParam("--" + name) || getVariable(name) !== null;
    production = hasConf("production");
    forceColor = isNode && isOneOf(process.env.FORCE_COLOR, ["true", "1", "2"]);
    supportsColor = forceColor || !hasParam("--no-colors") && // @todo deprecate --no-colors
    !hasConf("no-color") && (!isNode || process.stdout.isTTY) && (!isNode || hasParam("--color") || getVariable("COLORTERM") !== null || (getVariable("TERM") || "").includes("color"));
  }
});

// node_modules/lib0/buffer.js
var createUint8ArrayFromLen, copyUint8Array;
var init_buffer = __esm({
  "node_modules/lib0/buffer.js"() {
    "use strict";
    createUint8ArrayFromLen = (len) => new Uint8Array(len);
    copyUint8Array = (uint8Array) => {
      const newBuf = createUint8ArrayFromLen(uint8Array.byteLength);
      newBuf.set(uint8Array);
      return newBuf;
    };
  }
});

// node_modules/lib0/symbol.js
var create5;
var init_symbol = __esm({
  "node_modules/lib0/symbol.js"() {
    "use strict";
    create5 = Symbol;
  }
});

// node_modules/lib0/logging.common.js
var BOLD, UNBOLD, BLUE, GREY, GREEN, RED, PURPLE, ORANGE, UNCOLOR, computeNoColorLoggingArgs, lastLoggingTime;
var init_logging_common = __esm({
  "node_modules/lib0/logging.common.js"() {
    "use strict";
    init_symbol();
    init_time();
    BOLD = create5();
    UNBOLD = create5();
    BLUE = create5();
    GREY = create5();
    GREEN = create5();
    RED = create5();
    PURPLE = create5();
    ORANGE = create5();
    UNCOLOR = create5();
    computeNoColorLoggingArgs = (args3) => {
      if (args3.length === 1 && args3[0]?.constructor === Function) {
        args3 = /** @type {Array<string|Symbol|Object|number>} */
        /** @type {[function]} */
        args3[0]();
      }
      const strBuilder = [];
      const logArgs = [];
      let i = 0;
      for (; i < args3.length; i++) {
        const arg = args3[i];
        if (arg === void 0) {
          break;
        } else if (arg.constructor === String || arg.constructor === Number) {
          strBuilder.push(arg);
        } else if (arg.constructor === Object) {
          break;
        }
      }
      if (i > 0) {
        logArgs.push(strBuilder.join(""));
      }
      for (; i < args3.length; i++) {
        const arg = args3[i];
        if (!(arg instanceof Symbol)) {
          logArgs.push(arg);
        }
      }
      return logArgs;
    };
    lastLoggingTime = getUnixTime();
  }
});

// node_modules/lib0/logging.node.js
var _nodeStyleMap, computeNodeLoggingArgs, computeLoggingArgs, print, warn;
var init_logging_node = __esm({
  "node_modules/lib0/logging.node.js"() {
    "use strict";
    init_environment();
    init_logging_common();
    init_logging_common();
    _nodeStyleMap = {
      [BOLD]: "\x1B[1m",
      [UNBOLD]: "\x1B[2m",
      [BLUE]: "\x1B[34m",
      [GREEN]: "\x1B[32m",
      [GREY]: "\x1B[37m",
      [RED]: "\x1B[31m",
      [PURPLE]: "\x1B[35m",
      [ORANGE]: "\x1B[38;5;208m",
      [UNCOLOR]: "\x1B[0m"
    };
    computeNodeLoggingArgs = (args3) => {
      if (args3.length === 1 && args3[0]?.constructor === Function) {
        args3 = /** @type {Array<string|Symbol|Object|number>} */
        /** @type {[function]} */
        args3[0]();
      }
      const strBuilder = [];
      const logArgs = [];
      let i = 0;
      for (; i < args3.length; i++) {
        const arg = args3[i];
        const style = _nodeStyleMap[arg];
        if (style !== void 0) {
          strBuilder.push(style);
        } else {
          if (arg === void 0) {
            break;
          } else if (arg.constructor === String || arg.constructor === Number) {
            strBuilder.push(arg);
          } else {
            break;
          }
        }
      }
      if (i > 0) {
        strBuilder.push("\x1B[0m");
        logArgs.push(strBuilder.join(""));
      }
      for (; i < args3.length; i++) {
        const arg = args3[i];
        if (!(arg instanceof Symbol)) {
          logArgs.push(arg);
        }
      }
      return logArgs;
    };
    computeLoggingArgs = supportsColor ? computeNodeLoggingArgs : computeNoColorLoggingArgs;
    print = (...args3) => {
      console.log(...computeLoggingArgs(args3));
    };
    warn = (...args3) => {
      console.warn(...computeLoggingArgs(args3));
    };
  }
});

// node_modules/lib0/iterator.js
var createIterator, iteratorFilter, iteratorMap;
var init_iterator = __esm({
  "node_modules/lib0/iterator.js"() {
    "use strict";
    createIterator = (next) => ({
      /**
       * @return {IterableIterator<T>}
       */
      [Symbol.iterator]() {
        return this;
      },
      // @ts-ignore
      next
    });
    iteratorFilter = (iterator, filter) => createIterator(() => {
      let res;
      do {
        res = iterator.next();
      } while (!res.done && !filter(res.value));
      return res;
    });
    iteratorMap = (iterator, fmap) => createIterator(() => {
      const { done, value: value2 } = iterator.next();
      return { done, value: done ? void 0 : fmap(value2) };
    });
  }
});

// node_modules/yjs/dist/yjs.mjs
function* lazyStructReaderGenerator(decoder) {
  const numOfStateUpdates = readVarUint(decoder.restDecoder);
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfStructs = readVarUint(decoder.restDecoder);
    const client = decoder.readClient();
    let clock = readVarUint(decoder.restDecoder);
    for (let i2 = 0; i2 < numberOfStructs; i2++) {
      const info = decoder.readInfo();
      if (info === 10) {
        const len = readVarUint(decoder.restDecoder);
        yield new Skip(createID(client, clock), len);
        clock += len;
      } else if ((BITS5 & info) !== 0) {
        const cantCopyParentInfo = (info & (BIT7 | BIT8)) === 0;
        const struct = new Item(
          createID(client, clock),
          null,
          // left
          (info & BIT8) === BIT8 ? decoder.readLeftID() : null,
          // origin
          null,
          // right
          (info & BIT7) === BIT7 ? decoder.readRightID() : null,
          // right origin
          // @ts-ignore Force writing a string here.
          cantCopyParentInfo ? decoder.readParentInfo() ? decoder.readString() : decoder.readLeftID() : null,
          // parent
          cantCopyParentInfo && (info & BIT6) === BIT6 ? decoder.readString() : null,
          // parentSub
          readItemContent(decoder, info)
          // item content
        );
        yield struct;
        clock += struct.length;
      } else {
        const len = decoder.readLen();
        yield new GC(createID(client, clock), len);
        clock += len;
      }
    }
  }
}
var DeleteItem, DeleteSet, iterateDeletedStructs, findIndexDS, isDeleted, sortAndMergeDeleteSet, mergeDeleteSets, addToDeleteSet, createDeleteSet, createDeleteSetFromStructStore, writeDeleteSet, readDeleteSet, readAndApplyDeleteSet, generateNewClientId, Doc, DSDecoderV1, UpdateDecoderV1, DSDecoderV2, UpdateDecoderV2, DSEncoderV1, UpdateEncoderV1, DSEncoderV2, UpdateEncoderV2, writeStructs, writeClientsStructs, readClientsStructRefs, integrateStructs, writeStructsFromTransaction, readUpdateV2, applyUpdateV2, applyUpdate, writeStateAsUpdate, encodeStateAsUpdateV2, encodeStateAsUpdate, readStateVector, decodeStateVector, writeStateVector, writeDocumentStateVector, encodeStateVectorV2, encodeStateVector, EventHandler, createEventHandler, addEventHandlerListener, removeEventHandlerListener, callEventHandlerListeners, ID, compareIDs, createID, findRootTypeKey, RelativePosition, relativePositionToJSON, createRelativePositionFromJSON, AbsolutePosition, createAbsolutePosition, createRelativePosition, createRelativePositionFromTypeIndex, getItemWithOffset, createAbsolutePositionFromRelativePosition, Snapshot, createSnapshot, emptySnapshot, isVisible, splitSnapshotAffectedStructs, StructStore, getStateVector, getState, addStruct, findIndexSS, find, getItem, findIndexCleanStart, getItemCleanStart, getItemCleanEnd, replaceStruct, iterateStructs, Transaction, writeUpdateMessageFromTransaction, addChangedTypeToTransaction, tryToMergeWithLefts, tryGcDeleteSet, tryMergeDeleteSet, cleanupTransactions, transact, LazyStructReader, LazyStructWriter, mergeUpdates, sliceStruct, mergeUpdatesV2, diffUpdateV2, flushLazyStructWriter, writeStructToLazyStructWriter, finishLazyStructWriting, convertUpdateFormat, convertUpdateFormatV2ToV1, errorComputeChanges, YEvent, getPathTo, warnPrematureAccess, maxSearchMarker, globalSearchMarkerTimestamp, ArraySearchMarker, refreshMarkerTimestamp, overwriteMarker, markPosition, findMarker, updateMarkerChanges, callTypeObservers, AbstractType, typeListSlice, typeListToArray, typeListForEach, typeListMap, typeListCreateIterator, typeListGet, typeListInsertGenericsAfter, lengthExceeded, typeListInsertGenerics, typeListPushGenerics, typeListDelete, typeMapDelete, typeMapSet, typeMapGet, typeMapGetAll, typeMapHas, typeMapGetAllSnapshot, createMapIterator, YArrayEvent, YArray, readYArray, YMapEvent, YMap, readYMap, equalAttrs, ItemTextListPosition, findNextPosition, findPosition, insertNegatedAttributes, updateCurrentAttributes, minimizeAttributeChanges, insertAttributes, insertText, formatText, cleanupFormattingGap, cleanupContextlessFormattingGap, cleanupYTextFormatting, cleanupYTextAfterTransaction, deleteText, YTextEvent, YText, readYText, YXmlTreeWalker, YXmlFragment, readYXmlFragment, YXmlElement, readYXmlElement, YXmlEvent, YXmlHook, readYXmlHook, YXmlText, readYXmlText, AbstractStruct, structGCRefNumber, GC, ContentBinary, readContentBinary, ContentDeleted, readContentDeleted, createDocFromOpts, ContentDoc, readContentDoc, ContentEmbed, readContentEmbed, ContentFormat, readContentFormat, ContentJSON, readContentJSON, isDevMode, ContentAny, readContentAny, ContentString, readContentString, typeRefs, YArrayRefID, YMapRefID, YTextRefID, YXmlElementRefID, YXmlFragmentRefID, YXmlHookRefID, YXmlTextRefID, ContentType, readContentType, followRedone, splitItem, Item, readItemContent, contentRefs, structSkipRefNumber, Skip, glo, importIdentifier;
var init_yjs = __esm({
  "node_modules/yjs/dist/yjs.mjs"() {
    "use strict";
    init_observable();
    init_array();
    init_math();
    init_map();
    init_encoding();
    init_decoding();
    init_random();
    init_promise();
    init_buffer();
    init_error();
    init_binary();
    init_function();
    init_function();
    init_set();
    init_logging_node();
    init_iterator();
    init_object();
    init_environment();
    DeleteItem = class {
      /**
       * @param {number} clock
       * @param {number} len
       */
      constructor(clock, len) {
        this.clock = clock;
        this.len = len;
      }
    };
    DeleteSet = class {
      constructor() {
        this.clients = /* @__PURE__ */ new Map();
      }
    };
    iterateDeletedStructs = (transaction, ds, f) => ds.clients.forEach((deletes, clientid) => {
      const structs = (
        /** @type {Array<GC|Item>} */
        transaction.doc.store.clients.get(clientid)
      );
      if (structs != null) {
        const lastStruct = structs[structs.length - 1];
        const clockState = lastStruct.id.clock + lastStruct.length;
        for (let i = 0, del = deletes[i]; i < deletes.length && del.clock < clockState; del = deletes[++i]) {
          iterateStructs(transaction, structs, del.clock, del.len, f);
        }
      }
    });
    findIndexDS = (dis, clock) => {
      let left = 0;
      let right = dis.length - 1;
      while (left <= right) {
        const midindex = floor((left + right) / 2);
        const mid = dis[midindex];
        const midclock = mid.clock;
        if (midclock <= clock) {
          if (clock < midclock + mid.len) {
            return midindex;
          }
          left = midindex + 1;
        } else {
          right = midindex - 1;
        }
      }
      return null;
    };
    isDeleted = (ds, id2) => {
      const dis = ds.clients.get(id2.client);
      return dis !== void 0 && findIndexDS(dis, id2.clock) !== null;
    };
    sortAndMergeDeleteSet = (ds) => {
      ds.clients.forEach((dels) => {
        dels.sort((a, b) => a.clock - b.clock);
        let i, j;
        for (i = 1, j = 1; i < dels.length; i++) {
          const left = dels[j - 1];
          const right = dels[i];
          if (left.clock + left.len >= right.clock) {
            dels[j - 1] = new DeleteItem(left.clock, max(left.len, right.clock + right.len - left.clock));
          } else {
            if (j < i) {
              dels[j] = right;
            }
            j++;
          }
        }
        dels.length = j;
      });
    };
    mergeDeleteSets = (dss) => {
      const merged = new DeleteSet();
      for (let dssI = 0; dssI < dss.length; dssI++) {
        dss[dssI].clients.forEach((delsLeft, client) => {
          if (!merged.clients.has(client)) {
            const dels = delsLeft.slice();
            for (let i = dssI + 1; i < dss.length; i++) {
              appendTo(dels, dss[i].clients.get(client) || []);
            }
            merged.clients.set(client, dels);
          }
        });
      }
      sortAndMergeDeleteSet(merged);
      return merged;
    };
    addToDeleteSet = (ds, client, clock, length2) => {
      setIfUndefined(ds.clients, client, () => (
        /** @type {Array<DeleteItem>} */
        []
      )).push(new DeleteItem(clock, length2));
    };
    createDeleteSet = () => new DeleteSet();
    createDeleteSetFromStructStore = (ss) => {
      const ds = createDeleteSet();
      ss.clients.forEach((structs, client) => {
        const dsitems = [];
        for (let i = 0; i < structs.length; i++) {
          const struct = structs[i];
          if (struct.deleted) {
            const clock = struct.id.clock;
            let len = struct.length;
            if (i + 1 < structs.length) {
              for (let next = structs[i + 1]; i + 1 < structs.length && next.deleted; next = structs[++i + 1]) {
                len += next.length;
              }
            }
            dsitems.push(new DeleteItem(clock, len));
          }
        }
        if (dsitems.length > 0) {
          ds.clients.set(client, dsitems);
        }
      });
      return ds;
    };
    writeDeleteSet = (encoder3, ds) => {
      writeVarUint(encoder3.restEncoder, ds.clients.size);
      from(ds.clients.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, dsitems]) => {
        encoder3.resetDsCurVal();
        writeVarUint(encoder3.restEncoder, client);
        const len = dsitems.length;
        writeVarUint(encoder3.restEncoder, len);
        for (let i = 0; i < len; i++) {
          const item = dsitems[i];
          encoder3.writeDsClock(item.clock);
          encoder3.writeDsLen(item.len);
        }
      });
    };
    readDeleteSet = (decoder) => {
      const ds = new DeleteSet();
      const numClients = readVarUint(decoder.restDecoder);
      for (let i = 0; i < numClients; i++) {
        decoder.resetDsCurVal();
        const client = readVarUint(decoder.restDecoder);
        const numberOfDeletes = readVarUint(decoder.restDecoder);
        if (numberOfDeletes > 0) {
          const dsField = setIfUndefined(ds.clients, client, () => (
            /** @type {Array<DeleteItem>} */
            []
          ));
          for (let i2 = 0; i2 < numberOfDeletes; i2++) {
            dsField.push(new DeleteItem(decoder.readDsClock(), decoder.readDsLen()));
          }
        }
      }
      return ds;
    };
    readAndApplyDeleteSet = (decoder, transaction, store) => {
      const unappliedDS = new DeleteSet();
      const numClients = readVarUint(decoder.restDecoder);
      for (let i = 0; i < numClients; i++) {
        decoder.resetDsCurVal();
        const client = readVarUint(decoder.restDecoder);
        const numberOfDeletes = readVarUint(decoder.restDecoder);
        const structs = store.clients.get(client) || [];
        const state = getState(store, client);
        for (let i2 = 0; i2 < numberOfDeletes; i2++) {
          const clock = decoder.readDsClock();
          const clockEnd = clock + decoder.readDsLen();
          if (clock < state) {
            if (state < clockEnd) {
              addToDeleteSet(unappliedDS, client, state, clockEnd - state);
            }
            let index = findIndexSS(structs, clock);
            let struct = structs[index];
            if (!struct.deleted && struct.id.clock < clock) {
              structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock));
              index++;
            }
            while (index < structs.length) {
              struct = structs[index++];
              if (struct.id.clock < clockEnd) {
                if (!struct.deleted) {
                  if (clockEnd < struct.id.clock + struct.length) {
                    structs.splice(index, 0, splitItem(transaction, struct, clockEnd - struct.id.clock));
                  }
                  struct.delete(transaction);
                }
              } else {
                break;
              }
            }
          } else {
            addToDeleteSet(unappliedDS, client, clock, clockEnd - clock);
          }
        }
      }
      if (unappliedDS.clients.size > 0) {
        const ds = new UpdateEncoderV2();
        writeVarUint(ds.restEncoder, 0);
        writeDeleteSet(ds, unappliedDS);
        return ds.toUint8Array();
      }
      return null;
    };
    generateNewClientId = uint32;
    Doc = class _Doc extends ObservableV2 {
      /**
       * @param {DocOpts} opts configuration
       */
      constructor({ guid = uuidv4(), collectionid = null, gc = true, gcFilter = () => true, meta = null, autoLoad = false, shouldLoad = true } = {}) {
        super();
        this.gc = gc;
        this.gcFilter = gcFilter;
        this.clientID = generateNewClientId();
        this.guid = guid;
        this.collectionid = collectionid;
        this.share = /* @__PURE__ */ new Map();
        this.store = new StructStore();
        this._transaction = null;
        this._transactionCleanups = [];
        this.subdocs = /* @__PURE__ */ new Set();
        this._item = null;
        this.shouldLoad = shouldLoad;
        this.autoLoad = autoLoad;
        this.meta = meta;
        this.isLoaded = false;
        this.isSynced = false;
        this.isDestroyed = false;
        this.whenLoaded = create4((resolve) => {
          this.on("load", () => {
            this.isLoaded = true;
            resolve(this);
          });
        });
        const provideSyncedPromise = () => create4((resolve) => {
          const eventHandler = (isSynced) => {
            if (isSynced === void 0 || isSynced === true) {
              this.off("sync", eventHandler);
              resolve();
            }
          };
          this.on("sync", eventHandler);
        });
        this.on("sync", (isSynced) => {
          if (isSynced === false && this.isSynced) {
            this.whenSynced = provideSyncedPromise();
          }
          this.isSynced = isSynced === void 0 || isSynced === true;
          if (this.isSynced && !this.isLoaded) {
            this.emit("load", [this]);
          }
        });
        this.whenSynced = provideSyncedPromise();
      }
      /**
       * Notify the parent document that you request to load data into this subdocument (if it is a subdocument).
       *
       * `load()` might be used in the future to request any provider to load the most current data.
       *
       * It is safe to call `load()` multiple times.
       */
      load() {
        const item = this._item;
        if (item !== null && !this.shouldLoad) {
          transact(
            /** @type {any} */
            item.parent.doc,
            (transaction) => {
              transaction.subdocsLoaded.add(this);
            },
            null,
            true
          );
        }
        this.shouldLoad = true;
      }
      getSubdocs() {
        return this.subdocs;
      }
      getSubdocGuids() {
        return new Set(from(this.subdocs).map((doc) => doc.guid));
      }
      /**
       * Changes that happen inside of a transaction are bundled. This means that
       * the observer fires _after_ the transaction is finished and that all changes
       * that happened inside of the transaction are sent as one message to the
       * other peers.
       *
       * @template T
       * @param {function(Transaction):T} f The function that should be executed as a transaction
       * @param {any} [origin] Origin of who started the transaction. Will be stored on transaction.origin
       * @return T
       *
       * @public
       */
      transact(f, origin = null) {
        return transact(this, f, origin);
      }
      /**
       * Define a shared data type.
       *
       * Multiple calls of `ydoc.get(name, TypeConstructor)` yield the same result
       * and do not overwrite each other. I.e.
       * `ydoc.get(name, Y.Array) === ydoc.get(name, Y.Array)`
       *
       * After this method is called, the type is also available on `ydoc.share.get(name)`.
       *
       * *Best Practices:*
       * Define all types right after the Y.Doc instance is created and store them in a separate object.
       * Also use the typed methods `getText(name)`, `getArray(name)`, ..
       *
       * @template {typeof AbstractType<any>} Type
       * @example
       *   const ydoc = new Y.Doc(..)
       *   const appState = {
       *     document: ydoc.getText('document')
       *     comments: ydoc.getArray('comments')
       *   }
       *
       * @param {string} name
       * @param {Type} TypeConstructor The constructor of the type definition. E.g. Y.Text, Y.Array, Y.Map, ...
       * @return {InstanceType<Type>} The created type. Constructed with TypeConstructor
       *
       * @public
       */
      get(name, TypeConstructor = (
        /** @type {any} */
        AbstractType
      )) {
        const type = setIfUndefined(this.share, name, () => {
          const t = new TypeConstructor();
          t._integrate(this, null);
          return t;
        });
        const Constr = type.constructor;
        if (TypeConstructor !== AbstractType && Constr !== TypeConstructor) {
          if (Constr === AbstractType) {
            const t = new TypeConstructor();
            t._map = type._map;
            type._map.forEach(
              /** @param {Item?} n */
              (n) => {
                for (; n !== null; n = n.left) {
                  n.parent = t;
                }
              }
            );
            t._start = type._start;
            for (let n = t._start; n !== null; n = n.right) {
              n.parent = t;
            }
            t._length = type._length;
            this.share.set(name, t);
            t._integrate(this, null);
            return (
              /** @type {InstanceType<Type>} */
              t
            );
          } else {
            throw new Error(`Type with the name ${name} has already been defined with a different constructor`);
          }
        }
        return (
          /** @type {InstanceType<Type>} */
          type
        );
      }
      /**
       * @template T
       * @param {string} [name]
       * @return {YArray<T>}
       *
       * @public
       */
      getArray(name = "") {
        return (
          /** @type {YArray<T>} */
          this.get(name, YArray)
        );
      }
      /**
       * @param {string} [name]
       * @return {YText}
       *
       * @public
       */
      getText(name = "") {
        return this.get(name, YText);
      }
      /**
       * @template T
       * @param {string} [name]
       * @return {YMap<T>}
       *
       * @public
       */
      getMap(name = "") {
        return (
          /** @type {YMap<T>} */
          this.get(name, YMap)
        );
      }
      /**
       * @param {string} [name]
       * @return {YXmlElement}
       *
       * @public
       */
      getXmlElement(name = "") {
        return (
          /** @type {YXmlElement<{[key:string]:string}>} */
          this.get(name, YXmlElement)
        );
      }
      /**
       * @param {string} [name]
       * @return {YXmlFragment}
       *
       * @public
       */
      getXmlFragment(name = "") {
        return this.get(name, YXmlFragment);
      }
      /**
       * Converts the entire document into a js object, recursively traversing each yjs type
       * Doesn't log types that have not been defined (using ydoc.getType(..)).
       *
       * @deprecated Do not use this method and rather call toJSON directly on the shared types.
       *
       * @return {Object<string, any>}
       */
      toJSON() {
        const doc = {};
        this.share.forEach((value2, key) => {
          doc[key] = value2.toJSON();
        });
        return doc;
      }
      /**
       * Emit `destroy` event and unregister all event handlers.
       */
      destroy() {
        this.isDestroyed = true;
        from(this.subdocs).forEach((subdoc) => subdoc.destroy());
        const item = this._item;
        if (item !== null) {
          this._item = null;
          const content = (
            /** @type {ContentDoc} */
            item.content
          );
          content.doc = new _Doc({ guid: this.guid, ...content.opts, shouldLoad: false });
          content.doc._item = item;
          transact(
            /** @type {any} */
            item.parent.doc,
            (transaction) => {
              const doc = content.doc;
              if (!item.deleted) {
                transaction.subdocsAdded.add(doc);
              }
              transaction.subdocsRemoved.add(this);
            },
            null,
            true
          );
        }
        this.emit("destroyed", [true]);
        this.emit("destroy", [this]);
        super.destroy();
      }
    };
    DSDecoderV1 = class {
      /**
       * @param {decoding.Decoder} decoder
       */
      constructor(decoder) {
        this.restDecoder = decoder;
      }
      resetDsCurVal() {
      }
      /**
       * @return {number}
       */
      readDsClock() {
        return readVarUint(this.restDecoder);
      }
      /**
       * @return {number}
       */
      readDsLen() {
        return readVarUint(this.restDecoder);
      }
    };
    UpdateDecoderV1 = class extends DSDecoderV1 {
      /**
       * @return {ID}
       */
      readLeftID() {
        return createID(readVarUint(this.restDecoder), readVarUint(this.restDecoder));
      }
      /**
       * @return {ID}
       */
      readRightID() {
        return createID(readVarUint(this.restDecoder), readVarUint(this.restDecoder));
      }
      /**
       * Read the next client id.
       * Use this in favor of readID whenever possible to reduce the number of objects created.
       */
      readClient() {
        return readVarUint(this.restDecoder);
      }
      /**
       * @return {number} info An unsigned 8-bit integer
       */
      readInfo() {
        return readUint8(this.restDecoder);
      }
      /**
       * @return {string}
       */
      readString() {
        return readVarString(this.restDecoder);
      }
      /**
       * @return {boolean} isKey
       */
      readParentInfo() {
        return readVarUint(this.restDecoder) === 1;
      }
      /**
       * @return {number} info An unsigned 8-bit integer
       */
      readTypeRef() {
        return readVarUint(this.restDecoder);
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @return {number} len
       */
      readLen() {
        return readVarUint(this.restDecoder);
      }
      /**
       * @return {any}
       */
      readAny() {
        return readAny(this.restDecoder);
      }
      /**
       * @return {Uint8Array}
       */
      readBuf() {
        return copyUint8Array(readVarUint8Array(this.restDecoder));
      }
      /**
       * Legacy implementation uses JSON parse. We use any-decoding in v2.
       *
       * @return {any}
       */
      readJSON() {
        return JSON.parse(readVarString(this.restDecoder));
      }
      /**
       * @return {string}
       */
      readKey() {
        return readVarString(this.restDecoder);
      }
    };
    DSDecoderV2 = class {
      /**
       * @param {decoding.Decoder} decoder
       */
      constructor(decoder) {
        this.dsCurrVal = 0;
        this.restDecoder = decoder;
      }
      resetDsCurVal() {
        this.dsCurrVal = 0;
      }
      /**
       * @return {number}
       */
      readDsClock() {
        this.dsCurrVal += readVarUint(this.restDecoder);
        return this.dsCurrVal;
      }
      /**
       * @return {number}
       */
      readDsLen() {
        const diff = readVarUint(this.restDecoder) + 1;
        this.dsCurrVal += diff;
        return diff;
      }
    };
    UpdateDecoderV2 = class extends DSDecoderV2 {
      /**
       * @param {decoding.Decoder} decoder
       */
      constructor(decoder) {
        super(decoder);
        this.keys = [];
        readVarUint(decoder);
        this.keyClockDecoder = new IntDiffOptRleDecoder(readVarUint8Array(decoder));
        this.clientDecoder = new UintOptRleDecoder(readVarUint8Array(decoder));
        this.leftClockDecoder = new IntDiffOptRleDecoder(readVarUint8Array(decoder));
        this.rightClockDecoder = new IntDiffOptRleDecoder(readVarUint8Array(decoder));
        this.infoDecoder = new RleDecoder(readVarUint8Array(decoder), readUint8);
        this.stringDecoder = new StringDecoder(readVarUint8Array(decoder));
        this.parentInfoDecoder = new RleDecoder(readVarUint8Array(decoder), readUint8);
        this.typeRefDecoder = new UintOptRleDecoder(readVarUint8Array(decoder));
        this.lenDecoder = new UintOptRleDecoder(readVarUint8Array(decoder));
      }
      /**
       * @return {ID}
       */
      readLeftID() {
        return new ID(this.clientDecoder.read(), this.leftClockDecoder.read());
      }
      /**
       * @return {ID}
       */
      readRightID() {
        return new ID(this.clientDecoder.read(), this.rightClockDecoder.read());
      }
      /**
       * Read the next client id.
       * Use this in favor of readID whenever possible to reduce the number of objects created.
       */
      readClient() {
        return this.clientDecoder.read();
      }
      /**
       * @return {number} info An unsigned 8-bit integer
       */
      readInfo() {
        return (
          /** @type {number} */
          this.infoDecoder.read()
        );
      }
      /**
       * @return {string}
       */
      readString() {
        return this.stringDecoder.read();
      }
      /**
       * @return {boolean}
       */
      readParentInfo() {
        return this.parentInfoDecoder.read() === 1;
      }
      /**
       * @return {number} An unsigned 8-bit integer
       */
      readTypeRef() {
        return this.typeRefDecoder.read();
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @return {number}
       */
      readLen() {
        return this.lenDecoder.read();
      }
      /**
       * @return {any}
       */
      readAny() {
        return readAny(this.restDecoder);
      }
      /**
       * @return {Uint8Array}
       */
      readBuf() {
        return readVarUint8Array(this.restDecoder);
      }
      /**
       * This is mainly here for legacy purposes.
       *
       * Initial we incoded objects using JSON. Now we use the much faster lib0/any-encoder. This method mainly exists for legacy purposes for the v1 encoder.
       *
       * @return {any}
       */
      readJSON() {
        return readAny(this.restDecoder);
      }
      /**
       * @return {string}
       */
      readKey() {
        const keyClock = this.keyClockDecoder.read();
        if (keyClock < this.keys.length) {
          return this.keys[keyClock];
        } else {
          const key = this.stringDecoder.read();
          this.keys.push(key);
          return key;
        }
      }
    };
    DSEncoderV1 = class {
      constructor() {
        this.restEncoder = createEncoder();
      }
      toUint8Array() {
        return toUint8Array(this.restEncoder);
      }
      resetDsCurVal() {
      }
      /**
       * @param {number} clock
       */
      writeDsClock(clock) {
        writeVarUint(this.restEncoder, clock);
      }
      /**
       * @param {number} len
       */
      writeDsLen(len) {
        writeVarUint(this.restEncoder, len);
      }
    };
    UpdateEncoderV1 = class extends DSEncoderV1 {
      /**
       * @param {ID} id
       */
      writeLeftID(id2) {
        writeVarUint(this.restEncoder, id2.client);
        writeVarUint(this.restEncoder, id2.clock);
      }
      /**
       * @param {ID} id
       */
      writeRightID(id2) {
        writeVarUint(this.restEncoder, id2.client);
        writeVarUint(this.restEncoder, id2.clock);
      }
      /**
       * Use writeClient and writeClock instead of writeID if possible.
       * @param {number} client
       */
      writeClient(client) {
        writeVarUint(this.restEncoder, client);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeInfo(info) {
        writeUint8(this.restEncoder, info);
      }
      /**
       * @param {string} s
       */
      writeString(s) {
        writeVarString(this.restEncoder, s);
      }
      /**
       * @param {boolean} isYKey
       */
      writeParentInfo(isYKey) {
        writeVarUint(this.restEncoder, isYKey ? 1 : 0);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeTypeRef(info) {
        writeVarUint(this.restEncoder, info);
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @param {number} len
       */
      writeLen(len) {
        writeVarUint(this.restEncoder, len);
      }
      /**
       * @param {any} any
       */
      writeAny(any2) {
        writeAny(this.restEncoder, any2);
      }
      /**
       * @param {Uint8Array} buf
       */
      writeBuf(buf) {
        writeVarUint8Array(this.restEncoder, buf);
      }
      /**
       * @param {any} embed
       */
      writeJSON(embed) {
        writeVarString(this.restEncoder, JSON.stringify(embed));
      }
      /**
       * @param {string} key
       */
      writeKey(key) {
        writeVarString(this.restEncoder, key);
      }
    };
    DSEncoderV2 = class {
      constructor() {
        this.restEncoder = createEncoder();
        this.dsCurrVal = 0;
      }
      toUint8Array() {
        return toUint8Array(this.restEncoder);
      }
      resetDsCurVal() {
        this.dsCurrVal = 0;
      }
      /**
       * @param {number} clock
       */
      writeDsClock(clock) {
        const diff = clock - this.dsCurrVal;
        this.dsCurrVal = clock;
        writeVarUint(this.restEncoder, diff);
      }
      /**
       * @param {number} len
       */
      writeDsLen(len) {
        if (len === 0) {
          unexpectedCase();
        }
        writeVarUint(this.restEncoder, len - 1);
        this.dsCurrVal += len;
      }
    };
    UpdateEncoderV2 = class extends DSEncoderV2 {
      constructor() {
        super();
        this.keyMap = /* @__PURE__ */ new Map();
        this.keyClock = 0;
        this.keyClockEncoder = new IntDiffOptRleEncoder();
        this.clientEncoder = new UintOptRleEncoder();
        this.leftClockEncoder = new IntDiffOptRleEncoder();
        this.rightClockEncoder = new IntDiffOptRleEncoder();
        this.infoEncoder = new RleEncoder(writeUint8);
        this.stringEncoder = new StringEncoder();
        this.parentInfoEncoder = new RleEncoder(writeUint8);
        this.typeRefEncoder = new UintOptRleEncoder();
        this.lenEncoder = new UintOptRleEncoder();
      }
      toUint8Array() {
        const encoder3 = createEncoder();
        writeVarUint(encoder3, 0);
        writeVarUint8Array(encoder3, this.keyClockEncoder.toUint8Array());
        writeVarUint8Array(encoder3, this.clientEncoder.toUint8Array());
        writeVarUint8Array(encoder3, this.leftClockEncoder.toUint8Array());
        writeVarUint8Array(encoder3, this.rightClockEncoder.toUint8Array());
        writeVarUint8Array(encoder3, toUint8Array(this.infoEncoder));
        writeVarUint8Array(encoder3, this.stringEncoder.toUint8Array());
        writeVarUint8Array(encoder3, toUint8Array(this.parentInfoEncoder));
        writeVarUint8Array(encoder3, this.typeRefEncoder.toUint8Array());
        writeVarUint8Array(encoder3, this.lenEncoder.toUint8Array());
        writeUint8Array(encoder3, toUint8Array(this.restEncoder));
        return toUint8Array(encoder3);
      }
      /**
       * @param {ID} id
       */
      writeLeftID(id2) {
        this.clientEncoder.write(id2.client);
        this.leftClockEncoder.write(id2.clock);
      }
      /**
       * @param {ID} id
       */
      writeRightID(id2) {
        this.clientEncoder.write(id2.client);
        this.rightClockEncoder.write(id2.clock);
      }
      /**
       * @param {number} client
       */
      writeClient(client) {
        this.clientEncoder.write(client);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeInfo(info) {
        this.infoEncoder.write(info);
      }
      /**
       * @param {string} s
       */
      writeString(s) {
        this.stringEncoder.write(s);
      }
      /**
       * @param {boolean} isYKey
       */
      writeParentInfo(isYKey) {
        this.parentInfoEncoder.write(isYKey ? 1 : 0);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeTypeRef(info) {
        this.typeRefEncoder.write(info);
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @param {number} len
       */
      writeLen(len) {
        this.lenEncoder.write(len);
      }
      /**
       * @param {any} any
       */
      writeAny(any2) {
        writeAny(this.restEncoder, any2);
      }
      /**
       * @param {Uint8Array} buf
       */
      writeBuf(buf) {
        writeVarUint8Array(this.restEncoder, buf);
      }
      /**
       * This is mainly here for legacy purposes.
       *
       * Initial we incoded objects using JSON. Now we use the much faster lib0/any-encoder. This method mainly exists for legacy purposes for the v1 encoder.
       *
       * @param {any} embed
       */
      writeJSON(embed) {
        writeAny(this.restEncoder, embed);
      }
      /**
       * Property keys are often reused. For example, in y-prosemirror the key `bold` might
       * occur very often. For a 3d application, the key `position` might occur very often.
       *
       * We cache these keys in a Map and refer to them via a unique number.
       *
       * @param {string} key
       */
      writeKey(key) {
        const clock = this.keyMap.get(key);
        if (clock === void 0) {
          this.keyClockEncoder.write(this.keyClock++);
          this.stringEncoder.write(key);
        } else {
          this.keyClockEncoder.write(clock);
        }
      }
    };
    writeStructs = (encoder3, structs, client, clock) => {
      clock = max(clock, structs[0].id.clock);
      const startNewStructs = findIndexSS(structs, clock);
      writeVarUint(encoder3.restEncoder, structs.length - startNewStructs);
      encoder3.writeClient(client);
      writeVarUint(encoder3.restEncoder, clock);
      const firstStruct = structs[startNewStructs];
      firstStruct.write(encoder3, clock - firstStruct.id.clock);
      for (let i = startNewStructs + 1; i < structs.length; i++) {
        structs[i].write(encoder3, 0);
      }
    };
    writeClientsStructs = (encoder3, store, _sm) => {
      const sm = /* @__PURE__ */ new Map();
      _sm.forEach((clock, client) => {
        if (getState(store, client) > clock) {
          sm.set(client, clock);
        }
      });
      getStateVector(store).forEach((_clock, client) => {
        if (!_sm.has(client)) {
          sm.set(client, 0);
        }
      });
      writeVarUint(encoder3.restEncoder, sm.size);
      from(sm.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
        writeStructs(
          encoder3,
          /** @type {Array<GC|Item>} */
          store.clients.get(client),
          client,
          clock
        );
      });
    };
    readClientsStructRefs = (decoder, doc) => {
      const clientRefs = create3();
      const numOfStateUpdates = readVarUint(decoder.restDecoder);
      for (let i = 0; i < numOfStateUpdates; i++) {
        const numberOfStructs = readVarUint(decoder.restDecoder);
        const refs = new Array(numberOfStructs);
        const client = decoder.readClient();
        let clock = readVarUint(decoder.restDecoder);
        clientRefs.set(client, { i: 0, refs });
        for (let i2 = 0; i2 < numberOfStructs; i2++) {
          const info = decoder.readInfo();
          switch (BITS5 & info) {
            case 0: {
              const len = decoder.readLen();
              refs[i2] = new GC(createID(client, clock), len);
              clock += len;
              break;
            }
            case 10: {
              const len = readVarUint(decoder.restDecoder);
              refs[i2] = new Skip(createID(client, clock), len);
              clock += len;
              break;
            }
            default: {
              const cantCopyParentInfo = (info & (BIT7 | BIT8)) === 0;
              const struct = new Item(
                createID(client, clock),
                null,
                // left
                (info & BIT8) === BIT8 ? decoder.readLeftID() : null,
                // origin
                null,
                // right
                (info & BIT7) === BIT7 ? decoder.readRightID() : null,
                // right origin
                cantCopyParentInfo ? decoder.readParentInfo() ? doc.get(decoder.readString()) : decoder.readLeftID() : null,
                // parent
                cantCopyParentInfo && (info & BIT6) === BIT6 ? decoder.readString() : null,
                // parentSub
                readItemContent(decoder, info)
                // item content
              );
              refs[i2] = struct;
              clock += struct.length;
            }
          }
        }
      }
      return clientRefs;
    };
    integrateStructs = (transaction, store, clientsStructRefs) => {
      const stack = [];
      let clientsStructRefsIds = from(clientsStructRefs.keys()).sort((a, b) => a - b);
      if (clientsStructRefsIds.length === 0) {
        return null;
      }
      const getNextStructTarget = () => {
        if (clientsStructRefsIds.length === 0) {
          return null;
        }
        let nextStructsTarget = (
          /** @type {{i:number,refs:Array<GC|Item>}} */
          clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1])
        );
        while (nextStructsTarget.refs.length === nextStructsTarget.i) {
          clientsStructRefsIds.pop();
          if (clientsStructRefsIds.length > 0) {
            nextStructsTarget = /** @type {{i:number,refs:Array<GC|Item>}} */
            clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1]);
          } else {
            return null;
          }
        }
        return nextStructsTarget;
      };
      let curStructsTarget = getNextStructTarget();
      if (curStructsTarget === null) {
        return null;
      }
      const restStructs = new StructStore();
      const missingSV = /* @__PURE__ */ new Map();
      const updateMissingSv = (client, clock) => {
        const mclock = missingSV.get(client);
        if (mclock == null || mclock > clock) {
          missingSV.set(client, clock);
        }
      };
      let stackHead = (
        /** @type {any} */
        curStructsTarget.refs[
          /** @type {any} */
          curStructsTarget.i++
        ]
      );
      const state = /* @__PURE__ */ new Map();
      const addStackToRestSS = () => {
        for (const item of stack) {
          const client = item.id.client;
          const inapplicableItems = clientsStructRefs.get(client);
          if (inapplicableItems) {
            inapplicableItems.i--;
            restStructs.clients.set(client, inapplicableItems.refs.slice(inapplicableItems.i));
            clientsStructRefs.delete(client);
            inapplicableItems.i = 0;
            inapplicableItems.refs = [];
          } else {
            restStructs.clients.set(client, [item]);
          }
          clientsStructRefsIds = clientsStructRefsIds.filter((c) => c !== client);
        }
        stack.length = 0;
      };
      while (true) {
        if (stackHead.constructor !== Skip) {
          const localClock = setIfUndefined(state, stackHead.id.client, () => getState(store, stackHead.id.client));
          const offset = localClock - stackHead.id.clock;
          if (offset < 0) {
            stack.push(stackHead);
            updateMissingSv(stackHead.id.client, stackHead.id.clock - 1);
            addStackToRestSS();
          } else {
            const missing = stackHead.getMissing(transaction, store);
            if (missing !== null) {
              stack.push(stackHead);
              const structRefs = clientsStructRefs.get(
                /** @type {number} */
                missing
              ) || { refs: [], i: 0 };
              if (structRefs.refs.length === structRefs.i) {
                updateMissingSv(
                  /** @type {number} */
                  missing,
                  getState(store, missing)
                );
                addStackToRestSS();
              } else {
                stackHead = structRefs.refs[structRefs.i++];
                continue;
              }
            } else if (offset === 0 || offset < stackHead.length) {
              stackHead.integrate(transaction, offset);
              state.set(stackHead.id.client, stackHead.id.clock + stackHead.length);
            }
          }
        }
        if (stack.length > 0) {
          stackHead = /** @type {GC|Item} */
          stack.pop();
        } else if (curStructsTarget !== null && curStructsTarget.i < curStructsTarget.refs.length) {
          stackHead = /** @type {GC|Item} */
          curStructsTarget.refs[curStructsTarget.i++];
        } else {
          curStructsTarget = getNextStructTarget();
          if (curStructsTarget === null) {
            break;
          } else {
            stackHead = /** @type {GC|Item} */
            curStructsTarget.refs[curStructsTarget.i++];
          }
        }
      }
      if (restStructs.clients.size > 0) {
        const encoder3 = new UpdateEncoderV2();
        writeClientsStructs(encoder3, restStructs, /* @__PURE__ */ new Map());
        writeVarUint(encoder3.restEncoder, 0);
        return { missing: missingSV, update: encoder3.toUint8Array() };
      }
      return null;
    };
    writeStructsFromTransaction = (encoder3, transaction) => writeClientsStructs(encoder3, transaction.doc.store, transaction.beforeState);
    readUpdateV2 = (decoder, ydoc, transactionOrigin, structDecoder = new UpdateDecoderV2(decoder)) => transact(ydoc, (transaction) => {
      transaction.local = false;
      let retry = false;
      const doc = transaction.doc;
      const store = doc.store;
      const ss = readClientsStructRefs(structDecoder, doc);
      const restStructs = integrateStructs(transaction, store, ss);
      const pending = store.pendingStructs;
      if (pending) {
        for (const [client, clock] of pending.missing) {
          if (clock < getState(store, client)) {
            retry = true;
            break;
          }
        }
        if (restStructs) {
          for (const [client, clock] of restStructs.missing) {
            const mclock = pending.missing.get(client);
            if (mclock == null || mclock > clock) {
              pending.missing.set(client, clock);
            }
          }
          pending.update = mergeUpdatesV2([pending.update, restStructs.update]);
        }
      } else {
        store.pendingStructs = restStructs;
      }
      const dsRest = readAndApplyDeleteSet(structDecoder, transaction, store);
      if (store.pendingDs) {
        const pendingDSUpdate = new UpdateDecoderV2(createDecoder(store.pendingDs));
        readVarUint(pendingDSUpdate.restDecoder);
        const dsRest2 = readAndApplyDeleteSet(pendingDSUpdate, transaction, store);
        if (dsRest && dsRest2) {
          store.pendingDs = mergeUpdatesV2([dsRest, dsRest2]);
        } else {
          store.pendingDs = dsRest || dsRest2;
        }
      } else {
        store.pendingDs = dsRest;
      }
      if (retry) {
        const update = (
          /** @type {{update: Uint8Array}} */
          store.pendingStructs.update
        );
        store.pendingStructs = null;
        applyUpdateV2(transaction.doc, update);
      }
    }, transactionOrigin, false);
    applyUpdateV2 = (ydoc, update, transactionOrigin, YDecoder = UpdateDecoderV2) => {
      const decoder = createDecoder(update);
      readUpdateV2(decoder, ydoc, transactionOrigin, new YDecoder(decoder));
    };
    applyUpdate = (ydoc, update, transactionOrigin) => applyUpdateV2(ydoc, update, transactionOrigin, UpdateDecoderV1);
    writeStateAsUpdate = (encoder3, doc, targetStateVector = /* @__PURE__ */ new Map()) => {
      writeClientsStructs(encoder3, doc.store, targetStateVector);
      writeDeleteSet(encoder3, createDeleteSetFromStructStore(doc.store));
    };
    encodeStateAsUpdateV2 = (doc, encodedTargetStateVector = new Uint8Array([0]), encoder3 = new UpdateEncoderV2()) => {
      const targetStateVector = decodeStateVector(encodedTargetStateVector);
      writeStateAsUpdate(encoder3, doc, targetStateVector);
      const updates = [encoder3.toUint8Array()];
      if (doc.store.pendingDs) {
        updates.push(doc.store.pendingDs);
      }
      if (doc.store.pendingStructs) {
        updates.push(diffUpdateV2(doc.store.pendingStructs.update, encodedTargetStateVector));
      }
      if (updates.length > 1) {
        if (encoder3.constructor === UpdateEncoderV1) {
          return mergeUpdates(updates.map((update, i) => i === 0 ? update : convertUpdateFormatV2ToV1(update)));
        } else if (encoder3.constructor === UpdateEncoderV2) {
          return mergeUpdatesV2(updates);
        }
      }
      return updates[0];
    };
    encodeStateAsUpdate = (doc, encodedTargetStateVector) => encodeStateAsUpdateV2(doc, encodedTargetStateVector, new UpdateEncoderV1());
    readStateVector = (decoder) => {
      const ss = /* @__PURE__ */ new Map();
      const ssLength = readVarUint(decoder.restDecoder);
      for (let i = 0; i < ssLength; i++) {
        const client = readVarUint(decoder.restDecoder);
        const clock = readVarUint(decoder.restDecoder);
        ss.set(client, clock);
      }
      return ss;
    };
    decodeStateVector = (decodedState) => readStateVector(new DSDecoderV1(createDecoder(decodedState)));
    writeStateVector = (encoder3, sv) => {
      writeVarUint(encoder3.restEncoder, sv.size);
      from(sv.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
        writeVarUint(encoder3.restEncoder, client);
        writeVarUint(encoder3.restEncoder, clock);
      });
      return encoder3;
    };
    writeDocumentStateVector = (encoder3, doc) => writeStateVector(encoder3, getStateVector(doc.store));
    encodeStateVectorV2 = (doc, encoder3 = new DSEncoderV2()) => {
      if (doc instanceof Map) {
        writeStateVector(encoder3, doc);
      } else {
        writeDocumentStateVector(encoder3, doc);
      }
      return encoder3.toUint8Array();
    };
    encodeStateVector = (doc) => encodeStateVectorV2(doc, new DSEncoderV1());
    EventHandler = class {
      constructor() {
        this.l = [];
      }
    };
    createEventHandler = () => new EventHandler();
    addEventHandlerListener = (eventHandler, f) => eventHandler.l.push(f);
    removeEventHandlerListener = (eventHandler, f) => {
      const l = eventHandler.l;
      const len = l.length;
      eventHandler.l = l.filter((g) => f !== g);
      if (len === eventHandler.l.length) {
        console.error("[yjs] Tried to remove event handler that doesn't exist.");
      }
    };
    callEventHandlerListeners = (eventHandler, arg0, arg1) => callAll(eventHandler.l, [arg0, arg1]);
    ID = class {
      /**
       * @param {number} client client id
       * @param {number} clock unique per client id, continuous number
       */
      constructor(client, clock) {
        this.client = client;
        this.clock = clock;
      }
    };
    compareIDs = (a, b) => a === b || a !== null && b !== null && a.client === b.client && a.clock === b.clock;
    createID = (client, clock) => new ID(client, clock);
    findRootTypeKey = (type) => {
      for (const [key, value2] of type.doc.share.entries()) {
        if (value2 === type) {
          return key;
        }
      }
      throw unexpectedCase();
    };
    RelativePosition = class {
      /**
       * @param {ID|null} type
       * @param {string|null} tname
       * @param {ID|null} item
       * @param {number} assoc
       */
      constructor(type, tname, item, assoc = 0) {
        this.type = type;
        this.tname = tname;
        this.item = item;
        this.assoc = assoc;
      }
    };
    relativePositionToJSON = (rpos) => {
      const json = {};
      if (rpos.type) {
        json.type = rpos.type;
      }
      if (rpos.tname) {
        json.tname = rpos.tname;
      }
      if (rpos.item) {
        json.item = rpos.item;
      }
      if (rpos.assoc != null) {
        json.assoc = rpos.assoc;
      }
      return json;
    };
    createRelativePositionFromJSON = (json) => new RelativePosition(json.type == null ? null : createID(json.type.client, json.type.clock), json.tname ?? null, json.item == null ? null : createID(json.item.client, json.item.clock), json.assoc == null ? 0 : json.assoc);
    AbsolutePosition = class {
      /**
       * @param {AbstractType<any>} type
       * @param {number} index
       * @param {number} [assoc]
       */
      constructor(type, index, assoc = 0) {
        this.type = type;
        this.index = index;
        this.assoc = assoc;
      }
    };
    createAbsolutePosition = (type, index, assoc = 0) => new AbsolutePosition(type, index, assoc);
    createRelativePosition = (type, item, assoc) => {
      let typeid = null;
      let tname = null;
      if (type._item === null) {
        tname = findRootTypeKey(type);
      } else {
        typeid = createID(type._item.id.client, type._item.id.clock);
      }
      return new RelativePosition(typeid, tname, item, assoc);
    };
    createRelativePositionFromTypeIndex = (type, index, assoc = 0) => {
      let t = type._start;
      if (assoc < 0) {
        if (index === 0) {
          return createRelativePosition(type, null, assoc);
        }
        index--;
      }
      while (t !== null) {
        if (!t.deleted && t.countable) {
          if (t.length > index) {
            return createRelativePosition(type, createID(t.id.client, t.id.clock + index), assoc);
          }
          index -= t.length;
        }
        if (t.right === null && assoc < 0) {
          return createRelativePosition(type, t.lastId, assoc);
        }
        t = t.right;
      }
      return createRelativePosition(type, null, assoc);
    };
    getItemWithOffset = (store, id2) => {
      const item = getItem(store, id2);
      const diff = id2.clock - item.id.clock;
      return {
        item,
        diff
      };
    };
    createAbsolutePositionFromRelativePosition = (rpos, doc, followUndoneDeletions = true) => {
      const store = doc.store;
      const rightID = rpos.item;
      const typeID = rpos.type;
      const tname = rpos.tname;
      const assoc = rpos.assoc;
      let type = null;
      let index = 0;
      if (rightID !== null) {
        if (getState(store, rightID.client) <= rightID.clock) {
          return null;
        }
        const res = followUndoneDeletions ? followRedone(store, rightID) : getItemWithOffset(store, rightID);
        const right = res.item;
        if (!(right instanceof Item)) {
          return null;
        }
        type = /** @type {AbstractType<any>} */
        right.parent;
        if (type._item === null || !type._item.deleted) {
          index = right.deleted || !right.countable ? 0 : res.diff + (assoc >= 0 ? 0 : 1);
          let n = right.left;
          while (n !== null) {
            if (!n.deleted && n.countable) {
              index += n.length;
            }
            n = n.left;
          }
        }
      } else {
        if (tname !== null) {
          type = doc.get(tname);
        } else if (typeID !== null) {
          if (getState(store, typeID.client) <= typeID.clock) {
            return null;
          }
          const { item } = followUndoneDeletions ? followRedone(store, typeID) : { item: getItem(store, typeID) };
          if (item instanceof Item && item.content instanceof ContentType) {
            type = item.content.type;
          } else {
            return null;
          }
        } else {
          throw unexpectedCase();
        }
        if (assoc >= 0) {
          index = type._length;
        } else {
          index = 0;
        }
      }
      return createAbsolutePosition(type, index, rpos.assoc);
    };
    Snapshot = class {
      /**
       * @param {DeleteSet} ds
       * @param {Map<number,number>} sv state map
       */
      constructor(ds, sv) {
        this.ds = ds;
        this.sv = sv;
      }
    };
    createSnapshot = (ds, sm) => new Snapshot(ds, sm);
    emptySnapshot = createSnapshot(createDeleteSet(), /* @__PURE__ */ new Map());
    isVisible = (item, snapshot) => snapshot === void 0 ? !item.deleted : snapshot.sv.has(item.id.client) && (snapshot.sv.get(item.id.client) || 0) > item.id.clock && !isDeleted(snapshot.ds, item.id);
    splitSnapshotAffectedStructs = (transaction, snapshot) => {
      const meta = setIfUndefined(transaction.meta, splitSnapshotAffectedStructs, create);
      const store = transaction.doc.store;
      if (!meta.has(snapshot)) {
        snapshot.sv.forEach((clock, client) => {
          if (clock < getState(store, client)) {
            getItemCleanStart(transaction, createID(client, clock));
          }
        });
        iterateDeletedStructs(transaction, snapshot.ds, (_item) => {
        });
        meta.add(snapshot);
      }
    };
    StructStore = class {
      constructor() {
        this.clients = /* @__PURE__ */ new Map();
        this.pendingStructs = null;
        this.pendingDs = null;
      }
    };
    getStateVector = (store) => {
      const sm = /* @__PURE__ */ new Map();
      store.clients.forEach((structs, client) => {
        const struct = structs[structs.length - 1];
        sm.set(client, struct.id.clock + struct.length);
      });
      return sm;
    };
    getState = (store, client) => {
      const structs = store.clients.get(client);
      if (structs === void 0) {
        return 0;
      }
      const lastStruct = structs[structs.length - 1];
      return lastStruct.id.clock + lastStruct.length;
    };
    addStruct = (store, struct) => {
      let structs = store.clients.get(struct.id.client);
      if (structs === void 0) {
        structs = [];
        store.clients.set(struct.id.client, structs);
      } else {
        const lastStruct = structs[structs.length - 1];
        if (lastStruct.id.clock + lastStruct.length !== struct.id.clock) {
          throw unexpectedCase();
        }
      }
      structs.push(struct);
    };
    findIndexSS = (structs, clock) => {
      let left = 0;
      let right = structs.length - 1;
      let mid = structs[right];
      let midclock = mid.id.clock;
      if (midclock === clock) {
        return right;
      }
      let midindex = floor(clock / (midclock + mid.length - 1) * right);
      while (left <= right) {
        mid = structs[midindex];
        midclock = mid.id.clock;
        if (midclock <= clock) {
          if (clock < midclock + mid.length) {
            return midindex;
          }
          left = midindex + 1;
        } else {
          right = midindex - 1;
        }
        midindex = floor((left + right) / 2);
      }
      throw unexpectedCase();
    };
    find = (store, id2) => {
      const structs = store.clients.get(id2.client);
      return structs[findIndexSS(structs, id2.clock)];
    };
    getItem = /** @type {function(StructStore,ID):Item} */
    find;
    findIndexCleanStart = (transaction, structs, clock) => {
      const index = findIndexSS(structs, clock);
      const struct = structs[index];
      if (struct.id.clock < clock && struct instanceof Item) {
        structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock));
        return index + 1;
      }
      return index;
    };
    getItemCleanStart = (transaction, id2) => {
      const structs = (
        /** @type {Array<Item>} */
        transaction.doc.store.clients.get(id2.client)
      );
      return structs[findIndexCleanStart(transaction, structs, id2.clock)];
    };
    getItemCleanEnd = (transaction, store, id2) => {
      const structs = store.clients.get(id2.client);
      const index = findIndexSS(structs, id2.clock);
      const struct = structs[index];
      if (id2.clock !== struct.id.clock + struct.length - 1 && struct.constructor !== GC) {
        structs.splice(index + 1, 0, splitItem(transaction, struct, id2.clock - struct.id.clock + 1));
      }
      return struct;
    };
    replaceStruct = (store, struct, newStruct) => {
      const structs = (
        /** @type {Array<GC|Item>} */
        store.clients.get(struct.id.client)
      );
      structs[findIndexSS(structs, struct.id.clock)] = newStruct;
    };
    iterateStructs = (transaction, structs, clockStart, len, f) => {
      if (len === 0) {
        return;
      }
      const clockEnd = clockStart + len;
      let index = findIndexCleanStart(transaction, structs, clockStart);
      let struct;
      do {
        struct = structs[index++];
        if (clockEnd < struct.id.clock + struct.length) {
          findIndexCleanStart(transaction, structs, clockEnd);
        }
        f(struct);
      } while (index < structs.length && structs[index].id.clock < clockEnd);
    };
    Transaction = class {
      /**
       * @param {Doc} doc
       * @param {any} origin
       * @param {boolean} local
       */
      constructor(doc, origin, local) {
        this.doc = doc;
        this.deleteSet = new DeleteSet();
        this.beforeState = getStateVector(doc.store);
        this.afterState = /* @__PURE__ */ new Map();
        this.changed = /* @__PURE__ */ new Map();
        this.changedParentTypes = /* @__PURE__ */ new Map();
        this._mergeStructs = [];
        this.origin = origin;
        this.meta = /* @__PURE__ */ new Map();
        this.local = local;
        this.subdocsAdded = /* @__PURE__ */ new Set();
        this.subdocsRemoved = /* @__PURE__ */ new Set();
        this.subdocsLoaded = /* @__PURE__ */ new Set();
        this._needFormattingCleanup = false;
      }
    };
    writeUpdateMessageFromTransaction = (encoder3, transaction) => {
      if (transaction.deleteSet.clients.size === 0 && !any(transaction.afterState, (clock, client) => transaction.beforeState.get(client) !== clock)) {
        return false;
      }
      sortAndMergeDeleteSet(transaction.deleteSet);
      writeStructsFromTransaction(encoder3, transaction);
      writeDeleteSet(encoder3, transaction.deleteSet);
      return true;
    };
    addChangedTypeToTransaction = (transaction, type, parentSub) => {
      const item = type._item;
      if (item === null || item.id.clock < (transaction.beforeState.get(item.id.client) || 0) && !item.deleted) {
        setIfUndefined(transaction.changed, type, create).add(parentSub);
      }
    };
    tryToMergeWithLefts = (structs, pos) => {
      let right = structs[pos];
      let left = structs[pos - 1];
      let i = pos;
      for (; i > 0; right = left, left = structs[--i - 1]) {
        if (left.deleted === right.deleted && left.constructor === right.constructor) {
          if (left.mergeWith(right)) {
            if (right instanceof Item && right.parentSub !== null && /** @type {AbstractType<any>} */
            right.parent._map.get(right.parentSub) === right) {
              right.parent._map.set(
                right.parentSub,
                /** @type {Item} */
                left
              );
            }
            continue;
          }
        }
        break;
      }
      const merged = pos - i;
      if (merged) {
        structs.splice(pos + 1 - merged, merged);
      }
      return merged;
    };
    tryGcDeleteSet = (ds, store, gcFilter) => {
      for (const [client, deleteItems] of ds.clients.entries()) {
        const structs = (
          /** @type {Array<GC|Item>} */
          store.clients.get(client)
        );
        for (let di = deleteItems.length - 1; di >= 0; di--) {
          const deleteItem = deleteItems[di];
          const endDeleteItemClock = deleteItem.clock + deleteItem.len;
          for (let si = findIndexSS(structs, deleteItem.clock), struct = structs[si]; si < structs.length && struct.id.clock < endDeleteItemClock; struct = structs[++si]) {
            const struct2 = structs[si];
            if (deleteItem.clock + deleteItem.len <= struct2.id.clock) {
              break;
            }
            if (struct2 instanceof Item && struct2.deleted && !struct2.keep && gcFilter(struct2)) {
              struct2.gc(store, false);
            }
          }
        }
      }
    };
    tryMergeDeleteSet = (ds, store) => {
      ds.clients.forEach((deleteItems, client) => {
        const structs = (
          /** @type {Array<GC|Item>} */
          store.clients.get(client)
        );
        for (let di = deleteItems.length - 1; di >= 0; di--) {
          const deleteItem = deleteItems[di];
          const mostRightIndexToCheck = min(structs.length - 1, 1 + findIndexSS(structs, deleteItem.clock + deleteItem.len - 1));
          for (let si = mostRightIndexToCheck, struct = structs[si]; si > 0 && struct.id.clock >= deleteItem.clock; struct = structs[si]) {
            si -= 1 + tryToMergeWithLefts(structs, si);
          }
        }
      });
    };
    cleanupTransactions = (transactionCleanups, i) => {
      if (i < transactionCleanups.length) {
        const transaction = transactionCleanups[i];
        const doc = transaction.doc;
        const store = doc.store;
        const ds = transaction.deleteSet;
        const mergeStructs = transaction._mergeStructs;
        try {
          sortAndMergeDeleteSet(ds);
          transaction.afterState = getStateVector(transaction.doc.store);
          doc.emit("beforeObserverCalls", [transaction, doc]);
          const fs11 = [];
          transaction.changed.forEach(
            (subs, itemtype) => fs11.push(() => {
              if (itemtype._item === null || !itemtype._item.deleted) {
                itemtype._callObserver(transaction, subs);
              }
            })
          );
          fs11.push(() => {
            transaction.changedParentTypes.forEach((events, type) => {
              if (type._dEH.l.length > 0 && (type._item === null || !type._item.deleted)) {
                events = events.filter(
                  (event) => event.target._item === null || !event.target._item.deleted
                );
                events.forEach((event) => {
                  event.currentTarget = type;
                  event._path = null;
                });
                events.sort((event1, event2) => event1.path.length - event2.path.length);
                fs11.push(() => {
                  callEventHandlerListeners(type._dEH, events, transaction);
                });
              }
            });
            fs11.push(() => doc.emit("afterTransaction", [transaction, doc]));
            fs11.push(() => {
              if (transaction._needFormattingCleanup) {
                cleanupYTextAfterTransaction(transaction);
              }
            });
          });
          callAll(fs11, []);
        } finally {
          if (doc.gc) {
            tryGcDeleteSet(ds, store, doc.gcFilter);
          }
          tryMergeDeleteSet(ds, store);
          transaction.afterState.forEach((clock, client) => {
            const beforeClock = transaction.beforeState.get(client) || 0;
            if (beforeClock !== clock) {
              const structs = (
                /** @type {Array<GC|Item>} */
                store.clients.get(client)
              );
              const firstChangePos = max(findIndexSS(structs, beforeClock), 1);
              for (let i2 = structs.length - 1; i2 >= firstChangePos; ) {
                i2 -= 1 + tryToMergeWithLefts(structs, i2);
              }
            }
          });
          for (let i2 = mergeStructs.length - 1; i2 >= 0; i2--) {
            const { client, clock } = mergeStructs[i2].id;
            const structs = (
              /** @type {Array<GC|Item>} */
              store.clients.get(client)
            );
            const replacedStructPos = findIndexSS(structs, clock);
            if (replacedStructPos + 1 < structs.length) {
              if (tryToMergeWithLefts(structs, replacedStructPos + 1) > 1) {
                continue;
              }
            }
            if (replacedStructPos > 0) {
              tryToMergeWithLefts(structs, replacedStructPos);
            }
          }
          if (!transaction.local && transaction.afterState.get(doc.clientID) !== transaction.beforeState.get(doc.clientID)) {
            print(ORANGE, BOLD, "[yjs] ", UNBOLD, RED, "Changed the client-id because another client seems to be using it.");
            doc.clientID = generateNewClientId();
          }
          doc.emit("afterTransactionCleanup", [transaction, doc]);
          if (doc._observers.has("update")) {
            const encoder3 = new UpdateEncoderV1();
            const hasContent2 = writeUpdateMessageFromTransaction(encoder3, transaction);
            if (hasContent2) {
              doc.emit("update", [encoder3.toUint8Array(), transaction.origin, doc, transaction]);
            }
          }
          if (doc._observers.has("updateV2")) {
            const encoder3 = new UpdateEncoderV2();
            const hasContent2 = writeUpdateMessageFromTransaction(encoder3, transaction);
            if (hasContent2) {
              doc.emit("updateV2", [encoder3.toUint8Array(), transaction.origin, doc, transaction]);
            }
          }
          const { subdocsAdded, subdocsLoaded, subdocsRemoved } = transaction;
          if (subdocsAdded.size > 0 || subdocsRemoved.size > 0 || subdocsLoaded.size > 0) {
            subdocsAdded.forEach((subdoc) => {
              subdoc.clientID = doc.clientID;
              if (subdoc.collectionid == null) {
                subdoc.collectionid = doc.collectionid;
              }
              doc.subdocs.add(subdoc);
            });
            subdocsRemoved.forEach((subdoc) => doc.subdocs.delete(subdoc));
            doc.emit("subdocs", [{ loaded: subdocsLoaded, added: subdocsAdded, removed: subdocsRemoved }, doc, transaction]);
            subdocsRemoved.forEach((subdoc) => subdoc.destroy());
          }
          if (transactionCleanups.length <= i + 1) {
            doc._transactionCleanups = [];
            doc.emit("afterAllTransactions", [doc, transactionCleanups]);
          } else {
            cleanupTransactions(transactionCleanups, i + 1);
          }
        }
      }
    };
    transact = (doc, f, origin = null, local = true) => {
      const transactionCleanups = doc._transactionCleanups;
      let initialCall = false;
      let result = null;
      if (doc._transaction === null) {
        initialCall = true;
        doc._transaction = new Transaction(doc, origin, local);
        transactionCleanups.push(doc._transaction);
        if (transactionCleanups.length === 1) {
          doc.emit("beforeAllTransactions", [doc]);
        }
        doc.emit("beforeTransaction", [doc._transaction, doc]);
      }
      try {
        result = f(doc._transaction);
      } finally {
        if (initialCall) {
          const finishCleanup = doc._transaction === transactionCleanups[0];
          doc._transaction = null;
          if (finishCleanup) {
            cleanupTransactions(transactionCleanups, 0);
          }
        }
      }
      return result;
    };
    LazyStructReader = class {
      /**
       * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
       * @param {boolean} filterSkips
       */
      constructor(decoder, filterSkips) {
        this.gen = lazyStructReaderGenerator(decoder);
        this.curr = null;
        this.done = false;
        this.filterSkips = filterSkips;
        this.next();
      }
      /**
       * @return {Item | GC | Skip |null}
       */
      next() {
        do {
          this.curr = this.gen.next().value || null;
        } while (this.filterSkips && this.curr !== null && this.curr.constructor === Skip);
        return this.curr;
      }
    };
    LazyStructWriter = class {
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      constructor(encoder3) {
        this.currClient = 0;
        this.startClock = 0;
        this.written = 0;
        this.encoder = encoder3;
        this.clientStructs = [];
      }
    };
    mergeUpdates = (updates) => mergeUpdatesV2(updates, UpdateDecoderV1, UpdateEncoderV1);
    sliceStruct = (left, diff) => {
      if (left.constructor === GC) {
        const { client, clock } = left.id;
        return new GC(createID(client, clock + diff), left.length - diff);
      } else if (left.constructor === Skip) {
        const { client, clock } = left.id;
        return new Skip(createID(client, clock + diff), left.length - diff);
      } else {
        const leftItem = (
          /** @type {Item} */
          left
        );
        const { client, clock } = leftItem.id;
        return new Item(
          createID(client, clock + diff),
          null,
          createID(client, clock + diff - 1),
          null,
          leftItem.rightOrigin,
          leftItem.parent,
          leftItem.parentSub,
          leftItem.content.splice(diff)
        );
      }
    };
    mergeUpdatesV2 = (updates, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
      if (updates.length === 1) {
        return updates[0];
      }
      const updateDecoders = updates.map((update) => new YDecoder(createDecoder(update)));
      let lazyStructDecoders = updateDecoders.map((decoder) => new LazyStructReader(decoder, true));
      let currWrite = null;
      const updateEncoder = new YEncoder();
      const lazyStructEncoder = new LazyStructWriter(updateEncoder);
      while (true) {
        lazyStructDecoders = lazyStructDecoders.filter((dec) => dec.curr !== null);
        lazyStructDecoders.sort(
          /** @type {function(any,any):number} */
          (dec1, dec2) => {
            if (dec1.curr.id.client === dec2.curr.id.client) {
              const clockDiff = dec1.curr.id.clock - dec2.curr.id.clock;
              if (clockDiff === 0) {
                return dec1.curr.constructor === dec2.curr.constructor ? 0 : dec1.curr.constructor === Skip ? 1 : -1;
              } else {
                return clockDiff;
              }
            } else {
              return dec2.curr.id.client - dec1.curr.id.client;
            }
          }
        );
        if (lazyStructDecoders.length === 0) {
          break;
        }
        const currDecoder = lazyStructDecoders[0];
        const firstClient = (
          /** @type {Item | GC} */
          currDecoder.curr.id.client
        );
        if (currWrite !== null) {
          let curr = (
            /** @type {Item | GC | null} */
            currDecoder.curr
          );
          let iterated = false;
          while (curr !== null && curr.id.clock + curr.length <= currWrite.struct.id.clock + currWrite.struct.length && curr.id.client >= currWrite.struct.id.client) {
            curr = currDecoder.next();
            iterated = true;
          }
          if (curr === null || // current decoder is empty
          curr.id.client !== firstClient || // check whether there is another decoder that has has updates from `firstClient`
          iterated && curr.id.clock > currWrite.struct.id.clock + currWrite.struct.length) {
            continue;
          }
          if (firstClient !== currWrite.struct.id.client) {
            writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
            currWrite = { struct: curr, offset: 0 };
            currDecoder.next();
          } else {
            if (currWrite.struct.id.clock + currWrite.struct.length < curr.id.clock) {
              if (currWrite.struct.constructor === Skip) {
                currWrite.struct.length = curr.id.clock + curr.length - currWrite.struct.id.clock;
              } else {
                writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
                const diff = curr.id.clock - currWrite.struct.id.clock - currWrite.struct.length;
                const struct = new Skip(createID(firstClient, currWrite.struct.id.clock + currWrite.struct.length), diff);
                currWrite = { struct, offset: 0 };
              }
            } else {
              const diff = currWrite.struct.id.clock + currWrite.struct.length - curr.id.clock;
              if (diff > 0) {
                if (currWrite.struct.constructor === Skip) {
                  currWrite.struct.length -= diff;
                } else {
                  curr = sliceStruct(curr, diff);
                }
              }
              if (!currWrite.struct.mergeWith(
                /** @type {any} */
                curr
              )) {
                writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
                currWrite = { struct: curr, offset: 0 };
                currDecoder.next();
              }
            }
          }
        } else {
          currWrite = { struct: (
            /** @type {Item | GC} */
            currDecoder.curr
          ), offset: 0 };
          currDecoder.next();
        }
        for (let next = currDecoder.curr; next !== null && next.id.client === firstClient && next.id.clock === currWrite.struct.id.clock + currWrite.struct.length && next.constructor !== Skip; next = currDecoder.next()) {
          writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
          currWrite = { struct: next, offset: 0 };
        }
      }
      if (currWrite !== null) {
        writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
        currWrite = null;
      }
      finishLazyStructWriting(lazyStructEncoder);
      const dss = updateDecoders.map((decoder) => readDeleteSet(decoder));
      const ds = mergeDeleteSets(dss);
      writeDeleteSet(updateEncoder, ds);
      return updateEncoder.toUint8Array();
    };
    diffUpdateV2 = (update, sv, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
      const state = decodeStateVector(sv);
      const encoder3 = new YEncoder();
      const lazyStructWriter = new LazyStructWriter(encoder3);
      const decoder = new YDecoder(createDecoder(update));
      const reader = new LazyStructReader(decoder, false);
      while (reader.curr) {
        const curr = reader.curr;
        const currClient = curr.id.client;
        const svClock = state.get(currClient) || 0;
        if (reader.curr.constructor === Skip) {
          reader.next();
          continue;
        }
        if (curr.id.clock + curr.length > svClock) {
          writeStructToLazyStructWriter(lazyStructWriter, curr, max(svClock - curr.id.clock, 0));
          reader.next();
          while (reader.curr && reader.curr.id.client === currClient) {
            writeStructToLazyStructWriter(lazyStructWriter, reader.curr, 0);
            reader.next();
          }
        } else {
          while (reader.curr && reader.curr.id.client === currClient && reader.curr.id.clock + reader.curr.length <= svClock) {
            reader.next();
          }
        }
      }
      finishLazyStructWriting(lazyStructWriter);
      const ds = readDeleteSet(decoder);
      writeDeleteSet(encoder3, ds);
      return encoder3.toUint8Array();
    };
    flushLazyStructWriter = (lazyWriter) => {
      if (lazyWriter.written > 0) {
        lazyWriter.clientStructs.push({ written: lazyWriter.written, restEncoder: toUint8Array(lazyWriter.encoder.restEncoder) });
        lazyWriter.encoder.restEncoder = createEncoder();
        lazyWriter.written = 0;
      }
    };
    writeStructToLazyStructWriter = (lazyWriter, struct, offset) => {
      if (lazyWriter.written > 0 && lazyWriter.currClient !== struct.id.client) {
        flushLazyStructWriter(lazyWriter);
      }
      if (lazyWriter.written === 0) {
        lazyWriter.currClient = struct.id.client;
        lazyWriter.encoder.writeClient(struct.id.client);
        writeVarUint(lazyWriter.encoder.restEncoder, struct.id.clock + offset);
      }
      struct.write(lazyWriter.encoder, offset);
      lazyWriter.written++;
    };
    finishLazyStructWriting = (lazyWriter) => {
      flushLazyStructWriter(lazyWriter);
      const restEncoder = lazyWriter.encoder.restEncoder;
      writeVarUint(restEncoder, lazyWriter.clientStructs.length);
      for (let i = 0; i < lazyWriter.clientStructs.length; i++) {
        const partStructs = lazyWriter.clientStructs[i];
        writeVarUint(restEncoder, partStructs.written);
        writeUint8Array(restEncoder, partStructs.restEncoder);
      }
    };
    convertUpdateFormat = (update, blockTransformer, YDecoder, YEncoder) => {
      const updateDecoder = new YDecoder(createDecoder(update));
      const lazyDecoder = new LazyStructReader(updateDecoder, false);
      const updateEncoder = new YEncoder();
      const lazyWriter = new LazyStructWriter(updateEncoder);
      for (let curr = lazyDecoder.curr; curr !== null; curr = lazyDecoder.next()) {
        writeStructToLazyStructWriter(lazyWriter, blockTransformer(curr), 0);
      }
      finishLazyStructWriting(lazyWriter);
      const ds = readDeleteSet(updateDecoder);
      writeDeleteSet(updateEncoder, ds);
      return updateEncoder.toUint8Array();
    };
    convertUpdateFormatV2ToV1 = (update) => convertUpdateFormat(update, id, UpdateDecoderV2, UpdateEncoderV1);
    errorComputeChanges = "You must not compute changes after the event-handler fired.";
    YEvent = class {
      /**
       * @param {T} target The changed type.
       * @param {Transaction} transaction
       */
      constructor(target, transaction) {
        this.target = target;
        this.currentTarget = target;
        this.transaction = transaction;
        this._changes = null;
        this._keys = null;
        this._delta = null;
        this._path = null;
      }
      /**
       * Computes the path from `y` to the changed type.
       *
       * @todo v14 should standardize on path: Array<{parent, index}> because that is easier to work with.
       *
       * The following property holds:
       * @example
       *   let type = y
       *   event.path.forEach(dir => {
       *     type = type.get(dir)
       *   })
       *   type === event.target // => true
       */
      get path() {
        return this._path || (this._path = getPathTo(this.currentTarget, this.target));
      }
      /**
       * Check if a struct is deleted by this event.
       *
       * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
       *
       * @param {AbstractStruct} struct
       * @return {boolean}
       */
      deletes(struct) {
        return isDeleted(this.transaction.deleteSet, struct.id);
      }
      /**
       * @type {Map<string, { action: 'add' | 'update' | 'delete', oldValue: any }>}
       */
      get keys() {
        if (this._keys === null) {
          if (this.transaction.doc._transactionCleanups.length === 0) {
            throw create2(errorComputeChanges);
          }
          const keys3 = /* @__PURE__ */ new Map();
          const target = this.target;
          const changed = (
            /** @type Set<string|null> */
            this.transaction.changed.get(target)
          );
          changed.forEach((key) => {
            if (key !== null) {
              const item = (
                /** @type {Item} */
                target._map.get(key)
              );
              let action;
              let oldValue;
              if (this.adds(item)) {
                let prev = item.left;
                while (prev !== null && this.adds(prev)) {
                  prev = prev.left;
                }
                if (this.deletes(item)) {
                  if (prev !== null && this.deletes(prev)) {
                    action = "delete";
                    oldValue = last(prev.content.getContent());
                  } else {
                    return;
                  }
                } else {
                  if (prev !== null && this.deletes(prev)) {
                    action = "update";
                    oldValue = last(prev.content.getContent());
                  } else {
                    action = "add";
                    oldValue = void 0;
                  }
                }
              } else {
                if (this.deletes(item)) {
                  action = "delete";
                  oldValue = last(
                    /** @type {Item} */
                    item.content.getContent()
                  );
                } else {
                  return;
                }
              }
              keys3.set(key, { action, oldValue });
            }
          });
          this._keys = keys3;
        }
        return this._keys;
      }
      /**
       * This is a computed property. Note that this can only be safely computed during the
       * event call. Computing this property after other changes happened might result in
       * unexpected behavior (incorrect computation of deltas). A safe way to collect changes
       * is to store the `changes` or the `delta` object. Avoid storing the `transaction` object.
       *
       * @type {Array<{insert?: string | Array<any> | object | AbstractType<any>, retain?: number, delete?: number, attributes?: Object<string, any>}>}
       */
      get delta() {
        return this.changes.delta;
      }
      /**
       * Check if a struct is added by this event.
       *
       * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
       *
       * @param {AbstractStruct} struct
       * @return {boolean}
       */
      adds(struct) {
        return struct.id.clock >= (this.transaction.beforeState.get(struct.id.client) || 0);
      }
      /**
       * This is a computed property. Note that this can only be safely computed during the
       * event call. Computing this property after other changes happened might result in
       * unexpected behavior (incorrect computation of deltas). A safe way to collect changes
       * is to store the `changes` or the `delta` object. Avoid storing the `transaction` object.
       *
       * @type {{added:Set<Item>,deleted:Set<Item>,keys:Map<string,{action:'add'|'update'|'delete',oldValue:any}>,delta:Array<{insert?:Array<any>|string, delete?:number, retain?:number}>}}
       */
      get changes() {
        let changes = this._changes;
        if (changes === null) {
          if (this.transaction.doc._transactionCleanups.length === 0) {
            throw create2(errorComputeChanges);
          }
          const target = this.target;
          const added = create();
          const deleted = create();
          const delta = [];
          changes = {
            added,
            deleted,
            delta,
            keys: this.keys
          };
          const changed = (
            /** @type Set<string|null> */
            this.transaction.changed.get(target)
          );
          if (changed.has(null)) {
            let lastOp = null;
            const packOp = () => {
              if (lastOp) {
                delta.push(lastOp);
              }
            };
            for (let item = target._start; item !== null; item = item.right) {
              if (item.deleted) {
                if (this.deletes(item) && !this.adds(item)) {
                  if (lastOp === null || lastOp.delete === void 0) {
                    packOp();
                    lastOp = { delete: 0 };
                  }
                  lastOp.delete += item.length;
                  deleted.add(item);
                }
              } else {
                if (this.adds(item)) {
                  if (lastOp === null || lastOp.insert === void 0) {
                    packOp();
                    lastOp = { insert: [] };
                  }
                  lastOp.insert = lastOp.insert.concat(item.content.getContent());
                  added.add(item);
                } else {
                  if (lastOp === null || lastOp.retain === void 0) {
                    packOp();
                    lastOp = { retain: 0 };
                  }
                  lastOp.retain += item.length;
                }
              }
            }
            if (lastOp !== null && lastOp.retain === void 0) {
              packOp();
            }
          }
          this._changes = changes;
        }
        return (
          /** @type {any} */
          changes
        );
      }
    };
    getPathTo = (parent, child) => {
      const path12 = [];
      while (child._item !== null && child !== parent) {
        if (child._item.parentSub !== null) {
          path12.unshift(child._item.parentSub);
        } else {
          let i = 0;
          let c = (
            /** @type {AbstractType<any>} */
            child._item.parent._start
          );
          while (c !== child._item && c !== null) {
            if (!c.deleted && c.countable) {
              i += c.length;
            }
            c = c.right;
          }
          path12.unshift(i);
        }
        child = /** @type {AbstractType<any>} */
        child._item.parent;
      }
      return path12;
    };
    warnPrematureAccess = () => {
      warn("Invalid access: Add Yjs type to a document before reading data.");
    };
    maxSearchMarker = 80;
    globalSearchMarkerTimestamp = 0;
    ArraySearchMarker = class {
      /**
       * @param {Item} p
       * @param {number} index
       */
      constructor(p, index) {
        p.marker = true;
        this.p = p;
        this.index = index;
        this.timestamp = globalSearchMarkerTimestamp++;
      }
    };
    refreshMarkerTimestamp = (marker) => {
      marker.timestamp = globalSearchMarkerTimestamp++;
    };
    overwriteMarker = (marker, p, index) => {
      marker.p.marker = false;
      marker.p = p;
      p.marker = true;
      marker.index = index;
      marker.timestamp = globalSearchMarkerTimestamp++;
    };
    markPosition = (searchMarker, p, index) => {
      if (searchMarker.length >= maxSearchMarker) {
        const marker = searchMarker.reduce((a, b) => a.timestamp < b.timestamp ? a : b);
        overwriteMarker(marker, p, index);
        return marker;
      } else {
        const pm = new ArraySearchMarker(p, index);
        searchMarker.push(pm);
        return pm;
      }
    };
    findMarker = (yarray, index) => {
      if (yarray._start === null || index === 0 || yarray._searchMarker === null) {
        return null;
      }
      const marker = yarray._searchMarker.length === 0 ? null : yarray._searchMarker.reduce((a, b) => abs(index - a.index) < abs(index - b.index) ? a : b);
      let p = yarray._start;
      let pindex = 0;
      if (marker !== null) {
        p = marker.p;
        pindex = marker.index;
        refreshMarkerTimestamp(marker);
      }
      while (p.right !== null && pindex < index) {
        if (!p.deleted && p.countable) {
          if (index < pindex + p.length) {
            break;
          }
          pindex += p.length;
        }
        p = p.right;
      }
      while (p.left !== null && pindex > index) {
        p = p.left;
        if (!p.deleted && p.countable) {
          pindex -= p.length;
        }
      }
      while (p.left !== null && p.left.id.client === p.id.client && p.left.id.clock + p.left.length === p.id.clock) {
        p = p.left;
        if (!p.deleted && p.countable) {
          pindex -= p.length;
        }
      }
      if (marker !== null && abs(marker.index - pindex) < /** @type {YText|YArray<any>} */
      p.parent.length / maxSearchMarker) {
        overwriteMarker(marker, p, pindex);
        return marker;
      } else {
        return markPosition(yarray._searchMarker, p, pindex);
      }
    };
    updateMarkerChanges = (searchMarker, index, len) => {
      for (let i = searchMarker.length - 1; i >= 0; i--) {
        const m = searchMarker[i];
        if (len > 0) {
          let p = m.p;
          p.marker = false;
          while (p && (p.deleted || !p.countable)) {
            p = p.left;
            if (p && !p.deleted && p.countable) {
              m.index -= p.length;
            }
          }
          if (p === null || p.marker === true) {
            searchMarker.splice(i, 1);
            continue;
          }
          m.p = p;
          p.marker = true;
        }
        if (index < m.index || len > 0 && index === m.index) {
          m.index = max(index, m.index + len);
        }
      }
    };
    callTypeObservers = (type, transaction, event) => {
      const changedType = type;
      const changedParentTypes = transaction.changedParentTypes;
      while (true) {
        setIfUndefined(changedParentTypes, type, () => []).push(event);
        if (type._item === null) {
          break;
        }
        type = /** @type {AbstractType<any>} */
        type._item.parent;
      }
      callEventHandlerListeners(changedType._eH, event, transaction);
    };
    AbstractType = class {
      constructor() {
        this._item = null;
        this._map = /* @__PURE__ */ new Map();
        this._start = null;
        this.doc = null;
        this._length = 0;
        this._eH = createEventHandler();
        this._dEH = createEventHandler();
        this._searchMarker = null;
      }
      /**
       * @return {AbstractType<any>|null}
       */
      get parent() {
        return this._item ? (
          /** @type {AbstractType<any>} */
          this._item.parent
        ) : null;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item|null} item
       */
      _integrate(y, item) {
        this.doc = y;
        this._item = item;
      }
      /**
       * @return {AbstractType<EventType>}
       */
      _copy() {
        throw methodUnimplemented();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {AbstractType<EventType>}
       */
      clone() {
        throw methodUnimplemented();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} _encoder
       */
      _write(_encoder) {
      }
      /**
       * The first non-deleted item
       */
      get _first() {
        let n = this._start;
        while (n !== null && n.deleted) {
          n = n.right;
        }
        return n;
      }
      /**
       * Creates YEvent and calls all type observers.
       * Must be implemented by each type.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} _parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, _parentSubs) {
        if (!transaction.local && this._searchMarker) {
          this._searchMarker.length = 0;
        }
      }
      /**
       * Observe all events that are created on this type.
       *
       * @param {function(EventType, Transaction):void} f Observer function
       */
      observe(f) {
        addEventHandlerListener(this._eH, f);
      }
      /**
       * Observe all events that are created by this type and its children.
       *
       * @param {function(Array<YEvent<any>>,Transaction):void} f Observer function
       */
      observeDeep(f) {
        addEventHandlerListener(this._dEH, f);
      }
      /**
       * Unregister an observer function.
       *
       * @param {function(EventType,Transaction):void} f Observer function
       */
      unobserve(f) {
        removeEventHandlerListener(this._eH, f);
      }
      /**
       * Unregister an observer function.
       *
       * @param {function(Array<YEvent<any>>,Transaction):void} f Observer function
       */
      unobserveDeep(f) {
        removeEventHandlerListener(this._dEH, f);
      }
      /**
       * @abstract
       * @return {any}
       */
      toJSON() {
      }
    };
    typeListSlice = (type, start, end) => {
      type.doc ?? warnPrematureAccess();
      if (start < 0) {
        start = type._length + start;
      }
      if (end < 0) {
        end = type._length + end;
      }
      let len = end - start;
      const cs = [];
      let n = type._start;
      while (n !== null && len > 0) {
        if (n.countable && !n.deleted) {
          const c = n.content.getContent();
          if (c.length <= start) {
            start -= c.length;
          } else {
            for (let i = start; i < c.length && len > 0; i++) {
              cs.push(c[i]);
              len--;
            }
            start = 0;
          }
        }
        n = n.right;
      }
      return cs;
    };
    typeListToArray = (type) => {
      type.doc ?? warnPrematureAccess();
      const cs = [];
      let n = type._start;
      while (n !== null) {
        if (n.countable && !n.deleted) {
          const c = n.content.getContent();
          for (let i = 0; i < c.length; i++) {
            cs.push(c[i]);
          }
        }
        n = n.right;
      }
      return cs;
    };
    typeListForEach = (type, f) => {
      let index = 0;
      let n = type._start;
      type.doc ?? warnPrematureAccess();
      while (n !== null) {
        if (n.countable && !n.deleted) {
          const c = n.content.getContent();
          for (let i = 0; i < c.length; i++) {
            f(c[i], index++, type);
          }
        }
        n = n.right;
      }
    };
    typeListMap = (type, f) => {
      const result = [];
      typeListForEach(type, (c, i) => {
        result.push(f(c, i, type));
      });
      return result;
    };
    typeListCreateIterator = (type) => {
      let n = type._start;
      let currentContent = null;
      let currentContentIndex = 0;
      return {
        [Symbol.iterator]() {
          return this;
        },
        next: () => {
          if (currentContent === null) {
            while (n !== null && n.deleted) {
              n = n.right;
            }
            if (n === null) {
              return {
                done: true,
                value: void 0
              };
            }
            currentContent = n.content.getContent();
            currentContentIndex = 0;
            n = n.right;
          }
          const value2 = currentContent[currentContentIndex++];
          if (currentContent.length <= currentContentIndex) {
            currentContent = null;
          }
          return {
            done: false,
            value: value2
          };
        }
      };
    };
    typeListGet = (type, index) => {
      type.doc ?? warnPrematureAccess();
      const marker = findMarker(type, index);
      let n = type._start;
      if (marker !== null) {
        n = marker.p;
        index -= marker.index;
      }
      for (; n !== null; n = n.right) {
        if (!n.deleted && n.countable) {
          if (index < n.length) {
            return n.content.getContent()[index];
          }
          index -= n.length;
        }
      }
    };
    typeListInsertGenericsAfter = (transaction, parent, referenceItem, content) => {
      let left = referenceItem;
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      const store = doc.store;
      const right = referenceItem === null ? parent._start : referenceItem.right;
      let jsonContent = [];
      const packJsonContent = () => {
        if (jsonContent.length > 0) {
          left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentAny(jsonContent));
          left.integrate(transaction, 0);
          jsonContent = [];
        }
      };
      content.forEach((c) => {
        if (c === null) {
          jsonContent.push(c);
        } else {
          switch (c.constructor) {
            case Number:
            case Object:
            case Boolean:
            case Array:
            case String:
              jsonContent.push(c);
              break;
            default:
              packJsonContent();
              switch (c.constructor) {
                case Uint8Array:
                case ArrayBuffer:
                  left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentBinary(new Uint8Array(
                    /** @type {Uint8Array} */
                    c
                  )));
                  left.integrate(transaction, 0);
                  break;
                case Doc:
                  left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentDoc(
                    /** @type {Doc} */
                    c
                  ));
                  left.integrate(transaction, 0);
                  break;
                default:
                  if (c instanceof AbstractType) {
                    left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentType(c));
                    left.integrate(transaction, 0);
                  } else {
                    throw new Error("Unexpected content type in insert operation");
                  }
              }
          }
        }
      });
      packJsonContent();
    };
    lengthExceeded = () => create2("Length exceeded!");
    typeListInsertGenerics = (transaction, parent, index, content) => {
      if (index > parent._length) {
        throw lengthExceeded();
      }
      if (index === 0) {
        if (parent._searchMarker) {
          updateMarkerChanges(parent._searchMarker, index, content.length);
        }
        return typeListInsertGenericsAfter(transaction, parent, null, content);
      }
      const startIndex = index;
      const marker = findMarker(parent, index);
      let n = parent._start;
      if (marker !== null) {
        n = marker.p;
        index -= marker.index;
        if (index === 0) {
          n = n.prev;
          index += n && n.countable && !n.deleted ? n.length : 0;
        }
      }
      for (; n !== null; n = n.right) {
        if (!n.deleted && n.countable) {
          if (index <= n.length) {
            if (index < n.length) {
              getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index));
            }
            break;
          }
          index -= n.length;
        }
      }
      if (parent._searchMarker) {
        updateMarkerChanges(parent._searchMarker, startIndex, content.length);
      }
      return typeListInsertGenericsAfter(transaction, parent, n, content);
    };
    typeListPushGenerics = (transaction, parent, content) => {
      const marker = (parent._searchMarker || []).reduce((maxMarker, currMarker) => currMarker.index > maxMarker.index ? currMarker : maxMarker, { index: 0, p: parent._start });
      let n = marker.p;
      if (n) {
        while (n.right) {
          n = n.right;
        }
      }
      return typeListInsertGenericsAfter(transaction, parent, n, content);
    };
    typeListDelete = (transaction, parent, index, length2) => {
      if (length2 === 0) {
        return;
      }
      const startIndex = index;
      const startLength = length2;
      const marker = findMarker(parent, index);
      let n = parent._start;
      if (marker !== null) {
        n = marker.p;
        index -= marker.index;
      }
      for (; n !== null && index > 0; n = n.right) {
        if (!n.deleted && n.countable) {
          if (index < n.length) {
            getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index));
          }
          index -= n.length;
        }
      }
      while (length2 > 0 && n !== null) {
        if (!n.deleted) {
          if (length2 < n.length) {
            getItemCleanStart(transaction, createID(n.id.client, n.id.clock + length2));
          }
          n.delete(transaction);
          length2 -= n.length;
        }
        n = n.right;
      }
      if (length2 > 0) {
        throw lengthExceeded();
      }
      if (parent._searchMarker) {
        updateMarkerChanges(
          parent._searchMarker,
          startIndex,
          -startLength + length2
          /* in case we remove the above exception */
        );
      }
    };
    typeMapDelete = (transaction, parent, key) => {
      const c = parent._map.get(key);
      if (c !== void 0) {
        c.delete(transaction);
      }
    };
    typeMapSet = (transaction, parent, key, value2) => {
      const left = parent._map.get(key) || null;
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      let content;
      if (value2 == null) {
        content = new ContentAny([value2]);
      } else {
        switch (value2.constructor) {
          case Number:
          case Object:
          case Boolean:
          case Array:
          case String:
          case Date:
          case BigInt:
            content = new ContentAny([value2]);
            break;
          case Uint8Array:
            content = new ContentBinary(
              /** @type {Uint8Array} */
              value2
            );
            break;
          case Doc:
            content = new ContentDoc(
              /** @type {Doc} */
              value2
            );
            break;
          default:
            if (value2 instanceof AbstractType) {
              content = new ContentType(value2);
            } else {
              throw new Error("Unexpected content type");
            }
        }
      }
      new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, null, null, parent, key, content).integrate(transaction, 0);
    };
    typeMapGet = (parent, key) => {
      parent.doc ?? warnPrematureAccess();
      const val = parent._map.get(key);
      return val !== void 0 && !val.deleted ? val.content.getContent()[val.length - 1] : void 0;
    };
    typeMapGetAll = (parent) => {
      const res = {};
      parent.doc ?? warnPrematureAccess();
      parent._map.forEach((value2, key) => {
        if (!value2.deleted) {
          res[key] = value2.content.getContent()[value2.length - 1];
        }
      });
      return res;
    };
    typeMapHas = (parent, key) => {
      parent.doc ?? warnPrematureAccess();
      const val = parent._map.get(key);
      return val !== void 0 && !val.deleted;
    };
    typeMapGetAllSnapshot = (parent, snapshot) => {
      const res = {};
      parent._map.forEach((value2, key) => {
        let v = value2;
        while (v !== null && (!snapshot.sv.has(v.id.client) || v.id.clock >= (snapshot.sv.get(v.id.client) || 0))) {
          v = v.left;
        }
        if (v !== null && isVisible(v, snapshot)) {
          res[key] = v.content.getContent()[v.length - 1];
        }
      });
      return res;
    };
    createMapIterator = (type) => {
      type.doc ?? warnPrematureAccess();
      return iteratorFilter(
        type._map.entries(),
        /** @param {any} entry */
        (entry) => !entry[1].deleted
      );
    };
    YArrayEvent = class extends YEvent {
    };
    YArray = class _YArray extends AbstractType {
      constructor() {
        super();
        this._prelimContent = [];
        this._searchMarker = [];
      }
      /**
       * Construct a new YArray containing the specified items.
       * @template {Object<string,any>|Array<any>|number|null|string|Uint8Array} T
       * @param {Array<T>} items
       * @return {YArray<T>}
       */
      static from(items) {
        const a = new _YArray();
        a.push(items);
        return a;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        this.insert(
          0,
          /** @type {Array<any>} */
          this._prelimContent
        );
        this._prelimContent = null;
      }
      /**
       * @return {YArray<T>}
       */
      _copy() {
        return new _YArray();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YArray<T>}
       */
      clone() {
        const arr = new _YArray();
        arr.insert(0, this.toArray().map(
          (el) => el instanceof AbstractType ? (
            /** @type {typeof el} */
            el.clone()
          ) : el
        ));
        return arr;
      }
      get length() {
        this.doc ?? warnPrematureAccess();
        return this._length;
      }
      /**
       * Creates YArrayEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        super._callObserver(transaction, parentSubs);
        callTypeObservers(this, transaction, new YArrayEvent(this, transaction));
      }
      /**
       * Inserts new content at an index.
       *
       * Important: This function expects an array of content. Not just a content
       * object. The reason for this "weirdness" is that inserting several elements
       * is very efficient when it is done as a single operation.
       *
       * @example
       *  // Insert character 'a' at position 0
       *  yarray.insert(0, ['a'])
       *  // Insert numbers 1, 2 at position 1
       *  yarray.insert(1, [1, 2])
       *
       * @param {number} index The index to insert content at.
       * @param {Array<T>} content The array of content
       */
      insert(index, content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListInsertGenerics(
              transaction,
              this,
              index,
              /** @type {any} */
              content
            );
          });
        } else {
          this._prelimContent.splice(index, 0, ...content);
        }
      }
      /**
       * Appends content to this YArray.
       *
       * @param {Array<T>} content Array of content to append.
       *
       * @todo Use the following implementation in all types.
       */
      push(content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListPushGenerics(
              transaction,
              this,
              /** @type {any} */
              content
            );
          });
        } else {
          this._prelimContent.push(...content);
        }
      }
      /**
       * Prepends content to this YArray.
       *
       * @param {Array<T>} content Array of content to prepend.
       */
      unshift(content) {
        this.insert(0, content);
      }
      /**
       * Deletes elements starting from an index.
       *
       * @param {number} index Index at which to start deleting elements
       * @param {number} length The number of elements to remove. Defaults to 1.
       */
      delete(index, length2 = 1) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListDelete(transaction, this, index, length2);
          });
        } else {
          this._prelimContent.splice(index, length2);
        }
      }
      /**
       * Returns the i-th element from a YArray.
       *
       * @param {number} index The index of the element to return from the YArray
       * @return {T}
       */
      get(index) {
        return typeListGet(this, index);
      }
      /**
       * Transforms this YArray to a JavaScript Array.
       *
       * @return {Array<T>}
       */
      toArray() {
        return typeListToArray(this);
      }
      /**
       * Returns a portion of this YArray into a JavaScript Array selected
       * from start to end (end not included).
       *
       * @param {number} [start]
       * @param {number} [end]
       * @return {Array<T>}
       */
      slice(start = 0, end = this.length) {
        return typeListSlice(this, start, end);
      }
      /**
       * Transforms this Shared Type to a JSON object.
       *
       * @return {Array<any>}
       */
      toJSON() {
        return this.map((c) => c instanceof AbstractType ? c.toJSON() : c);
      }
      /**
       * Returns an Array with the result of calling a provided function on every
       * element of this YArray.
       *
       * @template M
       * @param {function(T,number,YArray<T>):M} f Function that produces an element of the new Array
       * @return {Array<M>} A new array with each element being the result of the
       *                 callback function
       */
      map(f) {
        return typeListMap(
          this,
          /** @type {any} */
          f
        );
      }
      /**
       * Executes a provided function once on every element of this YArray.
       *
       * @param {function(T,number,YArray<T>):void} f A function to execute on every element of this YArray.
       */
      forEach(f) {
        typeListForEach(this, f);
      }
      /**
       * @return {IterableIterator<T>}
       */
      [Symbol.iterator]() {
        return typeListCreateIterator(this);
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YArrayRefID);
      }
    };
    readYArray = (_decoder) => new YArray();
    YMapEvent = class extends YEvent {
      /**
       * @param {YMap<T>} ymap The YArray that changed.
       * @param {Transaction} transaction
       * @param {Set<any>} subs The keys that changed.
       */
      constructor(ymap, transaction, subs) {
        super(ymap, transaction);
        this.keysChanged = subs;
      }
    };
    YMap = class _YMap extends AbstractType {
      /**
       *
       * @param {Iterable<readonly [string, any]>=} entries - an optional iterable to initialize the YMap
       */
      constructor(entries) {
        super();
        this._prelimContent = null;
        if (entries === void 0) {
          this._prelimContent = /* @__PURE__ */ new Map();
        } else {
          this._prelimContent = new Map(entries);
        }
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        this._prelimContent.forEach((value2, key) => {
          this.set(key, value2);
        });
        this._prelimContent = null;
      }
      /**
       * @return {YMap<MapType>}
       */
      _copy() {
        return new _YMap();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YMap<MapType>}
       */
      clone() {
        const map = new _YMap();
        this.forEach((value2, key) => {
          map.set(key, value2 instanceof AbstractType ? (
            /** @type {typeof value} */
            value2.clone()
          ) : value2);
        });
        return map;
      }
      /**
       * Creates YMapEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        callTypeObservers(this, transaction, new YMapEvent(this, transaction, parentSubs));
      }
      /**
       * Transforms this Shared Type to a JSON object.
       *
       * @return {Object<string,any>}
       */
      toJSON() {
        this.doc ?? warnPrematureAccess();
        const map = {};
        this._map.forEach((item, key) => {
          if (!item.deleted) {
            const v = item.content.getContent()[item.length - 1];
            map[key] = v instanceof AbstractType ? v.toJSON() : v;
          }
        });
        return map;
      }
      /**
       * Returns the size of the YMap (count of key/value pairs)
       *
       * @return {number}
       */
      get size() {
        return [...createMapIterator(this)].length;
      }
      /**
       * Returns the keys for each element in the YMap Type.
       *
       * @return {IterableIterator<string>}
       */
      keys() {
        return iteratorMap(
          createMapIterator(this),
          /** @param {any} v */
          (v) => v[0]
        );
      }
      /**
       * Returns the values for each element in the YMap Type.
       *
       * @return {IterableIterator<MapType>}
       */
      values() {
        return iteratorMap(
          createMapIterator(this),
          /** @param {any} v */
          (v) => v[1].content.getContent()[v[1].length - 1]
        );
      }
      /**
       * Returns an Iterator of [key, value] pairs
       *
       * @return {IterableIterator<[string, MapType]>}
       */
      entries() {
        return iteratorMap(
          createMapIterator(this),
          /** @param {any} v */
          (v) => (
            /** @type {any} */
            [v[0], v[1].content.getContent()[v[1].length - 1]]
          )
        );
      }
      /**
       * Executes a provided function on once on every key-value pair.
       *
       * @param {function(MapType,string,YMap<MapType>):void} f A function to execute on every element of this YArray.
       */
      forEach(f) {
        this.doc ?? warnPrematureAccess();
        this._map.forEach((item, key) => {
          if (!item.deleted) {
            f(item.content.getContent()[item.length - 1], key, this);
          }
        });
      }
      /**
       * Returns an Iterator of [key, value] pairs
       *
       * @return {IterableIterator<[string, MapType]>}
       */
      [Symbol.iterator]() {
        return this.entries();
      }
      /**
       * Remove a specified element from this YMap.
       *
       * @param {string} key The key of the element to remove.
       */
      delete(key) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapDelete(transaction, this, key);
          });
        } else {
          this._prelimContent.delete(key);
        }
      }
      /**
       * Adds or updates an element with a specified key and value.
       * @template {MapType} VAL
       *
       * @param {string} key The key of the element to add to this YMap
       * @param {VAL} value The value of the element to add
       * @return {VAL}
       */
      set(key, value2) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapSet(
              transaction,
              this,
              key,
              /** @type {any} */
              value2
            );
          });
        } else {
          this._prelimContent.set(key, value2);
        }
        return value2;
      }
      /**
       * Returns a specified element from this YMap.
       *
       * @param {string} key
       * @return {MapType|undefined}
       */
      get(key) {
        return (
          /** @type {any} */
          typeMapGet(this, key)
        );
      }
      /**
       * Returns a boolean indicating whether the specified key exists or not.
       *
       * @param {string} key The key to test.
       * @return {boolean}
       */
      has(key) {
        return typeMapHas(this, key);
      }
      /**
       * Removes all elements from this YMap.
       */
      clear() {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            this.forEach(function(_value, key, map) {
              typeMapDelete(transaction, map, key);
            });
          });
        } else {
          this._prelimContent.clear();
        }
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YMapRefID);
      }
    };
    readYMap = (_decoder) => new YMap();
    equalAttrs = (a, b) => a === b || typeof a === "object" && typeof b === "object" && a && b && equalFlat(a, b);
    ItemTextListPosition = class {
      /**
       * @param {Item|null} left
       * @param {Item|null} right
       * @param {number} index
       * @param {Map<string,any>} currentAttributes
       */
      constructor(left, right, index, currentAttributes) {
        this.left = left;
        this.right = right;
        this.index = index;
        this.currentAttributes = currentAttributes;
      }
      /**
       * Only call this if you know that this.right is defined
       */
      forward() {
        if (this.right === null) {
          unexpectedCase();
        }
        switch (this.right.content.constructor) {
          case ContentFormat:
            if (!this.right.deleted) {
              updateCurrentAttributes(
                this.currentAttributes,
                /** @type {ContentFormat} */
                this.right.content
              );
            }
            break;
          default:
            if (!this.right.deleted) {
              this.index += this.right.length;
            }
            break;
        }
        this.left = this.right;
        this.right = this.right.right;
      }
    };
    findNextPosition = (transaction, pos, count) => {
      while (pos.right !== null && count > 0) {
        switch (pos.right.content.constructor) {
          case ContentFormat:
            if (!pos.right.deleted) {
              updateCurrentAttributes(
                pos.currentAttributes,
                /** @type {ContentFormat} */
                pos.right.content
              );
            }
            break;
          default:
            if (!pos.right.deleted) {
              if (count < pos.right.length) {
                getItemCleanStart(transaction, createID(pos.right.id.client, pos.right.id.clock + count));
              }
              pos.index += pos.right.length;
              count -= pos.right.length;
            }
            break;
        }
        pos.left = pos.right;
        pos.right = pos.right.right;
      }
      return pos;
    };
    findPosition = (transaction, parent, index, useSearchMarker) => {
      const currentAttributes = /* @__PURE__ */ new Map();
      const marker = useSearchMarker ? findMarker(parent, index) : null;
      if (marker) {
        const pos = new ItemTextListPosition(marker.p.left, marker.p, marker.index, currentAttributes);
        return findNextPosition(transaction, pos, index - marker.index);
      } else {
        const pos = new ItemTextListPosition(null, parent._start, 0, currentAttributes);
        return findNextPosition(transaction, pos, index);
      }
    };
    insertNegatedAttributes = (transaction, parent, currPos, negatedAttributes) => {
      while (currPos.right !== null && (currPos.right.deleted === true || currPos.right.content.constructor === ContentFormat && equalAttrs(
        negatedAttributes.get(
          /** @type {ContentFormat} */
          currPos.right.content.key
        ),
        /** @type {ContentFormat} */
        currPos.right.content.value
      ))) {
        if (!currPos.right.deleted) {
          negatedAttributes.delete(
            /** @type {ContentFormat} */
            currPos.right.content.key
          );
        }
        currPos.forward();
      }
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      negatedAttributes.forEach((val, key) => {
        const left = currPos.left;
        const right = currPos.right;
        const nextFormat = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentFormat(key, val));
        nextFormat.integrate(transaction, 0);
        currPos.right = nextFormat;
        currPos.forward();
      });
    };
    updateCurrentAttributes = (currentAttributes, format) => {
      const { key, value: value2 } = format;
      if (value2 === null) {
        currentAttributes.delete(key);
      } else {
        currentAttributes.set(key, value2);
      }
    };
    minimizeAttributeChanges = (currPos, attributes) => {
      while (true) {
        if (currPos.right === null) {
          break;
        } else if (currPos.right.deleted || currPos.right.content.constructor === ContentFormat && equalAttrs(
          attributes[
            /** @type {ContentFormat} */
            currPos.right.content.key
          ] ?? null,
          /** @type {ContentFormat} */
          currPos.right.content.value
        )) ;
        else {
          break;
        }
        currPos.forward();
      }
    };
    insertAttributes = (transaction, parent, currPos, attributes) => {
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      const negatedAttributes = /* @__PURE__ */ new Map();
      for (const key in attributes) {
        const val = attributes[key];
        const currentVal = currPos.currentAttributes.get(key) ?? null;
        if (!equalAttrs(currentVal, val)) {
          negatedAttributes.set(key, currentVal);
          const { left, right } = currPos;
          currPos.right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentFormat(key, val));
          currPos.right.integrate(transaction, 0);
          currPos.forward();
        }
      }
      return negatedAttributes;
    };
    insertText = (transaction, parent, currPos, text2, attributes) => {
      currPos.currentAttributes.forEach((_val, key) => {
        if (attributes[key] === void 0) {
          attributes[key] = null;
        }
      });
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      minimizeAttributeChanges(currPos, attributes);
      const negatedAttributes = insertAttributes(transaction, parent, currPos, attributes);
      const content = text2.constructor === String ? new ContentString(
        /** @type {string} */
        text2
      ) : text2 instanceof AbstractType ? new ContentType(text2) : new ContentEmbed(text2);
      let { left, right, index } = currPos;
      if (parent._searchMarker) {
        updateMarkerChanges(parent._searchMarker, currPos.index, content.getLength());
      }
      right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, content);
      right.integrate(transaction, 0);
      currPos.right = right;
      currPos.index = index;
      currPos.forward();
      insertNegatedAttributes(transaction, parent, currPos, negatedAttributes);
    };
    formatText = (transaction, parent, currPos, length2, attributes) => {
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      minimizeAttributeChanges(currPos, attributes);
      const negatedAttributes = insertAttributes(transaction, parent, currPos, attributes);
      iterationLoop: while (currPos.right !== null && (length2 > 0 || negatedAttributes.size > 0 && (currPos.right.deleted || currPos.right.content.constructor === ContentFormat))) {
        if (!currPos.right.deleted) {
          switch (currPos.right.content.constructor) {
            case ContentFormat: {
              const { key, value: value2 } = (
                /** @type {ContentFormat} */
                currPos.right.content
              );
              const attr = attributes[key];
              if (attr !== void 0) {
                if (equalAttrs(attr, value2)) {
                  negatedAttributes.delete(key);
                } else {
                  if (length2 === 0) {
                    break iterationLoop;
                  }
                  negatedAttributes.set(key, value2);
                }
                currPos.right.delete(transaction);
              } else {
                currPos.currentAttributes.set(key, value2);
              }
              break;
            }
            default:
              if (length2 < currPos.right.length) {
                getItemCleanStart(transaction, createID(currPos.right.id.client, currPos.right.id.clock + length2));
              }
              length2 -= currPos.right.length;
              break;
          }
        }
        currPos.forward();
      }
      if (length2 > 0) {
        let newlines = "";
        for (; length2 > 0; length2--) {
          newlines += "\n";
        }
        currPos.right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), currPos.left, currPos.left && currPos.left.lastId, currPos.right, currPos.right && currPos.right.id, parent, null, new ContentString(newlines));
        currPos.right.integrate(transaction, 0);
        currPos.forward();
      }
      insertNegatedAttributes(transaction, parent, currPos, negatedAttributes);
    };
    cleanupFormattingGap = (transaction, start, curr, startAttributes, currAttributes) => {
      let end = start;
      const endFormats = create3();
      while (end && (!end.countable || end.deleted)) {
        if (!end.deleted && end.content.constructor === ContentFormat) {
          const cf = (
            /** @type {ContentFormat} */
            end.content
          );
          endFormats.set(cf.key, cf);
        }
        end = end.right;
      }
      let cleanups = 0;
      let reachedCurr = false;
      while (start !== end) {
        if (curr === start) {
          reachedCurr = true;
        }
        if (!start.deleted) {
          const content = start.content;
          switch (content.constructor) {
            case ContentFormat: {
              const { key, value: value2 } = (
                /** @type {ContentFormat} */
                content
              );
              const startAttrValue = startAttributes.get(key) ?? null;
              if (endFormats.get(key) !== content || startAttrValue === value2) {
                start.delete(transaction);
                cleanups++;
                if (!reachedCurr && (currAttributes.get(key) ?? null) === value2 && startAttrValue !== value2) {
                  if (startAttrValue === null) {
                    currAttributes.delete(key);
                  } else {
                    currAttributes.set(key, startAttrValue);
                  }
                }
              }
              if (!reachedCurr && !start.deleted) {
                updateCurrentAttributes(
                  currAttributes,
                  /** @type {ContentFormat} */
                  content
                );
              }
              break;
            }
          }
        }
        start = /** @type {Item} */
        start.right;
      }
      return cleanups;
    };
    cleanupContextlessFormattingGap = (transaction, item) => {
      while (item && item.right && (item.right.deleted || !item.right.countable)) {
        item = item.right;
      }
      const attrs = /* @__PURE__ */ new Set();
      while (item && (item.deleted || !item.countable)) {
        if (!item.deleted && item.content.constructor === ContentFormat) {
          const key = (
            /** @type {ContentFormat} */
            item.content.key
          );
          if (attrs.has(key)) {
            item.delete(transaction);
          } else {
            attrs.add(key);
          }
        }
        item = item.left;
      }
    };
    cleanupYTextFormatting = (type) => {
      let res = 0;
      transact(
        /** @type {Doc} */
        type.doc,
        (transaction) => {
          let start = (
            /** @type {Item} */
            type._start
          );
          let end = type._start;
          let startAttributes = create3();
          const currentAttributes = copy(startAttributes);
          while (end) {
            if (end.deleted === false) {
              switch (end.content.constructor) {
                case ContentFormat:
                  updateCurrentAttributes(
                    currentAttributes,
                    /** @type {ContentFormat} */
                    end.content
                  );
                  break;
                default:
                  res += cleanupFormattingGap(transaction, start, end, startAttributes, currentAttributes);
                  startAttributes = copy(currentAttributes);
                  start = end;
                  break;
              }
            }
            end = end.right;
          }
        }
      );
      return res;
    };
    cleanupYTextAfterTransaction = (transaction) => {
      const needFullCleanup = /* @__PURE__ */ new Set();
      const doc = transaction.doc;
      for (const [client, afterClock] of transaction.afterState.entries()) {
        const clock = transaction.beforeState.get(client) || 0;
        if (afterClock === clock) {
          continue;
        }
        iterateStructs(
          transaction,
          /** @type {Array<Item|GC>} */
          doc.store.clients.get(client),
          clock,
          afterClock,
          (item) => {
            if (!item.deleted && /** @type {Item} */
            item.content.constructor === ContentFormat && item.constructor !== GC) {
              needFullCleanup.add(
                /** @type {any} */
                item.parent
              );
            }
          }
        );
      }
      transact(doc, (t) => {
        iterateDeletedStructs(transaction, transaction.deleteSet, (item) => {
          if (item instanceof GC || !/** @type {YText} */
          item.parent._hasFormatting || needFullCleanup.has(
            /** @type {YText} */
            item.parent
          )) {
            return;
          }
          const parent = (
            /** @type {YText} */
            item.parent
          );
          if (item.content.constructor === ContentFormat) {
            needFullCleanup.add(parent);
          } else {
            cleanupContextlessFormattingGap(t, item);
          }
        });
        for (const yText of needFullCleanup) {
          cleanupYTextFormatting(yText);
        }
      });
    };
    deleteText = (transaction, currPos, length2) => {
      const startLength = length2;
      const startAttrs = copy(currPos.currentAttributes);
      const start = currPos.right;
      while (length2 > 0 && currPos.right !== null) {
        if (currPos.right.deleted === false) {
          switch (currPos.right.content.constructor) {
            case ContentType:
            case ContentEmbed:
            case ContentString:
              if (length2 < currPos.right.length) {
                getItemCleanStart(transaction, createID(currPos.right.id.client, currPos.right.id.clock + length2));
              }
              length2 -= currPos.right.length;
              currPos.right.delete(transaction);
              break;
          }
        }
        currPos.forward();
      }
      if (start) {
        cleanupFormattingGap(transaction, start, currPos.right, startAttrs, currPos.currentAttributes);
      }
      const parent = (
        /** @type {AbstractType<any>} */
        /** @type {Item} */
        (currPos.left || currPos.right).parent
      );
      if (parent._searchMarker) {
        updateMarkerChanges(parent._searchMarker, currPos.index, -startLength + length2);
      }
      return currPos;
    };
    YTextEvent = class extends YEvent {
      /**
       * @param {YText} ytext
       * @param {Transaction} transaction
       * @param {Set<any>} subs The keys that changed
       */
      constructor(ytext, transaction, subs) {
        super(ytext, transaction);
        this.childListChanged = false;
        this.keysChanged = /* @__PURE__ */ new Set();
        subs.forEach((sub) => {
          if (sub === null) {
            this.childListChanged = true;
          } else {
            this.keysChanged.add(sub);
          }
        });
      }
      /**
       * @type {{added:Set<Item>,deleted:Set<Item>,keys:Map<string,{action:'add'|'update'|'delete',oldValue:any}>,delta:Array<{insert?:Array<any>|string, delete?:number, retain?:number}>}}
       */
      get changes() {
        if (this._changes === null) {
          const changes = {
            keys: this.keys,
            delta: this.delta,
            added: /* @__PURE__ */ new Set(),
            deleted: /* @__PURE__ */ new Set()
          };
          this._changes = changes;
        }
        return (
          /** @type {any} */
          this._changes
        );
      }
      /**
       * Compute the changes in the delta format.
       * A {@link https://quilljs.com/docs/delta/|Quill Delta}) that represents the changes on the document.
       *
       * @type {Array<{insert?:string|object|AbstractType<any>, delete?:number, retain?:number, attributes?: Object<string,any>}>}
       *
       * @public
       */
      get delta() {
        if (this._delta === null) {
          const y = (
            /** @type {Doc} */
            this.target.doc
          );
          const delta = [];
          transact(y, (transaction) => {
            const currentAttributes = /* @__PURE__ */ new Map();
            const oldAttributes = /* @__PURE__ */ new Map();
            let item = this.target._start;
            let action = null;
            const attributes = {};
            let insert = "";
            let retain = 0;
            let deleteLen = 0;
            const addOp = () => {
              if (action !== null) {
                let op = null;
                switch (action) {
                  case "delete":
                    if (deleteLen > 0) {
                      op = { delete: deleteLen };
                    }
                    deleteLen = 0;
                    break;
                  case "insert":
                    if (typeof insert === "object" || insert.length > 0) {
                      op = { insert };
                      if (currentAttributes.size > 0) {
                        op.attributes = {};
                        currentAttributes.forEach((value2, key) => {
                          if (value2 !== null) {
                            op.attributes[key] = value2;
                          }
                        });
                      }
                    }
                    insert = "";
                    break;
                  case "retain":
                    if (retain > 0) {
                      op = { retain };
                      if (!isEmpty(attributes)) {
                        op.attributes = assign({}, attributes);
                      }
                    }
                    retain = 0;
                    break;
                }
                if (op) delta.push(op);
                action = null;
              }
            };
            while (item !== null) {
              switch (item.content.constructor) {
                case ContentType:
                case ContentEmbed:
                  if (this.adds(item)) {
                    if (!this.deletes(item)) {
                      addOp();
                      action = "insert";
                      insert = item.content.getContent()[0];
                      addOp();
                    }
                  } else if (this.deletes(item)) {
                    if (action !== "delete") {
                      addOp();
                      action = "delete";
                    }
                    deleteLen += 1;
                  } else if (!item.deleted) {
                    if (action !== "retain") {
                      addOp();
                      action = "retain";
                    }
                    retain += 1;
                  }
                  break;
                case ContentString:
                  if (this.adds(item)) {
                    if (!this.deletes(item)) {
                      if (action !== "insert") {
                        addOp();
                        action = "insert";
                      }
                      insert += /** @type {ContentString} */
                      item.content.str;
                    }
                  } else if (this.deletes(item)) {
                    if (action !== "delete") {
                      addOp();
                      action = "delete";
                    }
                    deleteLen += item.length;
                  } else if (!item.deleted) {
                    if (action !== "retain") {
                      addOp();
                      action = "retain";
                    }
                    retain += item.length;
                  }
                  break;
                case ContentFormat: {
                  const { key, value: value2 } = (
                    /** @type {ContentFormat} */
                    item.content
                  );
                  if (this.adds(item)) {
                    if (!this.deletes(item)) {
                      const curVal = currentAttributes.get(key) ?? null;
                      if (!equalAttrs(curVal, value2)) {
                        if (action === "retain") {
                          addOp();
                        }
                        if (equalAttrs(value2, oldAttributes.get(key) ?? null)) {
                          delete attributes[key];
                        } else {
                          attributes[key] = value2;
                        }
                      } else if (value2 !== null) {
                        item.delete(transaction);
                      }
                    }
                  } else if (this.deletes(item)) {
                    oldAttributes.set(key, value2);
                    const curVal = currentAttributes.get(key) ?? null;
                    if (!equalAttrs(curVal, value2)) {
                      if (action === "retain") {
                        addOp();
                      }
                      attributes[key] = curVal;
                    }
                  } else if (!item.deleted) {
                    oldAttributes.set(key, value2);
                    const attr = attributes[key];
                    if (attr !== void 0) {
                      if (!equalAttrs(attr, value2)) {
                        if (action === "retain") {
                          addOp();
                        }
                        if (value2 === null) {
                          delete attributes[key];
                        } else {
                          attributes[key] = value2;
                        }
                      } else if (attr !== null) {
                        item.delete(transaction);
                      }
                    }
                  }
                  if (!item.deleted) {
                    if (action === "insert") {
                      addOp();
                    }
                    updateCurrentAttributes(
                      currentAttributes,
                      /** @type {ContentFormat} */
                      item.content
                    );
                  }
                  break;
                }
              }
              item = item.right;
            }
            addOp();
            while (delta.length > 0) {
              const lastOp = delta[delta.length - 1];
              if (lastOp.retain !== void 0 && lastOp.attributes === void 0) {
                delta.pop();
              } else {
                break;
              }
            }
          });
          this._delta = delta;
        }
        return (
          /** @type {any} */
          this._delta
        );
      }
    };
    YText = class _YText extends AbstractType {
      /**
       * @param {String} [string] The initial value of the YText.
       */
      constructor(string) {
        super();
        this._pending = string !== void 0 ? [() => this.insert(0, string)] : [];
        this._searchMarker = [];
        this._hasFormatting = false;
      }
      /**
       * Number of characters of this text type.
       *
       * @type {number}
       */
      get length() {
        this.doc ?? warnPrematureAccess();
        return this._length;
      }
      /**
       * @param {Doc} y
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        try {
          this._pending.forEach((f) => f());
        } catch (e) {
          console.error(e);
        }
        this._pending = null;
      }
      _copy() {
        return new _YText();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YText}
       */
      clone() {
        const text2 = new _YText();
        text2.applyDelta(this.toDelta());
        return text2;
      }
      /**
       * Creates YTextEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        super._callObserver(transaction, parentSubs);
        const event = new YTextEvent(this, transaction, parentSubs);
        callTypeObservers(this, transaction, event);
        if (!transaction.local && this._hasFormatting) {
          transaction._needFormattingCleanup = true;
        }
      }
      /**
       * Returns the unformatted string representation of this YText type.
       *
       * @public
       */
      toString() {
        this.doc ?? warnPrematureAccess();
        let str = "";
        let n = this._start;
        while (n !== null) {
          if (!n.deleted && n.countable && n.content.constructor === ContentString) {
            str += /** @type {ContentString} */
            n.content.str;
          }
          n = n.right;
        }
        return str;
      }
      /**
       * Returns the unformatted string representation of this YText type.
       *
       * @return {string}
       * @public
       */
      toJSON() {
        return this.toString();
      }
      /**
       * Apply a {@link Delta} on this shared YText type.
       *
       * @param {Array<any>} delta The changes to apply on this element.
       * @param {object}  opts
       * @param {boolean} [opts.sanitize] Sanitize input delta. Removes ending newlines if set to true.
       *
       *
       * @public
       */
      applyDelta(delta, { sanitize = true } = {}) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            const currPos = new ItemTextListPosition(null, this._start, 0, /* @__PURE__ */ new Map());
            for (let i = 0; i < delta.length; i++) {
              const op = delta[i];
              if (op.insert !== void 0) {
                const ins = !sanitize && typeof op.insert === "string" && i === delta.length - 1 && currPos.right === null && op.insert.slice(-1) === "\n" ? op.insert.slice(0, -1) : op.insert;
                if (typeof ins !== "string" || ins.length > 0) {
                  insertText(transaction, this, currPos, ins, op.attributes || {});
                }
              } else if (op.retain !== void 0) {
                formatText(transaction, this, currPos, op.retain, op.attributes || {});
              } else if (op.delete !== void 0) {
                deleteText(transaction, currPos, op.delete);
              }
            }
          });
        } else {
          this._pending.push(() => this.applyDelta(delta));
        }
      }
      /**
       * Returns the Delta representation of this YText type.
       *
       * @param {Snapshot} [snapshot]
       * @param {Snapshot} [prevSnapshot]
       * @param {function('removed' | 'added', ID):any} [computeYChange]
       * @return {any} The Delta representation of this type.
       *
       * @public
       */
      toDelta(snapshot, prevSnapshot, computeYChange) {
        this.doc ?? warnPrematureAccess();
        const ops = [];
        const currentAttributes = /* @__PURE__ */ new Map();
        const doc = (
          /** @type {Doc} */
          this.doc
        );
        let str = "";
        let n = this._start;
        function packStr() {
          if (str.length > 0) {
            const attributes = {};
            let addAttributes = false;
            currentAttributes.forEach((value2, key) => {
              addAttributes = true;
              attributes[key] = value2;
            });
            const op = { insert: str };
            if (addAttributes) {
              op.attributes = attributes;
            }
            ops.push(op);
            str = "";
          }
        }
        const computeDelta = () => {
          while (n !== null) {
            if (isVisible(n, snapshot) || prevSnapshot !== void 0 && isVisible(n, prevSnapshot)) {
              switch (n.content.constructor) {
                case ContentString: {
                  const cur = currentAttributes.get("ychange");
                  if (snapshot !== void 0 && !isVisible(n, snapshot)) {
                    if (cur === void 0 || cur.user !== n.id.client || cur.type !== "removed") {
                      packStr();
                      currentAttributes.set("ychange", computeYChange ? computeYChange("removed", n.id) : { type: "removed" });
                    }
                  } else if (prevSnapshot !== void 0 && !isVisible(n, prevSnapshot)) {
                    if (cur === void 0 || cur.user !== n.id.client || cur.type !== "added") {
                      packStr();
                      currentAttributes.set("ychange", computeYChange ? computeYChange("added", n.id) : { type: "added" });
                    }
                  } else if (cur !== void 0) {
                    packStr();
                    currentAttributes.delete("ychange");
                  }
                  str += /** @type {ContentString} */
                  n.content.str;
                  break;
                }
                case ContentType:
                case ContentEmbed: {
                  packStr();
                  const op = {
                    insert: n.content.getContent()[0]
                  };
                  if (currentAttributes.size > 0) {
                    const attrs = (
                      /** @type {Object<string,any>} */
                      {}
                    );
                    op.attributes = attrs;
                    currentAttributes.forEach((value2, key) => {
                      attrs[key] = value2;
                    });
                  }
                  ops.push(op);
                  break;
                }
                case ContentFormat:
                  if (isVisible(n, snapshot)) {
                    packStr();
                    updateCurrentAttributes(
                      currentAttributes,
                      /** @type {ContentFormat} */
                      n.content
                    );
                  }
                  break;
              }
            }
            n = n.right;
          }
          packStr();
        };
        if (snapshot || prevSnapshot) {
          transact(doc, (transaction) => {
            if (snapshot) {
              splitSnapshotAffectedStructs(transaction, snapshot);
            }
            if (prevSnapshot) {
              splitSnapshotAffectedStructs(transaction, prevSnapshot);
            }
            computeDelta();
          }, "cleanup");
        } else {
          computeDelta();
        }
        return ops;
      }
      /**
       * Insert text at a given index.
       *
       * @param {number} index The index at which to start inserting.
       * @param {String} text The text to insert at the specified position.
       * @param {TextAttributes} [attributes] Optionally define some formatting
       *                                    information to apply on the inserted
       *                                    Text.
       * @public
       */
      insert(index, text2, attributes) {
        if (text2.length <= 0) {
          return;
        }
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            const pos = findPosition(transaction, this, index, !attributes);
            if (!attributes) {
              attributes = {};
              pos.currentAttributes.forEach((v, k) => {
                attributes[k] = v;
              });
            }
            insertText(transaction, this, pos, text2, attributes);
          });
        } else {
          this._pending.push(() => this.insert(index, text2, attributes));
        }
      }
      /**
       * Inserts an embed at a index.
       *
       * @param {number} index The index to insert the embed at.
       * @param {Object | AbstractType<any>} embed The Object that represents the embed.
       * @param {TextAttributes} [attributes] Attribute information to apply on the
       *                                    embed
       *
       * @public
       */
      insertEmbed(index, embed, attributes) {
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            const pos = findPosition(transaction, this, index, !attributes);
            insertText(transaction, this, pos, embed, attributes || {});
          });
        } else {
          this._pending.push(() => this.insertEmbed(index, embed, attributes || {}));
        }
      }
      /**
       * Deletes text starting from an index.
       *
       * @param {number} index Index at which to start deleting.
       * @param {number} length The number of characters to remove. Defaults to 1.
       *
       * @public
       */
      delete(index, length2) {
        if (length2 === 0) {
          return;
        }
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            deleteText(transaction, findPosition(transaction, this, index, true), length2);
          });
        } else {
          this._pending.push(() => this.delete(index, length2));
        }
      }
      /**
       * Assigns properties to a range of text.
       *
       * @param {number} index The position where to start formatting.
       * @param {number} length The amount of characters to assign properties to.
       * @param {TextAttributes} attributes Attribute information to apply on the
       *                                    text.
       *
       * @public
       */
      format(index, length2, attributes) {
        if (length2 === 0) {
          return;
        }
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            const pos = findPosition(transaction, this, index, false);
            if (pos.right === null) {
              return;
            }
            formatText(transaction, this, pos, length2, attributes);
          });
        } else {
          this._pending.push(() => this.format(index, length2, attributes));
        }
      }
      /**
       * Removes an attribute.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @param {String} attributeName The attribute name that is to be removed.
       *
       * @public
       */
      removeAttribute(attributeName) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapDelete(transaction, this, attributeName);
          });
        } else {
          this._pending.push(() => this.removeAttribute(attributeName));
        }
      }
      /**
       * Sets or updates an attribute.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @param {String} attributeName The attribute name that is to be set.
       * @param {any} attributeValue The attribute value that is to be set.
       *
       * @public
       */
      setAttribute(attributeName, attributeValue) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapSet(transaction, this, attributeName, attributeValue);
          });
        } else {
          this._pending.push(() => this.setAttribute(attributeName, attributeValue));
        }
      }
      /**
       * Returns an attribute value that belongs to the attribute name.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @param {String} attributeName The attribute name that identifies the
       *                               queried value.
       * @return {any} The queried attribute value.
       *
       * @public
       */
      getAttribute(attributeName) {
        return (
          /** @type {any} */
          typeMapGet(this, attributeName)
        );
      }
      /**
       * Returns all attribute name/value pairs in a JSON Object.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @return {Object<string, any>} A JSON Object that describes the attributes.
       *
       * @public
       */
      getAttributes() {
        return typeMapGetAll(this);
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YTextRefID);
      }
    };
    readYText = (_decoder) => new YText();
    YXmlTreeWalker = class {
      /**
       * @param {YXmlFragment | YXmlElement} root
       * @param {function(AbstractType<any>):boolean} [f]
       */
      constructor(root, f = () => true) {
        this._filter = f;
        this._root = root;
        this._currentNode = /** @type {Item} */
        root._start;
        this._firstCall = true;
        root.doc ?? warnPrematureAccess();
      }
      [Symbol.iterator]() {
        return this;
      }
      /**
       * Get the next node.
       *
       * @return {IteratorResult<YXmlElement|YXmlText|YXmlHook>} The next node.
       *
       * @public
       */
      next() {
        let n = this._currentNode;
        let type = n && n.content && /** @type {any} */
        n.content.type;
        if (n !== null && (!this._firstCall || n.deleted || !this._filter(type))) {
          do {
            type = /** @type {any} */
            n.content.type;
            if (!n.deleted && (type.constructor === YXmlElement || type.constructor === YXmlFragment) && type._start !== null) {
              n = type._start;
            } else {
              while (n !== null) {
                const nxt = n.next;
                if (nxt !== null) {
                  n = nxt;
                  break;
                } else if (n.parent === this._root) {
                  n = null;
                } else {
                  n = /** @type {AbstractType<any>} */
                  n.parent._item;
                }
              }
            }
          } while (n !== null && (n.deleted || !this._filter(
            /** @type {ContentType} */
            n.content.type
          )));
        }
        this._firstCall = false;
        if (n === null) {
          return { value: void 0, done: true };
        }
        this._currentNode = n;
        return { value: (
          /** @type {any} */
          n.content.type
        ), done: false };
      }
    };
    YXmlFragment = class _YXmlFragment extends AbstractType {
      constructor() {
        super();
        this._prelimContent = [];
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get firstChild() {
        const first = this._first;
        return first ? first.content.getContent()[0] : null;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        this.insert(
          0,
          /** @type {Array<any>} */
          this._prelimContent
        );
        this._prelimContent = null;
      }
      _copy() {
        return new _YXmlFragment();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlFragment}
       */
      clone() {
        const el = new _YXmlFragment();
        el.insert(0, this.toArray().map((item) => item instanceof AbstractType ? item.clone() : item));
        return el;
      }
      get length() {
        this.doc ?? warnPrematureAccess();
        return this._prelimContent === null ? this._length : this._prelimContent.length;
      }
      /**
       * Create a subtree of childNodes.
       *
       * @example
       * const walker = elem.createTreeWalker(dom => dom.nodeName === 'div')
       * for (let node in walker) {
       *   // `node` is a div node
       *   nop(node)
       * }
       *
       * @param {function(AbstractType<any>):boolean} filter Function that is called on each child element and
       *                          returns a Boolean indicating whether the child
       *                          is to be included in the subtree.
       * @return {YXmlTreeWalker} A subtree and a position within it.
       *
       * @public
       */
      createTreeWalker(filter) {
        return new YXmlTreeWalker(this, filter);
      }
      /**
       * Returns the first YXmlElement that matches the query.
       * Similar to DOM's {@link querySelector}.
       *
       * Query support:
       *   - tagname
       * TODO:
       *   - id
       *   - attribute
       *
       * @param {CSS_Selector} query The query on the children.
       * @return {YXmlElement|YXmlText|YXmlHook|null} The first element that matches the query or null.
       *
       * @public
       */
      querySelector(query) {
        query = query.toUpperCase();
        const iterator = new YXmlTreeWalker(this, (element) => element.nodeName && element.nodeName.toUpperCase() === query);
        const next = iterator.next();
        if (next.done) {
          return null;
        } else {
          return next.value;
        }
      }
      /**
       * Returns all YXmlElements that match the query.
       * Similar to Dom's {@link querySelectorAll}.
       *
       * @todo Does not yet support all queries. Currently only query by tagName.
       *
       * @param {CSS_Selector} query The query on the children
       * @return {Array<YXmlElement|YXmlText|YXmlHook|null>} The elements that match this query.
       *
       * @public
       */
      querySelectorAll(query) {
        query = query.toUpperCase();
        return from(new YXmlTreeWalker(this, (element) => element.nodeName && element.nodeName.toUpperCase() === query));
      }
      /**
       * Creates YXmlEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        callTypeObservers(this, transaction, new YXmlEvent(this, parentSubs, transaction));
      }
      /**
       * Get the string representation of all the children of this YXmlFragment.
       *
       * @return {string} The string representation of all children.
       */
      toString() {
        return typeListMap(this, (xml) => xml.toString()).join("");
      }
      /**
       * @return {string}
       */
      toJSON() {
        return this.toString();
      }
      /**
       * Creates a Dom Element that mirrors this YXmlElement.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object<string, any>} [hooks={}] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type.
       * @return {Node} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks = {}, binding) {
        const fragment = _document.createDocumentFragment();
        if (binding !== void 0) {
          binding._createAssociation(fragment, this);
        }
        typeListForEach(this, (xmlType) => {
          fragment.insertBefore(xmlType.toDOM(_document, hooks, binding), null);
        });
        return fragment;
      }
      /**
       * Inserts new content at an index.
       *
       * @example
       *  // Insert character 'a' at position 0
       *  xml.insert(0, [new Y.XmlText('text')])
       *
       * @param {number} index The index to insert content at
       * @param {Array<YXmlElement|YXmlText>} content The array of content
       */
      insert(index, content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListInsertGenerics(transaction, this, index, content);
          });
        } else {
          this._prelimContent.splice(index, 0, ...content);
        }
      }
      /**
       * Inserts new content at an index.
       *
       * @example
       *  // Insert character 'a' at position 0
       *  xml.insert(0, [new Y.XmlText('text')])
       *
       * @param {null|Item|YXmlElement|YXmlText} ref The index to insert content at
       * @param {Array<YXmlElement|YXmlText>} content The array of content
       */
      insertAfter(ref, content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            const refItem = ref && ref instanceof AbstractType ? ref._item : ref;
            typeListInsertGenericsAfter(transaction, this, refItem, content);
          });
        } else {
          const pc = (
            /** @type {Array<any>} */
            this._prelimContent
          );
          const index = ref === null ? 0 : pc.findIndex((el) => el === ref) + 1;
          if (index === 0 && ref !== null) {
            throw create2("Reference item not found");
          }
          pc.splice(index, 0, ...content);
        }
      }
      /**
       * Deletes elements starting from an index.
       *
       * @param {number} index Index at which to start deleting elements
       * @param {number} [length=1] The number of elements to remove. Defaults to 1.
       */
      delete(index, length2 = 1) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListDelete(transaction, this, index, length2);
          });
        } else {
          this._prelimContent.splice(index, length2);
        }
      }
      /**
       * Transforms this YArray to a JavaScript Array.
       *
       * @return {Array<YXmlElement|YXmlText|YXmlHook>}
       */
      toArray() {
        return typeListToArray(this);
      }
      /**
       * Appends content to this YArray.
       *
       * @param {Array<YXmlElement|YXmlText>} content Array of content to append.
       */
      push(content) {
        this.insert(this.length, content);
      }
      /**
       * Prepends content to this YArray.
       *
       * @param {Array<YXmlElement|YXmlText>} content Array of content to prepend.
       */
      unshift(content) {
        this.insert(0, content);
      }
      /**
       * Returns the i-th element from a YArray.
       *
       * @param {number} index The index of the element to return from the YArray
       * @return {YXmlElement|YXmlText}
       */
      get(index) {
        return typeListGet(this, index);
      }
      /**
       * Returns a portion of this YXmlFragment into a JavaScript Array selected
       * from start to end (end not included).
       *
       * @param {number} [start]
       * @param {number} [end]
       * @return {Array<YXmlElement|YXmlText>}
       */
      slice(start = 0, end = this.length) {
        return typeListSlice(this, start, end);
      }
      /**
       * Executes a provided function on once on every child element.
       *
       * @param {function(YXmlElement|YXmlText,number, typeof self):void} f A function to execute on every element of this YArray.
       */
      forEach(f) {
        typeListForEach(this, f);
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YXmlFragmentRefID);
      }
    };
    readYXmlFragment = (_decoder) => new YXmlFragment();
    YXmlElement = class _YXmlElement extends YXmlFragment {
      constructor(nodeName = "UNDEFINED") {
        super();
        this.nodeName = nodeName;
        this._prelimAttrs = /* @__PURE__ */ new Map();
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get nextSibling() {
        const n = this._item ? this._item.next : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get prevSibling() {
        const n = this._item ? this._item.prev : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        /** @type {Map<string, any>} */
        this._prelimAttrs.forEach((value2, key) => {
          this.setAttribute(key, value2);
        });
        this._prelimAttrs = null;
      }
      /**
       * Creates an Item with the same effect as this Item (without position effect)
       *
       * @return {YXmlElement}
       */
      _copy() {
        return new _YXmlElement(this.nodeName);
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlElement<KV>}
       */
      clone() {
        const el = new _YXmlElement(this.nodeName);
        const attrs = this.getAttributes();
        forEach(attrs, (value2, key) => {
          el.setAttribute(
            key,
            /** @type {any} */
            value2
          );
        });
        el.insert(0, this.toArray().map((v) => v instanceof AbstractType ? v.clone() : v));
        return el;
      }
      /**
       * Returns the XML serialization of this YXmlElement.
       * The attributes are ordered by attribute-name, so you can easily use this
       * method to compare YXmlElements
       *
       * @return {string} The string representation of this type.
       *
       * @public
       */
      toString() {
        const attrs = this.getAttributes();
        const stringBuilder = [];
        const keys3 = [];
        for (const key in attrs) {
          keys3.push(key);
        }
        keys3.sort();
        const keysLen = keys3.length;
        for (let i = 0; i < keysLen; i++) {
          const key = keys3[i];
          stringBuilder.push(key + '="' + attrs[key] + '"');
        }
        const nodeName = this.nodeName.toLocaleLowerCase();
        const attrsString = stringBuilder.length > 0 ? " " + stringBuilder.join(" ") : "";
        return `<${nodeName}${attrsString}>${super.toString()}</${nodeName}>`;
      }
      /**
       * Removes an attribute from this YXmlElement.
       *
       * @param {string} attributeName The attribute name that is to be removed.
       *
       * @public
       */
      removeAttribute(attributeName) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapDelete(transaction, this, attributeName);
          });
        } else {
          this._prelimAttrs.delete(attributeName);
        }
      }
      /**
       * Sets or updates an attribute.
       *
       * @template {keyof KV & string} KEY
       *
       * @param {KEY} attributeName The attribute name that is to be set.
       * @param {KV[KEY]} attributeValue The attribute value that is to be set.
       *
       * @public
       */
      setAttribute(attributeName, attributeValue) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapSet(transaction, this, attributeName, attributeValue);
          });
        } else {
          this._prelimAttrs.set(attributeName, attributeValue);
        }
      }
      /**
       * Returns an attribute value that belongs to the attribute name.
       *
       * @template {keyof KV & string} KEY
       *
       * @param {KEY} attributeName The attribute name that identifies the
       *                               queried value.
       * @return {KV[KEY]|undefined} The queried attribute value.
       *
       * @public
       */
      getAttribute(attributeName) {
        return (
          /** @type {any} */
          typeMapGet(this, attributeName)
        );
      }
      /**
       * Returns whether an attribute exists
       *
       * @param {string} attributeName The attribute name to check for existence.
       * @return {boolean} whether the attribute exists.
       *
       * @public
       */
      hasAttribute(attributeName) {
        return (
          /** @type {any} */
          typeMapHas(this, attributeName)
        );
      }
      /**
       * Returns all attribute name/value pairs in a JSON Object.
       *
       * @param {Snapshot} [snapshot]
       * @return {{ [Key in Extract<keyof KV,string>]?: KV[Key]}} A JSON Object that describes the attributes.
       *
       * @public
       */
      getAttributes(snapshot) {
        return (
          /** @type {any} */
          snapshot ? typeMapGetAllSnapshot(this, snapshot) : typeMapGetAll(this)
        );
      }
      /**
       * Creates a Dom Element that mirrors this YXmlElement.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object<string, any>} [hooks={}] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type.
       * @return {Node} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks = {}, binding) {
        const dom = _document.createElement(this.nodeName);
        const attrs = this.getAttributes();
        for (const key in attrs) {
          const value2 = attrs[key];
          if (typeof value2 === "string") {
            dom.setAttribute(key, value2);
          }
        }
        typeListForEach(this, (yxml) => {
          dom.appendChild(yxml.toDOM(_document, hooks, binding));
        });
        if (binding !== void 0) {
          binding._createAssociation(dom, this);
        }
        return dom;
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YXmlElementRefID);
        encoder3.writeKey(this.nodeName);
      }
    };
    readYXmlElement = (decoder) => new YXmlElement(decoder.readKey());
    YXmlEvent = class extends YEvent {
      /**
       * @param {YXmlElement|YXmlText|YXmlFragment} target The target on which the event is created.
       * @param {Set<string|null>} subs The set of changed attributes. `null` is included if the
       *                   child list changed.
       * @param {Transaction} transaction The transaction instance with which the
       *                                  change was created.
       */
      constructor(target, subs, transaction) {
        super(target, transaction);
        this.childListChanged = false;
        this.attributesChanged = /* @__PURE__ */ new Set();
        subs.forEach((sub) => {
          if (sub === null) {
            this.childListChanged = true;
          } else {
            this.attributesChanged.add(sub);
          }
        });
      }
    };
    YXmlHook = class _YXmlHook extends YMap {
      /**
       * @param {string} hookName nodeName of the Dom Node.
       */
      constructor(hookName) {
        super();
        this.hookName = hookName;
      }
      /**
       * Creates an Item with the same effect as this Item (without position effect)
       */
      _copy() {
        return new _YXmlHook(this.hookName);
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlHook}
       */
      clone() {
        const el = new _YXmlHook(this.hookName);
        this.forEach((value2, key) => {
          el.set(key, value2);
        });
        return el;
      }
      /**
       * Creates a Dom Element that mirrors this YXmlElement.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object.<string, any>} [hooks] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type
       * @return {Element} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks = {}, binding) {
        const hook = hooks[this.hookName];
        let dom;
        if (hook !== void 0) {
          dom = hook.createDom(this);
        } else {
          dom = document.createElement(this.hookName);
        }
        dom.setAttribute("data-yjs-hook", this.hookName);
        if (binding !== void 0) {
          binding._createAssociation(dom, this);
        }
        return dom;
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YXmlHookRefID);
        encoder3.writeKey(this.hookName);
      }
    };
    readYXmlHook = (decoder) => new YXmlHook(decoder.readKey());
    YXmlText = class _YXmlText extends YText {
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get nextSibling() {
        const n = this._item ? this._item.next : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get prevSibling() {
        const n = this._item ? this._item.prev : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      _copy() {
        return new _YXmlText();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlText}
       */
      clone() {
        const text2 = new _YXmlText();
        text2.applyDelta(this.toDelta());
        return text2;
      }
      /**
       * Creates a Dom Element that mirrors this YXmlText.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object<string, any>} [hooks] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type.
       * @return {Text} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks, binding) {
        const dom = _document.createTextNode(this.toString());
        if (binding !== void 0) {
          binding._createAssociation(dom, this);
        }
        return dom;
      }
      toString() {
        return this.toDelta().map((delta) => {
          const nestedNodes = [];
          for (const nodeName in delta.attributes) {
            const attrs = [];
            for (const key in delta.attributes[nodeName]) {
              attrs.push({ key, value: delta.attributes[nodeName][key] });
            }
            attrs.sort((a, b) => a.key < b.key ? -1 : 1);
            nestedNodes.push({ nodeName, attrs });
          }
          nestedNodes.sort((a, b) => a.nodeName < b.nodeName ? -1 : 1);
          let str = "";
          for (let i = 0; i < nestedNodes.length; i++) {
            const node = nestedNodes[i];
            str += `<${node.nodeName}`;
            for (let j = 0; j < node.attrs.length; j++) {
              const attr = node.attrs[j];
              str += ` ${attr.key}="${attr.value}"`;
            }
            str += ">";
          }
          str += delta.insert;
          for (let i = nestedNodes.length - 1; i >= 0; i--) {
            str += `</${nestedNodes[i].nodeName}>`;
          }
          return str;
        }).join("");
      }
      /**
       * @return {string}
       */
      toJSON() {
        return this.toString();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YXmlTextRefID);
      }
    };
    readYXmlText = (decoder) => new YXmlText();
    AbstractStruct = class {
      /**
       * @param {ID} id
       * @param {number} length
       */
      constructor(id2, length2) {
        this.id = id2;
        this.length = length2;
      }
      /**
       * @type {boolean}
       */
      get deleted() {
        throw methodUnimplemented();
      }
      /**
       * Merge this struct with the item to the right.
       * This method is already assuming that `this.id.clock + this.length === this.id.clock`.
       * Also this method does *not* remove right from StructStore!
       * @param {AbstractStruct} right
       * @return {boolean} whether this merged with right
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       * @param {number} offset
       * @param {number} encodingRef
       */
      write(encoder3, offset, encodingRef) {
        throw methodUnimplemented();
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        throw methodUnimplemented();
      }
    };
    structGCRefNumber = 0;
    GC = class extends AbstractStruct {
      get deleted() {
        return true;
      }
      delete() {
      }
      /**
       * @param {GC} right
       * @return {boolean}
       */
      mergeWith(right) {
        if (this.constructor !== right.constructor) {
          return false;
        }
        this.length += right.length;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        if (offset > 0) {
          this.id.clock += offset;
          this.length -= offset;
        }
        addStruct(transaction.doc.store, this);
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeInfo(structGCRefNumber);
        encoder3.writeLen(this.length - offset);
      }
      /**
       * @param {Transaction} transaction
       * @param {StructStore} store
       * @return {null | number}
       */
      getMissing(transaction, store) {
        return null;
      }
    };
    ContentBinary = class _ContentBinary {
      /**
       * @param {Uint8Array} content
       */
      constructor(content) {
        this.content = content;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.content];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentBinary}
       */
      copy() {
        return new _ContentBinary(this.content);
      }
      /**
       * @param {number} offset
       * @return {ContentBinary}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentBinary} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeBuf(this.content);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 3;
      }
    };
    readContentBinary = (decoder) => new ContentBinary(decoder.readBuf());
    ContentDeleted = class _ContentDeleted {
      /**
       * @param {number} len
       */
      constructor(len) {
        this.len = len;
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.len;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return false;
      }
      /**
       * @return {ContentDeleted}
       */
      copy() {
        return new _ContentDeleted(this.len);
      }
      /**
       * @param {number} offset
       * @return {ContentDeleted}
       */
      splice(offset) {
        const right = new _ContentDeleted(this.len - offset);
        this.len = offset;
        return right;
      }
      /**
       * @param {ContentDeleted} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.len += right.len;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
        addToDeleteSet(transaction.deleteSet, item.id.client, item.id.clock, this.len);
        item.markDeleted();
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeLen(this.len - offset);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 1;
      }
    };
    readContentDeleted = (decoder) => new ContentDeleted(decoder.readLen());
    createDocFromOpts = (guid, opts) => new Doc({ guid, ...opts, shouldLoad: opts.shouldLoad || opts.autoLoad || false });
    ContentDoc = class _ContentDoc {
      /**
       * @param {Doc} doc
       */
      constructor(doc) {
        if (doc._item) {
          console.error("This document was already integrated as a sub-document. You should create a second instance instead with the same guid.");
        }
        this.doc = doc;
        const opts = {};
        this.opts = opts;
        if (!doc.gc) {
          opts.gc = false;
        }
        if (doc.autoLoad) {
          opts.autoLoad = true;
        }
        if (doc.meta !== null) {
          opts.meta = doc.meta;
        }
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.doc];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentDoc}
       */
      copy() {
        return new _ContentDoc(createDocFromOpts(this.doc.guid, this.opts));
      }
      /**
       * @param {number} offset
       * @return {ContentDoc}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentDoc} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
        this.doc._item = item;
        transaction.subdocsAdded.add(this.doc);
        if (this.doc.shouldLoad) {
          transaction.subdocsLoaded.add(this.doc);
        }
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
        if (transaction.subdocsAdded.has(this.doc)) {
          transaction.subdocsAdded.delete(this.doc);
        } else {
          transaction.subdocsRemoved.add(this.doc);
        }
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeString(this.doc.guid);
        encoder3.writeAny(this.opts);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 9;
      }
    };
    readContentDoc = (decoder) => new ContentDoc(createDocFromOpts(decoder.readString(), decoder.readAny()));
    ContentEmbed = class _ContentEmbed {
      /**
       * @param {Object} embed
       */
      constructor(embed) {
        this.embed = embed;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.embed];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentEmbed}
       */
      copy() {
        return new _ContentEmbed(this.embed);
      }
      /**
       * @param {number} offset
       * @return {ContentEmbed}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentEmbed} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeJSON(this.embed);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 5;
      }
    };
    readContentEmbed = (decoder) => new ContentEmbed(decoder.readJSON());
    ContentFormat = class _ContentFormat {
      /**
       * @param {string} key
       * @param {Object} value
       */
      constructor(key, value2) {
        this.key = key;
        this.value = value2;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return false;
      }
      /**
       * @return {ContentFormat}
       */
      copy() {
        return new _ContentFormat(this.key, this.value);
      }
      /**
       * @param {number} _offset
       * @return {ContentFormat}
       */
      splice(_offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentFormat} _right
       * @return {boolean}
       */
      mergeWith(_right) {
        return false;
      }
      /**
       * @param {Transaction} _transaction
       * @param {Item} item
       */
      integrate(_transaction, item) {
        const p = (
          /** @type {YText} */
          item.parent
        );
        p._searchMarker = null;
        p._hasFormatting = true;
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeKey(this.key);
        encoder3.writeJSON(this.value);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 6;
      }
    };
    readContentFormat = (decoder) => new ContentFormat(decoder.readKey(), decoder.readJSON());
    ContentJSON = class _ContentJSON {
      /**
       * @param {Array<any>} arr
       */
      constructor(arr) {
        this.arr = arr;
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.arr.length;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return this.arr;
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentJSON}
       */
      copy() {
        return new _ContentJSON(this.arr);
      }
      /**
       * @param {number} offset
       * @return {ContentJSON}
       */
      splice(offset) {
        const right = new _ContentJSON(this.arr.slice(offset));
        this.arr = this.arr.slice(0, offset);
        return right;
      }
      /**
       * @param {ContentJSON} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.arr = this.arr.concat(right.arr);
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        const len = this.arr.length;
        encoder3.writeLen(len - offset);
        for (let i = offset; i < len; i++) {
          const c = this.arr[i];
          encoder3.writeString(c === void 0 ? "undefined" : JSON.stringify(c));
        }
      }
      /**
       * @return {number}
       */
      getRef() {
        return 2;
      }
    };
    readContentJSON = (decoder) => {
      const len = decoder.readLen();
      const cs = [];
      for (let i = 0; i < len; i++) {
        const c = decoder.readString();
        if (c === "undefined") {
          cs.push(void 0);
        } else {
          cs.push(JSON.parse(c));
        }
      }
      return new ContentJSON(cs);
    };
    isDevMode = getVariable("node_env") === "development";
    ContentAny = class _ContentAny {
      /**
       * @param {Array<any>} arr
       */
      constructor(arr) {
        this.arr = arr;
        isDevMode && deepFreeze(arr);
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.arr.length;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return this.arr;
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentAny}
       */
      copy() {
        return new _ContentAny(this.arr);
      }
      /**
       * @param {number} offset
       * @return {ContentAny}
       */
      splice(offset) {
        const right = new _ContentAny(this.arr.slice(offset));
        this.arr = this.arr.slice(0, offset);
        return right;
      }
      /**
       * @param {ContentAny} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.arr = this.arr.concat(right.arr);
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        const len = this.arr.length;
        encoder3.writeLen(len - offset);
        for (let i = offset; i < len; i++) {
          const c = this.arr[i];
          encoder3.writeAny(c);
        }
      }
      /**
       * @return {number}
       */
      getRef() {
        return 8;
      }
    };
    readContentAny = (decoder) => {
      const len = decoder.readLen();
      const cs = [];
      for (let i = 0; i < len; i++) {
        cs.push(decoder.readAny());
      }
      return new ContentAny(cs);
    };
    ContentString = class _ContentString {
      /**
       * @param {string} str
       */
      constructor(str) {
        this.str = str;
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.str.length;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return this.str.split("");
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentString}
       */
      copy() {
        return new _ContentString(this.str);
      }
      /**
       * @param {number} offset
       * @return {ContentString}
       */
      splice(offset) {
        const right = new _ContentString(this.str.slice(offset));
        this.str = this.str.slice(0, offset);
        const firstCharCode = this.str.charCodeAt(offset - 1);
        if (firstCharCode >= 55296 && firstCharCode <= 56319) {
          this.str = this.str.slice(0, offset - 1) + "\uFFFD";
          right.str = "\uFFFD" + right.str.slice(1);
        }
        return right;
      }
      /**
       * @param {ContentString} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.str += right.str;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeString(offset === 0 ? this.str : this.str.slice(offset));
      }
      /**
       * @return {number}
       */
      getRef() {
        return 4;
      }
    };
    readContentString = (decoder) => new ContentString(decoder.readString());
    typeRefs = [
      readYArray,
      readYMap,
      readYText,
      readYXmlElement,
      readYXmlFragment,
      readYXmlHook,
      readYXmlText
    ];
    YArrayRefID = 0;
    YMapRefID = 1;
    YTextRefID = 2;
    YXmlElementRefID = 3;
    YXmlFragmentRefID = 4;
    YXmlHookRefID = 5;
    YXmlTextRefID = 6;
    ContentType = class _ContentType {
      /**
       * @param {AbstractType<any>} type
       */
      constructor(type) {
        this.type = type;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.type];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentType}
       */
      copy() {
        return new _ContentType(this.type._copy());
      }
      /**
       * @param {number} offset
       * @return {ContentType}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentType} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
        this.type._integrate(transaction.doc, item);
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
        let item = this.type._start;
        while (item !== null) {
          if (!item.deleted) {
            item.delete(transaction);
          } else if (item.id.clock < (transaction.beforeState.get(item.id.client) || 0)) {
            transaction._mergeStructs.push(item);
          }
          item = item.right;
        }
        this.type._map.forEach((item2) => {
          if (!item2.deleted) {
            item2.delete(transaction);
          } else if (item2.id.clock < (transaction.beforeState.get(item2.id.client) || 0)) {
            transaction._mergeStructs.push(item2);
          }
        });
        transaction.changed.delete(this.type);
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
        let item = this.type._start;
        while (item !== null) {
          item.gc(store, true);
          item = item.right;
        }
        this.type._start = null;
        this.type._map.forEach(
          /** @param {Item | null} item */
          (item2) => {
            while (item2 !== null) {
              item2.gc(store, true);
              item2 = item2.left;
            }
          }
        );
        this.type._map = /* @__PURE__ */ new Map();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        this.type._write(encoder3);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 7;
      }
    };
    readContentType = (decoder) => new ContentType(typeRefs[decoder.readTypeRef()](decoder));
    followRedone = (store, id2) => {
      let nextID = id2;
      let diff = 0;
      let item;
      do {
        if (diff > 0) {
          nextID = createID(nextID.client, nextID.clock + diff);
        }
        item = getItem(store, nextID);
        diff = nextID.clock - item.id.clock;
        nextID = item.redone;
      } while (nextID !== null && item instanceof Item);
      return {
        item,
        diff
      };
    };
    splitItem = (transaction, leftItem, diff) => {
      const { client, clock } = leftItem.id;
      const rightItem = new Item(
        createID(client, clock + diff),
        leftItem,
        createID(client, clock + diff - 1),
        leftItem.right,
        leftItem.rightOrigin,
        leftItem.parent,
        leftItem.parentSub,
        leftItem.content.splice(diff)
      );
      if (leftItem.deleted) {
        rightItem.markDeleted();
      }
      if (leftItem.keep) {
        rightItem.keep = true;
      }
      if (leftItem.redone !== null) {
        rightItem.redone = createID(leftItem.redone.client, leftItem.redone.clock + diff);
      }
      leftItem.right = rightItem;
      if (rightItem.right !== null) {
        rightItem.right.left = rightItem;
      }
      transaction._mergeStructs.push(rightItem);
      if (rightItem.parentSub !== null && rightItem.right === null) {
        rightItem.parent._map.set(rightItem.parentSub, rightItem);
      }
      leftItem.length = diff;
      return rightItem;
    };
    Item = class _Item extends AbstractStruct {
      /**
       * @param {ID} id
       * @param {Item | null} left
       * @param {ID | null} origin
       * @param {Item | null} right
       * @param {ID | null} rightOrigin
       * @param {AbstractType<any>|ID|null} parent Is a type if integrated, is null if it is possible to copy parent from left or right, is ID before integration to search for it.
       * @param {string | null} parentSub
       * @param {AbstractContent} content
       */
      constructor(id2, left, origin, right, rightOrigin, parent, parentSub, content) {
        super(id2, content.getLength());
        this.origin = origin;
        this.left = left;
        this.right = right;
        this.rightOrigin = rightOrigin;
        this.parent = parent;
        this.parentSub = parentSub;
        this.redone = null;
        this.content = content;
        this.info = this.content.isCountable() ? BIT2 : 0;
      }
      /**
       * This is used to mark the item as an indexed fast-search marker
       *
       * @type {boolean}
       */
      set marker(isMarked) {
        if ((this.info & BIT4) > 0 !== isMarked) {
          this.info ^= BIT4;
        }
      }
      get marker() {
        return (this.info & BIT4) > 0;
      }
      /**
       * If true, do not garbage collect this Item.
       */
      get keep() {
        return (this.info & BIT1) > 0;
      }
      set keep(doKeep) {
        if (this.keep !== doKeep) {
          this.info ^= BIT1;
        }
      }
      get countable() {
        return (this.info & BIT2) > 0;
      }
      /**
       * Whether this item was deleted or not.
       * @type {Boolean}
       */
      get deleted() {
        return (this.info & BIT3) > 0;
      }
      set deleted(doDelete) {
        if (this.deleted !== doDelete) {
          this.info ^= BIT3;
        }
      }
      markDeleted() {
        this.info |= BIT3;
      }
      /**
       * Return the creator clientID of the missing op or define missing items and return null.
       *
       * @param {Transaction} transaction
       * @param {StructStore} store
       * @return {null | number}
       */
      getMissing(transaction, store) {
        if (this.origin && this.origin.client !== this.id.client && this.origin.clock >= getState(store, this.origin.client)) {
          return this.origin.client;
        }
        if (this.rightOrigin && this.rightOrigin.client !== this.id.client && this.rightOrigin.clock >= getState(store, this.rightOrigin.client)) {
          return this.rightOrigin.client;
        }
        if (this.parent && this.parent.constructor === ID && this.id.client !== this.parent.client && this.parent.clock >= getState(store, this.parent.client)) {
          return this.parent.client;
        }
        if (this.origin) {
          this.left = getItemCleanEnd(transaction, store, this.origin);
          this.origin = this.left.lastId;
        }
        if (this.rightOrigin) {
          this.right = getItemCleanStart(transaction, this.rightOrigin);
          this.rightOrigin = this.right.id;
        }
        if (this.left && this.left.constructor === GC || this.right && this.right.constructor === GC) {
          this.parent = null;
        } else if (!this.parent) {
          if (this.left && this.left.constructor === _Item) {
            this.parent = this.left.parent;
            this.parentSub = this.left.parentSub;
          } else if (this.right && this.right.constructor === _Item) {
            this.parent = this.right.parent;
            this.parentSub = this.right.parentSub;
          }
        } else if (this.parent.constructor === ID) {
          const parentItem = getItem(store, this.parent);
          if (parentItem.constructor === GC) {
            this.parent = null;
          } else {
            this.parent = /** @type {ContentType} */
            parentItem.content.type;
          }
        }
        return null;
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        if (offset > 0) {
          this.id.clock += offset;
          this.left = getItemCleanEnd(transaction, transaction.doc.store, createID(this.id.client, this.id.clock - 1));
          this.origin = this.left.lastId;
          this.content = this.content.splice(offset);
          this.length -= offset;
        }
        if (this.parent) {
          if (!this.left && (!this.right || this.right.left !== null) || this.left && this.left.right !== this.right) {
            let left = this.left;
            let o;
            if (left !== null) {
              o = left.right;
            } else if (this.parentSub !== null) {
              o = /** @type {AbstractType<any>} */
              this.parent._map.get(this.parentSub) || null;
              while (o !== null && o.left !== null) {
                o = o.left;
              }
            } else {
              o = /** @type {AbstractType<any>} */
              this.parent._start;
            }
            const conflictingItems = /* @__PURE__ */ new Set();
            const itemsBeforeOrigin = /* @__PURE__ */ new Set();
            while (o !== null && o !== this.right) {
              itemsBeforeOrigin.add(o);
              conflictingItems.add(o);
              if (compareIDs(this.origin, o.origin)) {
                if (o.id.client < this.id.client) {
                  left = o;
                  conflictingItems.clear();
                } else if (compareIDs(this.rightOrigin, o.rightOrigin)) {
                  break;
                }
              } else if (o.origin !== null && itemsBeforeOrigin.has(getItem(transaction.doc.store, o.origin))) {
                if (!conflictingItems.has(getItem(transaction.doc.store, o.origin))) {
                  left = o;
                  conflictingItems.clear();
                }
              } else {
                break;
              }
              o = o.right;
            }
            this.left = left;
          }
          if (this.left !== null) {
            const right = this.left.right;
            this.right = right;
            this.left.right = this;
          } else {
            let r;
            if (this.parentSub !== null) {
              r = /** @type {AbstractType<any>} */
              this.parent._map.get(this.parentSub) || null;
              while (r !== null && r.left !== null) {
                r = r.left;
              }
            } else {
              r = /** @type {AbstractType<any>} */
              this.parent._start;
              this.parent._start = this;
            }
            this.right = r;
          }
          if (this.right !== null) {
            this.right.left = this;
          } else if (this.parentSub !== null) {
            this.parent._map.set(this.parentSub, this);
            if (this.left !== null) {
              this.left.delete(transaction);
            }
          }
          if (this.parentSub === null && this.countable && !this.deleted) {
            this.parent._length += this.length;
          }
          addStruct(transaction.doc.store, this);
          this.content.integrate(transaction, this);
          addChangedTypeToTransaction(
            transaction,
            /** @type {AbstractType<any>} */
            this.parent,
            this.parentSub
          );
          if (
            /** @type {AbstractType<any>} */
            this.parent._item !== null && /** @type {AbstractType<any>} */
            this.parent._item.deleted || this.parentSub !== null && this.right !== null
          ) {
            this.delete(transaction);
          }
        } else {
          new GC(this.id, this.length).integrate(transaction, 0);
        }
      }
      /**
       * Returns the next non-deleted item
       */
      get next() {
        let n = this.right;
        while (n !== null && n.deleted) {
          n = n.right;
        }
        return n;
      }
      /**
       * Returns the previous non-deleted item
       */
      get prev() {
        let n = this.left;
        while (n !== null && n.deleted) {
          n = n.left;
        }
        return n;
      }
      /**
       * Computes the last content address of this Item.
       */
      get lastId() {
        return this.length === 1 ? this.id : createID(this.id.client, this.id.clock + this.length - 1);
      }
      /**
       * Try to merge two items
       *
       * @param {Item} right
       * @return {boolean}
       */
      mergeWith(right) {
        if (this.constructor === right.constructor && compareIDs(right.origin, this.lastId) && this.right === right && compareIDs(this.rightOrigin, right.rightOrigin) && this.id.client === right.id.client && this.id.clock + this.length === right.id.clock && this.deleted === right.deleted && this.redone === null && right.redone === null && this.content.constructor === right.content.constructor && this.content.mergeWith(right.content)) {
          const searchMarker = (
            /** @type {AbstractType<any>} */
            this.parent._searchMarker
          );
          if (searchMarker) {
            searchMarker.forEach((marker) => {
              if (marker.p === right) {
                marker.p = this;
                if (!this.deleted && this.countable) {
                  marker.index -= this.length;
                }
              }
            });
          }
          if (right.keep) {
            this.keep = true;
          }
          this.right = right.right;
          if (this.right !== null) {
            this.right.left = this;
          }
          this.length += right.length;
          return true;
        }
        return false;
      }
      /**
       * Mark this Item as deleted.
       *
       * @param {Transaction} transaction
       */
      delete(transaction) {
        if (!this.deleted) {
          const parent = (
            /** @type {AbstractType<any>} */
            this.parent
          );
          if (this.countable && this.parentSub === null) {
            parent._length -= this.length;
          }
          this.markDeleted();
          addToDeleteSet(transaction.deleteSet, this.id.client, this.id.clock, this.length);
          addChangedTypeToTransaction(transaction, parent, this.parentSub);
          this.content.delete(transaction);
        }
      }
      /**
       * @param {StructStore} store
       * @param {boolean} parentGCd
       */
      gc(store, parentGCd) {
        if (!this.deleted) {
          throw unexpectedCase();
        }
        this.content.gc(store);
        if (parentGCd) {
          replaceStruct(store, this, new GC(this.id, this.length));
        } else {
          this.content = new ContentDeleted(this.length);
        }
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       * @param {number} offset
       */
      write(encoder3, offset) {
        const origin = offset > 0 ? createID(this.id.client, this.id.clock + offset - 1) : this.origin;
        const rightOrigin = this.rightOrigin;
        const parentSub = this.parentSub;
        const info = this.content.getRef() & BITS5 | (origin === null ? 0 : BIT8) | // origin is defined
        (rightOrigin === null ? 0 : BIT7) | // right origin is defined
        (parentSub === null ? 0 : BIT6);
        encoder3.writeInfo(info);
        if (origin !== null) {
          encoder3.writeLeftID(origin);
        }
        if (rightOrigin !== null) {
          encoder3.writeRightID(rightOrigin);
        }
        if (origin === null && rightOrigin === null) {
          const parent = (
            /** @type {AbstractType<any>} */
            this.parent
          );
          if (parent._item !== void 0) {
            const parentItem = parent._item;
            if (parentItem === null) {
              const ykey = findRootTypeKey(parent);
              encoder3.writeParentInfo(true);
              encoder3.writeString(ykey);
            } else {
              encoder3.writeParentInfo(false);
              encoder3.writeLeftID(parentItem.id);
            }
          } else if (parent.constructor === String) {
            encoder3.writeParentInfo(true);
            encoder3.writeString(parent);
          } else if (parent.constructor === ID) {
            encoder3.writeParentInfo(false);
            encoder3.writeLeftID(parent);
          } else {
            unexpectedCase();
          }
          if (parentSub !== null) {
            encoder3.writeString(parentSub);
          }
        }
        this.content.write(encoder3, offset);
      }
    };
    readItemContent = (decoder, info) => contentRefs[info & BITS5](decoder);
    contentRefs = [
      () => {
        unexpectedCase();
      },
      // GC is not ItemContent
      readContentDeleted,
      // 1
      readContentJSON,
      // 2
      readContentBinary,
      // 3
      readContentString,
      // 4
      readContentEmbed,
      // 5
      readContentFormat,
      // 6
      readContentType,
      // 7
      readContentAny,
      // 8
      readContentDoc,
      // 9
      () => {
        unexpectedCase();
      }
      // 10 - Skip is not ItemContent
    ];
    structSkipRefNumber = 10;
    Skip = class extends AbstractStruct {
      get deleted() {
        return true;
      }
      delete() {
      }
      /**
       * @param {Skip} right
       * @return {boolean}
       */
      mergeWith(right) {
        if (this.constructor !== right.constructor) {
          return false;
        }
        this.length += right.length;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        unexpectedCase();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeInfo(structSkipRefNumber);
        writeVarUint(encoder3.restEncoder, this.length - offset);
      }
      /**
       * @param {Transaction} transaction
       * @param {StructStore} store
       * @return {null | number}
       */
      getMissing(transaction, store) {
        return null;
      }
    };
    glo = /** @type {any} */
    typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {};
    importIdentifier = "__ $YJS$ __";
    if (glo[importIdentifier] === true) {
      console.error("Yjs was already imported. This breaks constructor checks and will lead to issues! - https://github.com/yjs/yjs/issues/438");
    }
    glo[importIdentifier] = true;
  }
});

// packages/shared/src/bus-index.ts
var empty, BusIndex;
var init_bus_index = __esm({
  "packages/shared/src/bus-index.ts"() {
    "use strict";
    init_yjs();
    init_messages();
    empty = () => ({ entries: /* @__PURE__ */ new Map(), ids: /* @__PURE__ */ new Map(), changed: /* @__PURE__ */ new Set(), sizes: /* @__PURE__ */ new Map(), bad: /* @__PURE__ */ new Set(), bytes: 0, invalid: 0, addressedCount: 0, addressedBytes: 0 });
    BusIndex = class {
      constructor(bus, onChange = () => {
      }) {
        this.bus = bus;
        this.onChange = onChange;
        this.rebuild();
        bus.observe(this.observe);
        bus.doc?.on("destroy", () => bus.unobserve(this.observe));
      }
      bus;
      onChange;
      state = empty();
      get entries() {
        return this.state.entries;
      }
      get ids() {
        return this.state.ids;
      }
      get changed() {
        return this.state.changed;
      }
      get bytes() {
        return this.state.bytes;
      }
      get invalid() {
        return this.state.invalid;
      }
      // Upper bound on bus values trim might move to mail; broadcasts can never move.
      get addressedCount() {
        return this.state.addressedCount;
      }
      get addressedBytes() {
        return this.state.addressedBytes;
      }
      stale = true;
      touched = /* @__PURE__ */ new Set();
      /** Changed values inspected; instrumentation for deterministic scaling tests. */
      visits = 0;
      encoder = new TextEncoder();
      observe = (_event, tx) => {
        this.touched = /* @__PURE__ */ new Set();
        if (this.stale) {
          this.rebuild();
          this.onChange(this.touched, true);
          return;
        }
        try {
          iterateDeletedStructs(tx, tx.deleteSet, (struct) => {
            if (!(struct instanceof Item) || struct.parent !== this.bus || struct.parentSub !== null) return;
            for (let i = 0; i < struct.length; i++) this.remove(`${struct.id.client}:${struct.id.clock + i}`);
          });
          for (const [client, end] of tx.afterState) {
            const start = tx.beforeState.get(client) ?? 0;
            if (start === end) continue;
            const structs = tx.doc.store.clients.get(client);
            if (!structs) throw new Error("missing client range");
            for (let i = findIndexSS(structs, start); i < structs.length; i++) {
              const struct = structs[i];
              if (struct.id.clock >= end) break;
              if (!(struct instanceof Item) || struct.parent !== this.bus || struct.parentSub !== null || struct.deleted) continue;
              const values = struct.content.getContent();
              for (let offset = Math.max(0, start - struct.id.clock); offset < values.length; offset++)
                this.add(`${client}:${struct.id.clock + offset}`, values[offset]);
            }
          }
          this.onChange(this.touched);
        } catch {
          this.rebuild();
          this.onChange(this.touched, true);
        }
      };
      add(key, m, state = this.state) {
        this.visits++;
        if (state.entries.has(key)) return;
        let size2, bad = !validMessageShape(m);
        try {
          size2 = this.encoder.encode(JSON.stringify(m) ?? "null").length;
        } catch {
          size2 = 2 ** 32;
          bad = true;
        }
        state.entries.set(key, m);
        if (bad) {
          state.bad.add(key);
          state.invalid++;
        }
        state.sizes.set(key, size2);
        state.bytes += size2;
        if (validMessageShape(m) && m.to) {
          state.addressedCount++;
          state.addressedBytes += size2;
        }
        const id2 = m?.id;
        if (typeof id2 !== "string") return;
        let values = state.ids.get(id2);
        if (!values) state.ids.set(id2, values = /* @__PURE__ */ new Map());
        values.set(key, m);
        state.changed.add(id2);
        this.touched.add(id2);
      }
      remove(key) {
        this.visits++;
        if (!this.entries.has(key)) return;
        const m = this.entries.get(key);
        this.entries.delete(key);
        if (this.state.bad.delete(key)) this.state.invalid--;
        const size2 = this.state.sizes.get(key) ?? 0;
        this.state.bytes -= size2;
        this.state.sizes.delete(key);
        if (validMessageShape(m) && m.to) {
          this.state.addressedCount--;
          this.state.addressedBytes -= size2;
        }
        const id2 = m?.id;
        if (typeof id2 !== "string") return;
        const values = this.ids.get(id2);
        values?.delete(key);
        if (!values?.size) {
          this.ids.delete(id2);
          this.changed.delete(id2);
        } else this.changed.add(id2);
        this.touched.add(id2);
      }
      recompute() {
        const next = empty();
        for (const structs of this.bus.doc.store.clients.values()) for (const struct of structs) {
          if (!(struct instanceof Item) || struct.parent !== this.bus || struct.parentSub !== null || struct.deleted) continue;
          const values = struct.content.getContent();
          values.forEach((m, i) => this.add(`${struct.id.client}:${struct.id.clock + i}`, m, next));
        }
        return next;
      }
      rebuild() {
        this.stale = true;
        try {
          this.state = this.recompute();
          this.stale = false;
        } catch {
        }
      }
      /** Independent full recompute, only for minute maintenance/debug. */
      drift() {
        if (this.stale) return "bus.stale";
        const next = this.recompute();
        if (next.bytes !== this.bytes) return "bus.bytes";
        if (next.invalid !== this.invalid || next.bad.size !== this.state.bad.size || [...next.bad].some((key) => !this.state.bad.has(key))) return "bus.invalid";
        if (next.addressedCount !== this.addressedCount || next.addressedBytes !== this.addressedBytes) return "bus.addressed";
        if (next.entries.size !== this.entries.size || [...next.entries].some(([key, m]) => this.entries.get(key) !== m)) return "bus.entries";
        if (next.ids.size !== this.ids.size || [...next.ids].some(([id2, values]) => {
          const old = this.ids.get(id2);
          return old?.size !== values.size || [...values].some(([key, m]) => old.get(key) !== m);
        })) return "bus.ids";
        if (next.sizes.size !== this.state.sizes.size || [...next.sizes].some(([key, size2]) => this.state.sizes.get(key) !== size2)) return "bus.sizes";
        return void 0;
      }
      count(id2) {
        return this.ids.get(id2)?.size ?? 0;
      }
      first(id2) {
        if (this.stale) return this.bus.toArray().find((m) => m?.id === id2);
        const values = this.ids.get(id2);
        return values?.size === 1 ? values.values().next().value : values?.size ? this.bus.toArray().find((m) => m?.id === id2) : void 0;
      }
    };
  }
});

// packages/shared/src/ledger.ts
function compactRetiredWorker(record) {
  const files = [...new Set(record.files)];
  return {
    ...record,
    task: record.task.slice(0, 200),
    summary: record.summary.slice(0, 400),
    files: files.slice(0, 50),
    fileCount: Math.max(record.fileCount, files.length)
  };
}
function msgPaths(m) {
  if ("paths" in m) return Array.isArray(m.paths) ? m.paths.filter((p) => typeof p === "string") : [];
  if ("path" in m) return typeof m.path === "string" ? [m.path] : [];
  return [];
}
function scopeCovers(scope, path12) {
  return Array.isArray(scope?.paths) && scope.paths.some((p) => typeof p === "string" && containsPath(p, path12));
}
function messageAreas(m, scopes) {
  const out = /* @__PURE__ */ new Set();
  if (m.type === "scope") out.add(m.area);
  for (const path12 of msgPaths(m)) for (const scope of scopes) if (scope && typeof scope.area === "string" && scopeCovers(scope, path12)) out.add(scope.area);
  return Array.from(out).sort();
}
function ledger(messages, scopes, q = {}) {
  const areaScopes = q.area ? scopes.filter((s) => s.area === q.area) : [];
  const out = [];
  for (const m of messages) {
    if (!validMessageShape(m)) continue;
    if (!LEDGER_TYPES.has(m.type)) continue;
    if (q.since && m.at < q.since) continue;
    const paths = msgPaths(m);
    if (q.path && !paths.includes(q.path)) continue;
    if (q.area) {
      const inArea = m.type === "scope" && m.area === q.area || paths.some((p) => areaScopes.some((s) => scopeCovers(s, p)));
      if (!inArea) continue;
    }
    out.push(m);
  }
  return q.limit ? out.slice(-q.limit) : out;
}
function areaSummary(messages, scopes, windowMs = 10 * 60 * 1e3, now = Date.now()) {
  const areas = Array.from(new Set(scopes.map((s) => s.area))).sort();
  return areas.map((area) => {
    const recent = ledger(messages, scopes, { area, since: now - windowMs }).filter((m) => m.type === "changed");
    const who2 = Array.from(new Set(recent.map((m) => m.from)));
    const owners = scopes.filter((s) => s.area === area).map((s) => s.by);
    return `${area} (${owners.join(", ")}): ${recent.length} change${recent.length === 1 ? "" : "s"} in the last ${Math.round(windowMs / 6e4)} min${who2.length ? ` by ${who2.join(", ")}` : ""}`;
  });
}
var MAX_RETIRED_WORKERS, LEDGER_TYPES;
var init_ledger = __esm({
  "packages/shared/src/ledger.ts"() {
    "use strict";
    init_near();
    init_messages();
    MAX_RETIRED_WORKERS = 200;
    LEDGER_TYPES = /* @__PURE__ */ new Set(["scope", "claim", "changed", "release", "conflict", "base", "plan"]);
  }
});

// packages/shared/src/delivery.ts
function isOwed(doc, m) {
  return !!m.to && !selfSent(m) && !doc.outcomes.has(m.id) && !receipted(doc, m.to, m.id);
}
function answeredIds(messages) {
  const out = /* @__PURE__ */ new Set();
  for (const m of messages) if ((m.type === "answer" || m.type === "note") && m.inReplyTo) out.add(m.inReplyTo);
  return out;
}
function replyEligible(m, answered, now) {
  return !!m.to && (m.type === "question" || m.type === "note") && !answered.has(m.id) && now - m.at < REPLY_WINDOW_MS;
}
function compact(m, scopes) {
  const entry = [m.type, m.from, m.at, messageAreas(m, scopes)];
  if (m.type === "release" && m.unfulfilled?.length) {
    entry.push({ path: m.path, plans: m.unfulfilled, ...m.summary ? { summary: m.summary } : {} });
  }
  return entry;
}
function evictionClass(m, owedNow) {
  if (!owedNow) return 0;
  if (m.type === "question") return 4;
  return m.priority === "fyi" ? 1 : m.priority === "notify" ? 2 : 3;
}
function newest(entries, max2, budget) {
  const kept = /* @__PURE__ */ new Set();
  let spent = 0;
  for (const e of [...entries].sort((a, b) => byAge(b, a))) {
    if (kept.size >= max2 || spent + e.size > budget) break;
    kept.add(e.id);
    spent += e.size;
  }
  return kept;
}
function trim(doc, now, opts = {}) {
  const report = { archived: 0, mailed: 0, expired: 0, evicted: 0, removed: 0 };
  const rawBus = doc.messages();
  const badBus = [];
  rawBus.forEach((m, i) => {
    if (!validMessageShape(m)) badBus.push(i);
  });
  if (badBus.length) doc.doc.transact(() => {
    for (const i of badBus.reverse()) doc.bus.delete(i, 1);
  }, opts.origin);
  const bus = doc.messages();
  const mail = new Map([...doc.mail.entries()].filter(([id2, m]) => typeof id2 === "string" && validMessageShape(m)));
  const answered = answeredIds([...bus, ...mail.values()]);
  const eligible = (m) => replyEligible(m, answered, now);
  let cutoff = Math.max(0, bus.length - Math.max(0, opts.busKeep ?? BUS_KEEP));
  for (let i = bus.length - 1, bytes = 0; i >= cutoff; i--) {
    bytes += sizeOf(bus[i]);
    if (bytes > (opts.busBytes ?? BUS_BYTES)) {
      cutoff = i + 1;
      break;
    }
  }
  const stored = /* @__PURE__ */ new Map();
  for (const [id2, m] of mail) if (isOwed(doc, m) || eligible(m)) stored.set(id2, m);
  for (const m of bus.slice(0, cutoff)) if (!stored.has(m.id) && !mail.has(m.id) && (isOwed(doc, m) || eligible(m))) stored.set(m.id, m);
  const pending = /* @__PURE__ */ new Map();
  for (const m of [...stored.values(), ...bus.slice(cutoff)]) if (!pending.has(m.id) && isOwed(doc, m)) pending.set(m.id, m);
  const ended = /* @__PURE__ */ new Map();
  const end = (m, outcome) => {
    ended.set(m.id, { to: m.to, from: m.from, outcome, at: now });
    pending.delete(m.id);
    stored.delete(m.id);
    if (outcome === "expired") report.expired++;
    else report.evicted++;
  };
  for (const m of [...pending.values()]) if (now - m.at > OWED_TTL_MS) end(m, "expired");
  const byRecipient = /* @__PURE__ */ new Map();
  for (const m of pending.values()) {
    const list = byRecipient.get(m.to);
    if (list) list.push(m);
    else byRecipient.set(m.to, [m]);
  }
  const evictionOrder = (a, b) => evictionClass(a, pending.has(a.id)) - evictionClass(b, pending.has(b.id)) || byAge(a, b);
  for (const list of byRecipient.values()) {
    let count = list.length, bytes = list.reduce((n, m) => n + sizeOf(m), 0);
    for (const m of list.sort(evictionOrder)) {
      if (count <= OWED_PER_RECIPIENT && bytes <= OWED_BYTES_PER_RECIPIENT) break;
      end(m, "over-cap");
      count--;
      bytes -= sizeOf(m);
    }
  }
  let mailCount = stored.size, mailBytes = [...stored.values()].reduce((n, m) => n + sizeOf(m), 0);
  for (const m of [...stored.values()].sort(evictionOrder)) {
    if (mailCount <= MAIL_MAX && mailBytes <= MAIL_BYTES) break;
    mailCount--;
    mailBytes -= sizeOf(m);
    if (pending.has(m.id)) end(m, "over-cap");
    else {
      stored.delete(m.id);
      report.evicted++;
    }
  }
  const scopes = [...doc.scopes.values()].filter((s) => s && typeof s.area === "string" && Array.isArray(s.paths));
  const leaving = bus.filter((m, i) => i < cutoff || ended.has(m.id));
  const archived = /* @__PURE__ */ new Map();
  for (const m of leaving) if (!doc.archive.has(m.id) && !archived.has(m.id)) archived.set(m.id, compact(m, scopes));
  const archive = [...doc.archive.entries(), ...archived.entries()].filter(([id2, entry]) => typeof id2 === "string" && Array.isArray(entry) && typeof entry[2] === "number" && Array.isArray(entry[3])).map(([id2, entry]) => ({ id: id2, at: entry[2], size: id2.length + sizeOf(entry), unfulfilled: !!entry[4] }));
  const keepArchive = newest(archive, ARCHIVE_MAX, ARCHIVE_BYTES);
  for (const id2 of newest(archive.filter((e) => e.unfulfilled), ARCHIVE_UNFULFILLED_MAX, Infinity)) keepArchive.add(id2);
  const outcomes = [...doc.outcomes.entries(), ...[...ended].filter(([id2]) => !doc.outcomes.has(id2))].filter(([id2, o]) => typeof id2 === "string" && validOutcome(o) && now - o.at <= OUTCOMES_TTL_MS).map(([id2, o]) => ({ id: id2, at: o.at, size: id2.length + sizeOf(o) }));
  const keepOutcomes = newest(outcomes, OUTCOMES_MAX, OUTCOMES_BYTES);
  doc.doc.transact(() => {
    for (const [id2, m] of doc.mail.entries()) if (!validMessageShape(m)) doc.mail.delete(id2);
    for (const [id2, entry] of archived) if (keepArchive.has(id2)) {
      doc.archive.set(id2, entry);
      report.archived++;
    }
    for (const id2 of [...doc.archive.keys()]) if (!keepArchive.has(id2)) doc.archive.delete(id2);
    for (const id2 of [...doc.mail.keys()]) if (!stored.has(id2)) doc.mail.delete(id2);
    for (const [id2, m] of stored) if (!doc.mail.has(id2)) {
      doc.mail.set(id2, m);
      report.mailed++;
    }
    for (const [id2, o] of ended) if (keepOutcomes.has(id2) && !doc.outcomes.has(id2)) doc.outcomes.set(id2, o);
    for (const id2 of [...doc.outcomes.keys()]) if (!keepOutcomes.has(id2)) doc.outcomes.delete(id2);
    for (let i = bus.length - 1; i >= 0; ) {
      if (i >= cutoff && !ended.has(bus[i].id)) {
        i--;
        continue;
      }
      let start = i;
      while (start > 0 && (start - 1 < cutoff || ended.has(bus[start - 1].id))) start--;
      doc.bus.delete(start, i - start + 1);
      report.removed += i - start + 1;
      i = start - 1;
    }
  }, opts.origin);
  deliveryIndex(doc).markTrimmed(now, opts);
  return report;
}
function deliveryIndex(doc) {
  let index = indexes.get(doc.doc);
  if (!index) {
    index = new DeliveryIndex(doc);
    indexes.set(doc.doc, index);
  }
  return index;
}
function admit(doc, m, now, opts = {}) {
  const size2 = sizeOf(m);
  if (size2 > MAX_MESSAGE_BYTES) return { ok: false, reason: `the message is ${Math.ceil(size2 / KiB)} KiB; the limit is ${MAX_MESSAGE_BYTES / KiB} KiB` };
  if (!m.to) return { ok: true };
  const index = deliveryIndex(doc);
  const caps = () => {
    const theirs = index.recipients.get(m.to) ?? { count: 0, bytes: 0 };
    if (theirs.count >= OWED_PER_RECIPIENT || theirs.bytes + size2 > OWED_BYTES_PER_RECIPIENT)
      return { ok: false, reason: `${m.to} has ${theirs.count} undelivered messages; wait until it reads them` };
    if (index.owedBytes + size2 > MAIL_BYTES)
      return { ok: false, reason: `the room's message store is full (${Math.round(index.owedBytes / KiB)} KiB owed to others)` };
    return { ok: true };
  };
  const answer = caps();
  if (index.certain(now, opts) && (answer.ok || index.trimmed(now, opts))) return answer;
  trim(doc, now, opts);
  if (index.bus.stale) {
    const pending = /* @__PURE__ */ new Map();
    for (const x of [...doc.mail.values(), ...doc.messages()]) if (!pending.has(x.id) && isOwed(doc, x)) pending.set(x.id, x);
    const theirs = [...pending.values()].filter((x) => x.to === m.to);
    const theirBytes = theirs.reduce((n, x) => n + sizeOf(x), 0);
    if (theirs.length >= OWED_PER_RECIPIENT || theirBytes + size2 > OWED_BYTES_PER_RECIPIENT)
      return { ok: false, reason: `${m.to} has ${theirs.length} undelivered messages; wait until it reads them` };
    const owedBytes = [...pending.values()].reduce((n, x) => n + sizeOf(x), 0);
    if (owedBytes + size2 > MAIL_BYTES)
      return { ok: false, reason: `the room's message store is full (${Math.round(owedBytes / KiB)} KiB owed to others)` };
    return { ok: true };
  }
  return caps();
}
var KiB, MiB, DAY_MS, BUS_KEEP, BUS_BYTES, MAIL_MAX, MAIL_BYTES, OWED_PER_RECIPIENT, OWED_BYTES_PER_RECIPIENT, ARCHIVE_MAX, ARCHIVE_BYTES, ARCHIVE_UNFULFILLED_MAX, OUTCOMES_MAX, OUTCOMES_BYTES, OUTCOMES_TTL_MS, RECEIPTS_BYTES, LEDGER_BUDGET, REPLY_WINDOW_MS, OWED_TTL_MS, MAX_MESSAGE_BYTES, encoder, sizeOf, validOutcome, compare, byAge, selfSent, receipted, DeliveryIndex, indexes;
var init_delivery = __esm({
  "packages/shared/src/delivery.ts"() {
    "use strict";
    init_yjs();
    init_bus_index();
    init_ledger();
    init_messages();
    KiB = 1024;
    MiB = 1024 * KiB;
    DAY_MS = 24 * 60 * 60 * 1e3;
    BUS_KEEP = 2e3;
    BUS_BYTES = 1.5 * MiB;
    MAIL_MAX = 2e3;
    MAIL_BYTES = 1.5 * MiB;
    OWED_PER_RECIPIENT = 200;
    OWED_BYTES_PER_RECIPIENT = 256 * KiB;
    ARCHIVE_MAX = 5e3;
    ARCHIVE_BYTES = 512 * KiB;
    ARCHIVE_UNFULFILLED_MAX = 200;
    OUTCOMES_MAX = 2e3;
    OUTCOMES_BYTES = 256 * KiB;
    OUTCOMES_TTL_MS = 30 * DAY_MS;
    RECEIPTS_BYTES = 256 * KiB;
    LEDGER_BUDGET = BUS_BYTES + MAIL_BYTES + ARCHIVE_BYTES + OUTCOMES_BYTES + RECEIPTS_BYTES;
    REPLY_WINDOW_MS = 14 * DAY_MS;
    OWED_TTL_MS = 14 * DAY_MS;
    MAX_MESSAGE_BYTES = 64 * KiB;
    encoder = new TextEncoder();
    sizeOf = (value2) => {
      try {
        return encoder.encode(JSON.stringify(value2)).length;
      } catch {
        return 2 ** 32;
      }
    };
    validOutcome = (o) => !!o && Number.isFinite(o.at) && typeof o.to === "string" && typeof o.from === "string" && ["expired", "over-cap", "recipient-retired"].includes(o.outcome);
    compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    byAge = (a, b) => a.at - b.at || compare(a.id, b.id);
    selfSent = (m) => m.from === m.to && m.fromKind !== "human";
    receipted = (doc, name, id2) => doc.seen(name).has(id2);
    DeliveryIndex = class {
      constructor(doc) {
        this.doc = doc;
        this.bus = new BusIndex(doc.bus, (ids, rebuilt) => {
          this.clean = false;
          if (rebuilt) this.rebuildPending = true;
          else for (const id2 of ids) this.changed.add(id2);
        });
        doc.mail.observe((e) => {
          for (const key of e.keysChanged) {
            const oldId = this.mailIds.get(key);
            this.checkMail(key);
            if (oldId !== void 0) this.changed.add(oldId);
            const id2 = this.mailIds.get(key);
            if (id2 !== void 0) this.changed.add(id2);
          }
        });
        doc.outcomes.observe((e) => {
          for (const id2 of e.keysChanged) {
            this.checkOutcome(id2);
            this.changed.add(id2);
          }
        });
        doc.archive.observe((e) => {
          for (const id2 of e.keysChanged) if (this.bus.count(id2)) this.bus.changed.add(id2);
        });
        this.rebuildAggregates();
        this.cacheRoots();
        doc.doc.on("afterTransaction", this.afterTransaction);
        doc.doc.on("destroy", () => doc.doc.off("afterTransaction", this.afterTransaction));
      }
      doc;
      bus;
      recipients = /* @__PURE__ */ new Map();
      pending = /* @__PURE__ */ new Map();
      owedBytes = 0;
      sizes = /* @__PURE__ */ new Map();
      badMail = /* @__PURE__ */ new Set();
      badOutcomes = /* @__PURE__ */ new Set();
      outcomeSizes = /* @__PURE__ */ new Map();
      outcomeBytes = 0;
      mailSizes = /* @__PURE__ */ new Map();
      mailBytes = 0;
      aliases = /* @__PURE__ */ new Set();
      duplicateBus = /* @__PURE__ */ new Set();
      overCapRecipients = /* @__PURE__ */ new Set();
      mailCopies = /* @__PURE__ */ new Map();
      mailIds = /* @__PURE__ */ new Map();
      clean = false;
      cleanKeep = BUS_KEEP;
      cleanBytes = BUS_BYTES;
      oldest = Infinity;
      oldestOutcome = Infinity;
      changed = /* @__PURE__ */ new Set();
      rebuildPending = false;
      rootNames = /* @__PURE__ */ new Map();
      afterTransaction = (tx) => {
        let unknown = false;
        for (const type of tx.changed.keys()) if (type.parent === null && !this.rootNames.has(type)) {
          unknown = true;
          break;
        }
        if (unknown) this.cacheRoots();
        for (const [type, keys3] of tx.changed) {
          if (!(type instanceof YMap) || !this.rootNames.get(type)?.startsWith("seen:")) continue;
          for (const key of keys3) if (key !== null) this.changed.add(key);
        }
        const changed = this.changed;
        this.changed = /* @__PURE__ */ new Set();
        if (this.rebuildPending) {
          this.rebuildPending = false;
          this.rebuildAggregates();
        } else this.refreshMany(changed);
      };
      cacheRoots() {
        for (const [name, type] of this.doc.doc.share) this.rootNames.set(type, name);
      }
      checkMail(key) {
        const old = this.mailIds.get(key);
        if (old !== void 0) {
          const copies = this.mailCopies.get(old);
          copies?.delete(key);
          if (!copies?.size) this.mailCopies.delete(old);
        }
        this.mailIds.delete(key);
        this.aliases.delete(key);
        this.mailBytes -= this.mailSizes.get(key) ?? 0;
        this.mailSizes.delete(key);
        const m = this.doc.mail.get(key);
        if (this.doc.mail.has(key) && !validMessageShape(m)) this.badMail.add(key);
        else this.badMail.delete(key);
        if (validMessageShape(m)) {
          let copies = this.mailCopies.get(m.id);
          if (!copies) this.mailCopies.set(m.id, copies = /* @__PURE__ */ new Map());
          copies.set(key, m);
          this.mailIds.set(key, m.id);
          if (key !== m.id) this.aliases.add(key);
          const size2 = sizeOf(m);
          this.mailSizes.set(key, size2);
          this.mailBytes += size2;
        }
      }
      checkOutcome(id2) {
        this.outcomeBytes -= this.outcomeSizes.get(id2) ?? 0;
        this.outcomeSizes.delete(id2);
        const o = this.doc.outcomes.get(id2);
        if (this.doc.outcomes.has(id2) && !validOutcome(o)) this.badOutcomes.add(id2);
        else this.badOutcomes.delete(id2);
        if (o && !this.badOutcomes.has(id2)) {
          const size2 = id2.length + sizeOf(o);
          this.outcomeSizes.set(id2, size2);
          this.outcomeBytes += size2;
          this.oldestOutcome = Math.min(this.oldestOutcome, o.at);
        }
        if (this.bus.count(id2)) this.bus.changed.add(id2);
      }
      refreshMany(ids) {
        const ordered = /* @__PURE__ */ new Map();
        for (const id2 of ids) if (this.bus.count(id2) + (this.mailCopies.get(id2)?.size ?? 0) > 1) ordered.set(id2, []);
        if (ordered.size) {
          for (const m of this.doc.mail.values()) if (validMessageShape(m)) ordered.get(m.id)?.push(m);
          for (const m of this.doc.bus.toArray()) if (validMessageShape(m)) ordered.get(m.id)?.push(m);
        }
        for (const id2 of ids) this.refresh(id2, ordered.get(id2));
      }
      refresh(id2, ordered) {
        const prior = this.pending.get(id2);
        if (prior) {
          const size2 = this.sizes.get(id2);
          const count = this.recipients.get(prior.to);
          count.count--;
          count.bytes -= size2;
          this.owedBytes -= size2;
          if (!count.count) this.recipients.delete(prior.to);
          this.checkRecipient(prior.to);
          this.pending.delete(id2);
          this.sizes.delete(id2);
        }
        const mail = this.mailCopies.get(id2);
        const bus = this.bus.ids.get(id2);
        const candidates = ordered ?? [...mail?.values() ?? [], ...bus?.values() ?? []];
        if ((bus?.size ?? 0) > 1) this.duplicateBus.add(id2);
        else this.duplicateBus.delete(id2);
        const m = candidates.find((m2) => validMessageShape(m2) && isOwed(this.doc, m2));
        if (m) {
          const size2 = sizeOf(m);
          const count = this.recipients.get(m.to) ?? { count: 0, bytes: 0 };
          count.count++;
          count.bytes += size2;
          this.owedBytes += size2;
          this.recipients.set(m.to, count);
          this.pending.set(id2, m);
          this.sizes.set(id2, size2);
          this.checkRecipient(m.to);
          if (Number.isFinite(m.at)) this.oldest = Math.min(this.oldest, m.at);
        }
        if (prior || m || candidates.some((m2) => validMessageShape(m2) && (m2.to || "inReplyTo" in m2 && m2.inReplyTo))) this.clean = false;
      }
      checkRecipient(name) {
        const r = this.recipients.get(name);
        if (r && (r.count > OWED_PER_RECIPIENT || r.bytes > OWED_BYTES_PER_RECIPIENT)) this.overCapRecipients.add(name);
        else this.overCapRecipients.delete(name);
      }
      /** Debug/recovery check: callers can snapshot aggregates, rebuild, then compare to full recompute. */
      rebuild() {
        this.bus.rebuild();
        this.rebuildAggregates();
      }
      /** Minute-only full recompute; correct any drift before the next post can use it. */
      verify() {
        let field = this.bus.drift();
        const pending = /* @__PURE__ */ new Map(), sizes = /* @__PURE__ */ new Map(), recipients = /* @__PURE__ */ new Map();
        const mailIds = /* @__PURE__ */ new Map(), mailSizes = /* @__PURE__ */ new Map(), outcomeSizes = /* @__PURE__ */ new Map();
        const badMail = /* @__PURE__ */ new Set(), badOutcomes = /* @__PURE__ */ new Set(), aliases = /* @__PURE__ */ new Set(), duplicateBus = /* @__PURE__ */ new Set();
        const busCounts = /* @__PURE__ */ new Map();
        for (const m of this.doc.messages()) if (typeof m?.id === "string") busCounts.set(m.id, (busCounts.get(m.id) ?? 0) + 1);
        for (const [id2, count] of busCounts) if (count > 1) duplicateBus.add(id2);
        let owedBytes = 0, mailBytes = 0, outcomeBytes = 0, oldest = Infinity, oldestOutcome = Infinity;
        for (const [key, m] of this.doc.mail) {
          if (!validMessageShape(m)) {
            badMail.add(key);
            continue;
          }
          mailIds.set(key, m.id);
          const size2 = sizeOf(m);
          mailSizes.set(key, size2);
          mailBytes += size2;
          if (key !== m.id) aliases.add(key);
        }
        for (const m of [...this.doc.mail.values(), ...this.doc.messages()]) {
          if (!validMessageShape(m)) continue;
          if (!pending.has(m.id) && isOwed(this.doc, m)) {
            pending.set(m.id, m);
            const size2 = sizeOf(m), r = recipients.get(m.to) ?? { count: 0, bytes: 0 };
            r.count++;
            r.bytes += size2;
            recipients.set(m.to, r);
            owedBytes += size2;
            sizes.set(m.id, size2);
            if (Number.isFinite(m.at)) oldest = Math.min(oldest, m.at);
          }
        }
        for (const [id2, o] of this.doc.outcomes) {
          if (!validOutcome(o)) {
            badOutcomes.add(id2);
            continue;
          }
          const size2 = id2.length + sizeOf(o);
          outcomeSizes.set(id2, size2);
          outcomeBytes += size2;
          oldestOutcome = Math.min(oldestOutcome, o.at);
        }
        const sameMap = (a, b) => a.size === b.size && [...a].every(([id2, value2]) => b.get(id2) === value2);
        const sameSet = (a, b) => a.size === b.size && [...a].every((id2) => b.has(id2));
        const overCap = new Set([...recipients].filter(([, r]) => r.count > OWED_PER_RECIPIENT || r.bytes > OWED_BYTES_PER_RECIPIENT).map(([name]) => name));
        if (!field && owedBytes !== this.owedBytes) field = "owedBytes";
        if (!field && (!sameMap(pending, this.pending) || !sameMap(sizes, this.sizes))) field = "pending";
        if (!field && (recipients.size !== this.recipients.size || [...recipients].some(([name, r]) => {
          const old = this.recipients.get(name);
          return r.count !== old?.count || r.bytes !== old.bytes;
        }))) field = "recipients";
        if (!field && (!sameMap(mailIds, this.mailIds) || !sameMap(mailSizes, this.mailSizes) || mailBytes !== this.mailBytes || this.mailCopies.size !== new Set(mailIds.values()).size || [...mailIds].some(([key, id2]) => this.mailCopies.get(id2)?.get(key) !== this.doc.mail.get(key)) || [...this.mailCopies.values()].reduce((n, copies) => n + copies.size, 0) !== mailIds.size)) field = "mail";
        if (!field && (!sameMap(outcomeSizes, this.outcomeSizes) || outcomeBytes !== this.outcomeBytes)) field = "outcomes";
        if (!field && (!sameSet(badMail, this.badMail) || !sameSet(badOutcomes, this.badOutcomes))) field = "invalid";
        if (!field && (!sameSet(aliases, this.aliases) || !sameSet(duplicateBus, this.duplicateBus) || !sameSet(overCap, this.overCapRecipients))) field = "certainty";
        if (!field && (oldest !== this.oldest || oldestOutcome !== this.oldestOutcome)) field = "oldest";
        if (field) this.rebuild();
        return field;
      }
      rebuildAggregates() {
        this.pending.clear();
        this.recipients.clear();
        this.sizes.clear();
        this.badMail.clear();
        this.badOutcomes.clear();
        this.mailCopies.clear();
        this.mailIds.clear();
        this.owedBytes = 0;
        this.outcomeSizes.clear();
        this.outcomeBytes = 0;
        this.mailSizes.clear();
        this.mailBytes = 0;
        this.aliases.clear();
        this.duplicateBus.clear();
        this.overCapRecipients.clear();
        this.oldest = this.oldestOutcome = Infinity;
        this.clean = false;
        for (const id2 of this.doc.mail.keys()) this.checkMail(id2);
        for (const id2 of this.doc.outcomes.keys()) this.checkOutcome(id2);
        this.refreshMany(/* @__PURE__ */ new Set([...this.bus.ids.keys(), ...this.mailCopies.keys()]));
      }
      markTrimmed(now, opts) {
        this.cleanKeep = opts.busKeep ?? BUS_KEEP;
        this.cleanBytes = opts.busBytes ?? BUS_BYTES;
        this.oldest = Math.min(Infinity, ...[...this.pending.values()].filter((m) => Number.isFinite(m.at)).map((m) => m.at));
        this.oldestOutcome = Math.min(Infinity, ...[...this.doc.outcomes.values()].filter((o) => o && Number.isFinite(o.at)).map((o) => o.at));
        this.clean = !this.bus.stale && this.bus.invalid === 0 && !this.badMail.size && !this.badOutcomes.size && now - this.oldest <= OWED_TTL_MS;
      }
      certain(now, opts = {}) {
        const retention = this.bus.entries.size > (opts.busKeep ?? BUS_KEEP) || this.bus.bytes > (opts.busBytes ?? BUS_BYTES);
        const mailRisk = this.mailSizes.size > MAIL_MAX || this.mailBytes > MAIL_BYTES || retention && (this.mailSizes.size + this.bus.addressedCount > MAIL_MAX || this.mailBytes + this.bus.addressedBytes > MAIL_BYTES);
        return !this.bus.stale && !this.bus.invalid && !this.badMail.size && !this.badOutcomes.size && this.outcomeSizes.size <= OUTCOMES_MAX && this.outcomeBytes <= OUTCOMES_BYTES && now - this.oldestOutcome <= OUTCOMES_TTL_MS && !this.aliases.size && !(this.duplicateBus.size && (retention || mailRisk)) && !(this.outcomeSizes.size && (this.overCapRecipients.size || mailRisk || now - this.oldest > OWED_TTL_MS));
      }
      trimmed(now, opts) {
        return this.clean && this.certain(now, opts) && now - this.oldest <= OWED_TTL_MS && this.cleanKeep === (opts.busKeep ?? BUS_KEEP) && this.cleanBytes === (opts.busBytes ?? BUS_BYTES);
      }
    };
    indexes = /* @__PURE__ */ new WeakMap();
  }
});

// packages/shared/src/worker-memory.ts
function revisions(doc) {
  const latest = /* @__PURE__ */ new Map();
  const see = (r) => {
    const old = latest.get(r.name);
    if (!old || compareRevision(r, old) > 0) latest.set(r.name, r);
  };
  for (const r of doc.getMap(REVISIONS).values()) see(r);
  for (const p of doc.getMap("completedPublications").values()) see(publicationRevision(p));
  const names = /* @__PURE__ */ new Set([...latest.keys(), ...[...doc.getMap("workerViews").values()].map((worker) => worker.name)]);
  const participants = doc.getMap("participants");
  const heads = doc.getMap("manifestHead");
  for (const name of names) {
    const holder = participants.get(`${name}\0holder`);
    if (holder && Number.isSafeInteger(holder.epoch)) see({ name, epoch: holder.epoch, semRev: -1, rev: -1 });
    const head = heads.get(name);
    const epoch = head && Number(head.fence);
    if (head && epoch !== void 0 && Number.isSafeInteger(epoch)) see({ name, epoch, semRev: head.semRev, rev: head.rev });
  }
  return latest;
}
function publicationRevisionCurrent(doc, name, head) {
  const known = revisions(doc).get(name);
  return !known || compareRevision({ name, epoch: Number(head.fence), semRev: head.semRev, rev: head.rev }, known) >= 0;
}
function contradicted(doc, p) {
  const view = doc.getMap("workerViews").get(p.worker.id);
  const holder = doc.getMap("participants").get(`${p.worker.name}\0holder`);
  return !!view && (view.name !== p.worker.name || view.run !== p.worker.run || view.status !== "done") || !!holder && (holder.workerId !== p.worker.id || holder.epoch !== p.holder.epoch) || doc.getArray("retiredWorkers").toArray().some((value2) => value2.id === p.worker.id);
}
function retainedPublication(room, name) {
  if (room.manifestHead.has(name)) return void 0;
  const view = room.acceptedWorkerViewOf(name);
  if (!view || view.status !== "done") return void 0;
  const latest = revisions(room.doc);
  return [...room.doc.getMap("completedPublications").values()].find((p) => p.worker.id === view.id && p.worker.run === view.run && p.worker.name === name && matchesRevision(p, latest) && !contradicted(room.doc, p));
}
function workerMemory(doc) {
  const latest = revisions(doc);
  const heads = doc.getMap("manifestHead");
  const participants = doc.getMap("participants");
  const manifests = doc.getMap("manifest");
  const overlays = doc.getMap("overlays");
  const publications = /* @__PURE__ */ new Map();
  for (const p of doc.getMap("completedPublications").values()) {
    if (!heads.has(p.worker.name) && matchesRevision(p, latest) && !contradicted(doc, p)) {
      const old = publications.get(p.worker.id);
      if (!old || p.holder.epoch > old.holder.epoch || p.holder.epoch === old.holder.epoch && p.head.rev > old.head.rev) publications.set(p.worker.id, p);
    }
  }
  for (const worker of doc.getMap("workerViews").values()) {
    if (worker.status !== "done") continue;
    const head = heads.get(worker.name);
    const holder = participants.get(`${worker.name}\0holder`);
    const git = participants.get(`${worker.name}\0git`);
    if (!head?.complete || head.projectedFrom || head.level === "intent" || head.coverage.kind !== "all" || holder?.workerId !== worker.id || String(holder.epoch) !== head.fence || git?.fence !== head.fence || git.base !== head.base) continue;
    const key = `${worker.name}\0${head.fence}`;
    const manifest = manifests.get(key);
    if (!manifest) continue;
    const entries = [...manifest].filter(([, entry]) => entry.fence === head.fence);
    const texts = entries.flatMap(([path12, entry]) => {
      const value2 = entry.state === "shared" && entry.change !== "D" && entry.hash ? overlays.get(key)?.get(path12) : void 0;
      return value2 ? [[path12, value2.toString()]] : [];
    });
    const shared = new Set(entries.filter(([, entry]) => entry.state === "shared").map(([path12]) => path12));
    for (const prefix2 of head.textPrefixes ?? []) if (!prefix2.endsWith("/") && !manifest.has(prefix2)) shared.add(prefix2);
    const baseTexts = [...doc.getMap("basetextFlat")].flatMap(([key2, value2]) => {
      const prefix2 = `${worker.name}\0${head.base}:`;
      const path12 = key2.startsWith(prefix2) ? key2.slice(prefix2.length) : void 0;
      return path12 !== void 0 && shared.has(path12) ? [[path12, value2]] : [];
    });
    const p = { key: `${worker.id}\0${worker.run}\0${head.fence}\0${head.semRev}\0${head.rev}`, worker, head, holder: { ...holder, ended: holder.ended ?? "released" }, git, entries, texts, baseTexts };
    if (matchesRevision(p, latest) && !contradicted(doc, p)) publications.set(worker.id, p);
  }
  return {
    publications: [...publications.values()].sort((a, b) => (a.worker.finishedAt ?? 0) - (b.worker.finishedAt ?? 0)).map((p) => ({
      size: JSON.stringify(p).length,
      copyTo(copy2) {
        copy2.getMap("completedPublications").set(p.key, p);
      }
    })),
    // Never shed these with text: a late replica must not revive a superseded policy.
    copyRevisionsTo(copy2) {
      for (const revision of latest.values()) copy2.getMap(REVISIONS).set(revisionKey(revision), revision);
    }
  };
}
var REVISIONS, revisionKey, compareRevision, publicationRevision, matchesRevision;
var init_worker_memory = __esm({
  "packages/shared/src/worker-memory.ts"() {
    "use strict";
    REVISIONS = "completedPublicationRevisions";
    revisionKey = (r) => `${r.name}\0${r.epoch}\0${r.semRev}\0${r.rev}`;
    compareRevision = (a, b) => a.epoch - b.epoch || a.semRev - b.semRev || a.rev - b.rev;
    publicationRevision = (p) => ({ name: p.worker.name, epoch: p.holder.epoch, semRev: p.head.semRev, rev: p.head.rev });
    matchesRevision = (p, latest) => {
      const known = latest.get(p.worker.name);
      return !!known && compareRevision(publicationRevision(p), known) === 0;
    };
  }
});

// node_modules/diff/libesm/diff/base.js
var Diff;
var init_base = __esm({
  "node_modules/diff/libesm/diff/base.js"() {
    "use strict";
    Diff = class {
      diff(oldStr, newStr, options = {}) {
        let callback;
        if (typeof options === "function") {
          callback = options;
          options = {};
        } else if ("callback" in options) {
          callback = options.callback;
        }
        const oldString = this.castInput(oldStr, options);
        const newString = this.castInput(newStr, options);
        const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
        const newTokens = this.removeEmpty(this.tokenize(newString, options));
        return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
      }
      diffWithOptionsObj(oldTokens, newTokens, options, callback) {
        var _a;
        const done = (value2) => {
          value2 = this.postProcess(value2, options);
          if (callback) {
            setTimeout(function() {
              callback(value2);
            }, 0);
            return void 0;
          } else {
            return value2;
          }
        };
        const newLen = newTokens.length, oldLen = oldTokens.length;
        let editLength = 1;
        let maxEditLength = newLen + oldLen;
        if (options.maxEditLength != null) {
          maxEditLength = Math.min(maxEditLength, options.maxEditLength);
        }
        const maxExecutionTime = (_a = options.timeout) !== null && _a !== void 0 ? _a : Infinity;
        const abortAfterTimestamp = Date.now() + maxExecutionTime;
        const bestPath = [{ oldPos: -1, lastComponent: void 0 }];
        let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
        if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
          return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
        }
        let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
        const execEditLength = () => {
          for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
            let basePath;
            const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
            if (removePath) {
              bestPath[diagonalPath - 1] = void 0;
            }
            let canAdd = false;
            if (addPath) {
              const addPathNewPos = addPath.oldPos - diagonalPath;
              canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
            }
            const canRemove = removePath && removePath.oldPos + 1 < oldLen;
            if (!canAdd && !canRemove) {
              bestPath[diagonalPath] = void 0;
              continue;
            }
            if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) {
              basePath = this.addToPath(addPath, true, false, 0, options);
            } else {
              basePath = this.addToPath(removePath, false, true, 1, options);
            }
            newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
            if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
              return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
            } else {
              bestPath[diagonalPath] = basePath;
              if (basePath.oldPos + 1 >= oldLen) {
                maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
              }
              if (newPos + 1 >= newLen) {
                minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
              }
            }
          }
          editLength++;
        };
        if (callback) {
          (function exec() {
            setTimeout(function() {
              if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
                return callback(void 0);
              }
              if (!execEditLength()) {
                exec();
              }
            }, 0);
          })();
        } else {
          while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
            const ret = execEditLength();
            if (ret) {
              return ret;
            }
          }
        }
      }
      addToPath(path12, added, removed, oldPosInc, options) {
        const last2 = path12.lastComponent;
        if (last2 && !options.oneChangePerToken && last2.added === added && last2.removed === removed) {
          return {
            oldPos: path12.oldPos + oldPosInc,
            lastComponent: { count: last2.count + 1, added, removed, previousComponent: last2.previousComponent }
          };
        } else {
          return {
            oldPos: path12.oldPos + oldPosInc,
            lastComponent: { count: 1, added, removed, previousComponent: last2 }
          };
        }
      }
      extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
        const newLen = newTokens.length, oldLen = oldTokens.length;
        let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
        while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
          newPos++;
          oldPos++;
          commonCount++;
          if (options.oneChangePerToken) {
            basePath.lastComponent = { count: 1, previousComponent: basePath.lastComponent, added: false, removed: false };
          }
        }
        if (commonCount && !options.oneChangePerToken) {
          basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
        }
        basePath.oldPos = oldPos;
        return newPos;
      }
      equals(left, right, options) {
        if (options.comparator) {
          return options.comparator(left, right);
        } else {
          return left === right || !!options.ignoreCase && left.toLowerCase() === right.toLowerCase();
        }
      }
      removeEmpty(array) {
        const ret = [];
        for (let i = 0; i < array.length; i++) {
          if (array[i]) {
            ret.push(array[i]);
          }
        }
        return ret;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      castInput(value2, options) {
        return value2;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      tokenize(value2, options) {
        return Array.from(value2);
      }
      join(chars) {
        return chars.join("");
      }
      postProcess(changeObjects, options) {
        return changeObjects;
      }
      get useLongestToken() {
        return false;
      }
      buildValues(lastComponent, newTokens, oldTokens) {
        const components = [];
        let nextComponent;
        while (lastComponent) {
          components.push(lastComponent);
          nextComponent = lastComponent.previousComponent;
          delete lastComponent.previousComponent;
          lastComponent = nextComponent;
        }
        components.reverse();
        const componentLen = components.length;
        let componentPos = 0, newPos = 0, oldPos = 0;
        for (; componentPos < componentLen; componentPos++) {
          const component = components[componentPos];
          if (!component.removed) {
            if (!component.added && this.useLongestToken) {
              let value2 = newTokens.slice(newPos, newPos + component.count);
              value2 = value2.map(function(value3, i) {
                const oldValue = oldTokens[oldPos + i];
                return oldValue.length > value3.length ? oldValue : value3;
              });
              component.value = this.join(value2);
            } else {
              component.value = this.join(newTokens.slice(newPos, newPos + component.count));
            }
            newPos += component.count;
            if (!component.added) {
              oldPos += component.count;
            }
          } else {
            component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
            oldPos += component.count;
          }
        }
        return components;
      }
    };
  }
});

// node_modules/diff/libesm/diff/character.js
function diffChars(oldStr, newStr, options) {
  return characterDiff.diff(oldStr, newStr, options);
}
var CharacterDiff, characterDiff;
var init_character = __esm({
  "node_modules/diff/libesm/diff/character.js"() {
    "use strict";
    init_base();
    CharacterDiff = class extends Diff {
    };
    characterDiff = new CharacterDiff();
  }
});

// node_modules/diff/libesm/diff/line.js
function diffLines(oldStr, newStr, options) {
  return lineDiff.diff(oldStr, newStr, options);
}
function tokenize(value2, options) {
  if (options.stripTrailingCr) {
    value2 = value2.replace(/\r\n/g, "\n");
  }
  const retLines = [], linesAndNewlines = value2.split(/(\n|\r\n)/);
  if (!linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop();
  }
  for (let i = 0; i < linesAndNewlines.length; i++) {
    const line = linesAndNewlines[i];
    if (i % 2 && !options.newlineIsToken) {
      retLines[retLines.length - 1] += line;
    } else {
      retLines.push(line);
    }
  }
  return retLines;
}
var LineDiff, lineDiff;
var init_line = __esm({
  "node_modules/diff/libesm/diff/line.js"() {
    "use strict";
    init_base();
    LineDiff = class extends Diff {
      constructor() {
        super(...arguments);
        this.tokenize = tokenize;
      }
      equals(left, right, options) {
        if (options.ignoreWhitespace) {
          if (!options.newlineIsToken || !left.includes("\n")) {
            left = left.trim();
          }
          if (!options.newlineIsToken || !right.includes("\n")) {
            right = right.trim();
          }
        } else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
          if (left.endsWith("\n")) {
            left = left.slice(0, -1);
          }
          if (right.endsWith("\n")) {
            right = right.slice(0, -1);
          }
        }
        return super.equals(left, right, options);
      }
    };
    lineDiff = new LineDiff();
  }
});

// node_modules/diff/libesm/index.js
var init_libesm = __esm({
  "node_modules/diff/libesm/index.js"() {
    "use strict";
    init_character();
    init_line();
  }
});

// packages/shared/src/text-diff.ts
function commonEdges(a, b) {
  const shortest = Math.min(a.length, b.length);
  let head = 0;
  while (head < shortest && a.charCodeAt(head) === b.charCodeAt(head)) head++;
  if (head > 0 && isHigh(a.charCodeAt(head - 1))) head--;
  let tail = 0;
  while (tail < shortest - head && a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)) tail++;
  if (tail > 0 && isLow(a.charCodeAt(a.length - tail))) tail--;
  return [head, tail];
}
function fromChanges(changes) {
  return changes.map((c) => [c.added ? 1 : c.removed ? -1 : 0, c.value]);
}
function disjoint(a, b) {
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < a.length; i++) seen.add(a.charCodeAt(i));
  for (let i = 0; i < b.length; i++) if (seen.has(b.charCodeAt(i))) return false;
  return true;
}
function hunk(before, after, budget, stats) {
  if (!before || !after) return [replace(before, after), 0];
  const [head, tail] = commonEdges(before, after);
  const a = before.slice(head, before.length - tail), b = after.slice(head, after.length - tail);
  const edges = (middle) => [
    ...head ? [[0, before.slice(0, head)]] : [],
    ...middle,
    ...tail ? [[0, before.slice(before.length - tail)]] : []
  ];
  if (!a || !b) return [edges(replace(a, b)), 0];
  if (a.length >= 128 && b.length >= 128 && disjoint(a, b)) return [edges(replace(a, b)), 0];
  const tokens = a.length + b.length;
  const maxEditLength = editBudget(tokens, budget);
  if (maxEditLength > 0 && stats) stats.charCalls++;
  const changes = maxEditLength > 0 ? diffChars(a, b, { maxEditLength }) : void 0;
  if (!changes) {
    const spent2 = tokens * maxEditLength;
    if (stats) stats.work += spent2;
    return [edges(replace(a, b)), spent2];
  }
  const ops = fromChanges(changes);
  const spent = tokens * ops.filter(([kind]) => kind !== 0).reduce((n, [, v]) => n + v.length, 0);
  if (stats) stats.work += spent;
  return [edges(ops), spent];
}
function boundedTextDiff(before, after, stats) {
  if (before === after) return before ? [[0, before]] : [];
  const [head, tail] = commonEdges(before, after);
  const a = before.slice(head, before.length - tail), b = after.slice(head, after.length - tail);
  const out = head ? [[0, before.slice(0, head)]] : [];
  if (a.length <= SMALL_MIDDLE && b.length <= SMALL_MIDDLE) {
    out.push(...hunk(a, b, SMALL_WORK, stats)[0]);
    if (tail) out.push([0, before.slice(before.length - tail)]);
    return out.filter(([, value2]) => value2.length);
  }
  let budget = WORK;
  const lineCount = (s) => s.split("\n").length;
  const lineTokens = lineCount(a) + lineCount(b);
  const lineEdits = editBudget(lineTokens, budget / 2);
  if (a && b && lineEdits > 0 && stats) {
    stats.lineCalls++;
    stats.work += lineTokens * lineEdits;
  }
  const lines = a && b && lineEdits > 0 ? diffLines(a, b, { maxEditLength: lineEdits }) : void 0;
  budget /= 2;
  if (!lines) out.push(...hunk(a, b, budget, stats)[0]);
  else {
    let removed = "", added = "";
    const flush = () => {
      if (!removed && !added) return;
      const [ops, spent] = hunk(removed, added, budget, stats);
      out.push(...ops);
      budget = Math.max(0, budget - spent);
      removed = added = "";
    };
    for (const change of lines) {
      if (change.removed) removed += change.value;
      else if (change.added) added += change.value;
      else {
        flush();
        out.push([0, change.value]);
      }
    }
    flush();
  }
  if (tail) out.push([0, before.slice(before.length - tail)]);
  return out.filter(([, value2]) => value2.length);
}
var WORK, SMALL_MIDDLE, SMALL_WORK, isHigh, isLow, editBudget, replace;
var init_text_diff = __esm({
  "packages/shared/src/text-diff.ts"() {
    "use strict";
    init_libesm();
    WORK = 2e6;
    SMALL_MIDDLE = 4096;
    SMALL_WORK = 35e4;
    isHigh = (code) => code >= 55296 && code <= 56319;
    isLow = (code) => code >= 56320 && code <= 57343;
    editBudget = (tokens, budget) => Math.floor(budget / Math.max(1, tokens));
    replace = (before, after) => [
      ...before ? [[-1, before]] : [],
      ...after ? [[1, after]] : []
    ];
  }
});

// packages/shared/src/doc.ts
import { randomBytes } from "node:crypto";
function holderFence(holder) {
  return holder && Number.isSafeInteger(holder.epoch) ? String(holder.epoch) : void 0;
}
function participantRecord(room, name) {
  const key = (field) => `${name}\0${field}`;
  const id2 = room.participants.get(key("id"));
  const holder = room.participants.get(key("holder"));
  const git = room.participants.get(key("git"));
  const proj = room.participants.get(key("proj"));
  if (!id2 && !holder && !git && !proj) return void 0;
  return { ...id2 ? { id: id2 } : {}, ...holder ? { holder } : {}, ...git ? { git } : {}, ...proj ? { proj } : {} };
}
function defaultPriority(msg) {
  const kind = MessageKinds[msg.type];
  if (!kind) throw new Error(`unregistered message kind: ${msg.type}`);
  return typeof kind.priority === "function" ? kind.priority(msg) : kind.priority;
}
function lineStart(text2, oneBasedLine) {
  let index = 0;
  for (let line = 1; line < Math.max(1, oneBasedLine); line++) {
    const newline = text2.indexOf("\n", index);
    if (newline < 0) return text2.length;
    index = newline + 1;
  }
  return index;
}
function lineAt(text2, index) {
  let line = 1;
  for (let i = 0; i < Math.min(index, text2.length); i++) if (text2[i] === "\n") line++;
  return line;
}
function makeAnchor(text2, from2, to2) {
  return {
    from: relativePositionToJSON(createRelativePositionFromTypeIndex(text2, lineStart(text2.toString(), from2))),
    to: relativePositionToJSON(createRelativePositionFromTypeIndex(text2, lineStart(text2.toString(), to2)))
  };
}
var validColorIndex, RoomDoc;
var init_doc = __esm({
  "packages/shared/src/doc.ts"() {
    "use strict";
    init_delivery();
    init_worker_memory();
    init_claims();
    init_messages();
    init_text_diff();
    init_yjs();
    init_manifest();
    init_identity();
    init_ledger();
    validColorIndex = (value2) => Number.isInteger(value2) && value2 >= 0 && value2 < PALETTE.length;
    RoomDoc = class {
      doc;
      colorName;
      colorOrigin;
      get graphs() {
        return this.doc.getMap("graphs");
      }
      /** Flat `${name}\0${field}` keys avoid concurrent child-map insertion races. */
      get participants() {
        return this.doc.getMap("participants");
      }
      /** Monotonic absence accumulated by the current trim leader. */
      get expiry() {
        return this.doc.getMap("expiry");
      }
      /** Persistent participant -> palette slot assignments. */
      get colors() {
        return this.doc.getMap("colors");
      }
      /** One writer per incarnation key; the head remains a plain value. */
      get manifest() {
        return this.doc.getMap("manifest");
      }
      get manifestHead() {
        return this.doc.getMap("manifestHead");
      }
      get coordination() {
        return this.doc.getMap("coordination");
      }
      get roomSalt() {
        return this.metaMap.get("roomSalt");
      }
      /** Local/test fallback until room creation owns salt in the schema-2 cutover. */
      ensureRoomSalt() {
        if (!this.roomSalt) this.doc.transact(() => {
          if (!this.roomSalt) this.metaMap.set("roomSalt", randomBytes(32).toString("hex"));
        });
        return this.roomSalt;
      }
      constructor(doc = new Doc()) {
        this.doc = doc;
        this.colors.observe(() => {
          if (this.colorName) this.reconcileColors(this.colorName, this.colorOrigin);
        });
      }
      /** Claim the lowest unused slot, retaining existing slots across reconnects. */
      assignColor(name, origin) {
        this.colorName = name;
        this.colorOrigin = origin;
        if (!this.colors.has(name)) {
          const used = new Set(Array.from(this.colors.values()).filter(validColorIndex));
          const free = Array.from({ length: PALETTE.length }, (_, i) => i).find((i) => !used.has(i));
          this.doc.transact(() => {
            this.colors.set(name, free ?? this.colors.size % PALETTE.length);
          }, origin);
        }
        this.reconcileColors(name, origin);
        return this.colors.get(name);
      }
      /** Lexically first keeps a concurrently claimed slot; a later caller moves only its own slot. */
      reconcileColors(name, origin) {
        const current = this.colors.get(name);
        if (current === void 0) return;
        const entries = [...this.colors.entries()];
        const losesTie = validColorIndex(current) && entries.some(([other, slot]) => other.localeCompare(name) < 0 && slot === current);
        if (validColorIndex(current) && !losesTie) return;
        const used = new Set(entries.flatMap(([other, slot]) => other !== name && validColorIndex(slot) ? [slot] : []));
        const free = Array.from({ length: PALETTE.length }, (_, i) => i).find((i) => !used.has(i));
        if (free !== void 0 && free !== current) this.doc.transact(() => {
          this.colors.set(name, free);
        }, origin);
      }
      get overlays() {
        return this.doc.getMap("overlays");
      }
      /** Evict a stopped participant's overlays and base texts together. The absent owner cannot reconcile them. */
      clearOverlays(person, origin) {
        const incarnations = [...this.overlays.keys()].filter((key) => key === person || key.startsWith(`${person}\0`));
        const paths = new Set(incarnations.flatMap((key) => [...this.overlays.get(key)?.keys() ?? []]));
        this.doc.transact(() => {
          for (const key of incarnations) this.overlays.delete(key);
          this.clearPersonBaseTexts(person);
        }, origin);
        return paths.size;
      }
      /** Decoding only: 0.16 branch-room snapshots can still contain deletion markers. */
      get legacyDeleted() {
        return this.doc.getMap("deleted");
      }
      get scopes() {
        return this.doc.getMap("scopes");
      }
      get claims() {
        return this.doc.getMap("claims");
      }
      get bus() {
        return this.doc.getArray("bus");
      }
      /** Leads' workers as the room shows them, keyed by worker ID (registry §14). Display only; written by each lead's projector. */
      get workerViews() {
        return this.doc.getMap("workerViews");
      }
      /** The newest view under a participant name, for display and remote classification. */
      workerViewOf(name) {
        let found;
        for (const view of this.workerViews.values()) if (view.name === name && (!found || view.startedAt > found.startedAt)) found = view;
        return found;
      }
      /** A view is display evidence only while its lead still holds the writer fence. */
      workerViewCurrent(view) {
        const holder = participantRecord(this, view.lead)?.holder;
        return !!holder && !holder.ended && view.fence === (holderFence(holder) ?? holder.sessionId);
      }
      acceptedWorkerViewOf(name) {
        let found;
        for (const view of this.workerViews.values()) if (view.name === name && this.workerViewCurrent(view) && (!found || view.startedAt > found.startedAt)) found = view;
        return found;
      }
      acceptedWorkerViews() {
        return [...this.workerViews.values()].filter((view) => this.workerViewCurrent(view));
      }
      retiredWorkers() {
        return this.doc.getArray("retiredWorkers").toArray();
      }
      /** Remove coordination from a participant that can no longer act; `post` sends the release notices. */
      clearWorkerCoordination(name, reason, post) {
        this.doc.transact(() => {
          for (const claim of this.claims.values()) if (claim.by === name) {
            this.claims.delete(claim.id);
            post({ name, kind: claim.byKind }, { type: "release", claimId: claim.id, path: claim.path, summary: reason });
          }
          this.clearOverlays(name);
          this.scopes.delete(name);
          this.graphs.delete(name);
        });
      }
      /**
       * Whether the live state under `name` is worker `id`'s: its holder names `id`, a team projection's
       * `projectedFrom` does, or, with neither, no other worker's view holds the name. A newer worker or a
       * standalone participant under the same name never is.
       */
      workerOwnsName(id2, name) {
        const record = participantRecord(this, name);
        return record?.holder ? record.holder.workerId === id2 : record?.proj ? record.proj.projectedFrom === id2 : ![...this.workerViews.values()].some((view) => view.name === name && view.id !== id2);
      }
      /**
       * Retirement keyed by worker ID (registry §12), one compare-and-delete transaction run by the projector of
       * this room. The live state under the worker's name (claims, scope, manifest and text, graph, colour,
       * receipts, participant keys) goes only while `workerOwnsName`. The view goes and the archive gains one entry per ID.
       */
      retireWorker(id2, archived, post) {
        if (archived.id !== id2) throw new Error("retirement id does not match record");
        const name = archived.name;
        this.doc.transact(() => {
          const cached = this.doc.getMap("completedPublications");
          for (const [key, value2] of cached) if (value2.worker.id === id2) cached.delete(key);
          if (this.workerOwnsName(id2, name)) {
            this.clearWorkerCoordination(name, "retired", post);
            const conflicts = this.doc.getMap("conflicts");
            for (const [key, slot] of conflicts) if (slot.owner === name) conflicts.delete(key);
            this.manifestHead.delete(name);
            for (const key of [...this.manifest.keys()]) if (key.startsWith(`${name}\0`)) this.manifest.delete(key);
            for (const key of [...this.overlays.keys()]) if (key.startsWith(`${name}\0`)) this.overlays.delete(key);
            for (const key of [...this.participants.keys()]) if (key.startsWith(`${name}\0`)) this.participants.delete(key);
            this.colors.delete(name);
            this.seen(name).clear();
          }
          this.workerViews.delete(id2);
          const archive = this.doc.getArray("retiredWorkers");
          if (!archive.toArray().some((r) => r.id === id2)) {
            archive.push([compactRetiredWorker(archived)]);
            if (archive.length > MAX_RETIRED_WORKERS) archive.delete(0, archive.length - MAX_RETIRED_WORKERS);
          }
        });
      }
      get metaMap() {
        return this.doc.getMap("meta");
      }
      /** Flat keys merge even when two sessions first publish under the same participant tag. */
      get ownedBaseTexts() {
        return this.doc.getMap("basetextFlat");
      }
      baseTextKey(person, sha, relpath) {
        return `${person}\0${sha}:${relpath}`;
      }
      baseTextPrefix(person) {
        return `${person}\0`;
      }
      isPersonBaseTextKey(key, person) {
        return key.startsWith(this.baseTextPrefix(person)) && !key.slice(person.length + 1).includes("\0");
      }
      baseText(person, sha, relpath) {
        const head = this.manifestHead.get(person);
        if (head && !publicationRevisionCurrent(this.doc, person, head)) return void 0;
        const live = this.ownedBaseTexts.get(this.baseTextKey(person, sha, relpath));
        if (live !== void 0) return live;
        const retained = retainedPublication(this, person);
        return retained?.head.base === sha ? retained.baseTexts.find(([path12]) => path12 === relpath)?.[1] : void 0;
      }
      /** Remove only this participant's entries that no longer back their live work. */
      reconcileBaseTexts(person, origin, baseSha) {
        const head = this.manifestHead.get(person);
        const base = baseSha ?? head?.base;
        const current = head ? this.manifest.get(manifestKey(person, head.fence)) : void 0;
        const wanted = new Set([...current?.entries() ?? []].filter(([, entry]) => entry.fence === head?.fence && entry.held !== "scope").map(([path12]) => `${base}:${path12}`));
        this.doc.transact(() => {
          const prefix2 = this.baseTextPrefix(person);
          for (const key of this.ownedBaseTexts.keys()) {
            if (this.isPersonBaseTextKey(key, person) && !wanted.has(key.slice(prefix2.length))) this.ownedBaseTexts.delete(key);
          }
        }, origin);
      }
      /** Only eviction/retirement may remove another participant's entries: that owner has stopped. */
      clearPersonBaseTexts(person) {
        for (const key of this.ownedBaseTexts.keys()) if (this.isPersonBaseTextKey(key, person)) this.ownedBaseTexts.delete(key);
      }
      setBaseText(person, sha, relpath, text2, origin) {
        const key = this.baseTextKey(person, sha, relpath);
        if (this.ownedBaseTexts.get(key) === text2) return;
        this.doc.transact(() => {
          this.ownedBaseTexts.set(key, text2);
        }, origin);
      }
      // ---- overlays ----------------------------------------------------------
      overlay(person) {
        let map = this.overlays.get(person);
        if (!map) {
          map = new YMap();
          this.overlays.set(person, map);
        }
        return map;
      }
      overlayText(person, relpath) {
        return this.overlays.get(person)?.get(relpath);
      }
      /** Compute bounded edits ahead of a larger atomic publication transaction. */
      prepareOverlayDiff(person, relpath, content, stats) {
        const before = this.overlayText(person, relpath)?.toString() ?? "";
        return { before, ops: boundedTextDiff(before, content, stats) };
      }
      /** Apply bounded character-level diff operations, preserving Yjs relative positions. */
      setOverlay(person, relpath, content, origin, prepared) {
        const existing = this.overlayText(person, relpath);
        const previous = existing?.toString() ?? "";
        if (existing && previous === content) return;
        this.doc.transact(() => {
          let text2 = this.overlayText(person, relpath);
          if (!text2) {
            text2 = new YText();
            this.overlay(person).set(relpath, text2);
          }
          let index = 0;
          const before = text2 === existing ? previous : text2.toString();
          for (const [kind, value2] of prepared?.before === before ? prepared.ops : boundedTextDiff(before, content)) {
            if (kind === 0) index += value2.length;
            else if (kind === -1) text2.delete(index, value2.length);
            else {
              text2.insert(index, value2);
              index += value2.length;
            }
          }
        }, origin);
      }
      /** Publisher-only apply of an overlay diff prepared against its fenced incarnation. */
      applyPreparedOverlayDiff(person, relpath, prepared, origin) {
        this.doc.transact(() => {
          let text2 = this.overlayText(person, relpath);
          if (!text2) {
            text2 = new YText();
            this.overlay(person).set(relpath, text2);
          }
          let index = 0;
          for (const [kind, value2] of prepared.ops) {
            if (kind === 0) index += value2.length;
            else if (kind === -1) text2.delete(index, value2.length);
            else {
              text2.insert(index, value2);
              index += value2.length;
            }
          }
        }, origin);
      }
      clearOverlay(person, relpath, origin) {
        const map = this.overlays.get(person);
        if (!map?.has(relpath)) return;
        this.doc.transact(() => {
          map.delete(relpath);
        }, origin);
      }
      scope(person) {
        return this.scopes.get(person);
      }
      allScopes() {
        return Array.from(this.scopes.values()).sort((a, b) => a.at - b.at);
      }
      ledger(q = {}) {
        return ledger(this.messages(), this.allScopes(), q);
      }
      areaSummary(windowMs) {
        return areaSummary(this.messages(), this.allScopes(), windowMs);
      }
      setScope(personOrScope, scopeOrOrigin, origin) {
        const value2 = typeof personOrScope === "string" ? { ...scopeOrOrigin, by: personOrScope, at: scopeOrOrigin.at ?? Date.now() } : { ...personOrScope, at: personOrScope.at ?? Date.now() };
        const transactionOrigin = typeof personOrScope === "string" ? origin : scopeOrOrigin;
        this.doc.transact(() => {
          this.scopes.set(value2.by, value2);
        }, transactionOrigin);
        return value2;
      }
      clearScope(person, origin) {
        const scope = this.scopes.get(person);
        if (scope) this.doc.transact(() => {
          this.scopes.delete(person);
        }, origin);
        return scope;
      }
      text(relpath, person) {
        return person ? this.overlayText(person, relpath)?.toString() : void 0;
      }
      lineCount(relpath, person) {
        const text2 = this.text(relpath, person);
        if (text2 === void 0) return 0;
        const count = text2.split("\n").length;
        return text2.endsWith("\n") ? count - 1 : count;
      }
      // ---- meta --------------------------------------------------------------
      get meta() {
        const map = this.metaMap;
        return {
          repo: map.get("repo"),
          createdAt: map.get("createdAt"),
          seededBy: map.get("seededBy"),
          schemaVersion: map.get("schemaVersion"),
          roomSalt: map.get("roomSalt")
        };
      }
      setMeta(patch, origin) {
        this.doc.transact(() => {
          for (const [key, value2] of Object.entries(patch)) {
            if (value2 !== void 0) this.metaMap.set(key, value2);
          }
        }, origin);
      }
      // ---- claims ------------------------------------------------------------
      openClaims() {
        return Array.from(this.claims.values()).map((claim) => ({ ...claim, ...this.claimRange(claim) })).sort((a, b) => a.at - b.at);
      }
      claimsFor(relpath) {
        return this.openClaims().filter((claim) => claimsOverlap(claim, { path: relpath, from: 1, to: Number.MAX_SAFE_INTEGER }));
      }
      /** Everyone who was shown a message: recipients of routed copies plus agents with a read receipt for it or its copies. */
      dependentsOf(msgId) {
        const out = new Set(this.seenBy(msgId));
        for (const m of this.messages()) if (m.copyOf === msgId) {
          if (m.to) out.add(m.to);
          for (const p of this.seenBy(m.id)) out.add(p);
        }
        return Array.from(out).sort();
      }
      setClaimMsg(claimId, msgId, origin) {
        const c = this.claims.get(claimId);
        if (c) this.doc.transact(() => {
          this.claims.set(claimId, { ...c, msgId });
        }, origin);
      }
      addClaim(input, origin) {
        const text2 = this.overlayText(input.by, input.path);
        const anchor = text2 && !input.mirrorOf ? makeAnchor(text2, input.from, input.to) : void 0;
        const claim = { ...input, id: newId("c_"), at: Date.now(), ...anchor ? { anchor } : {} };
        this.doc.transact(() => {
          this.claims.set(claim.id, claim);
        }, origin);
        return claim;
      }
      claimRange(claim) {
        if (claim.mirrorOf) return { from: claim.from, to: claim.to };
        const text2 = this.overlayText(claim.by, claim.path);
        if (!text2 || !claim.anchor) return { from: claim.from, to: claim.to };
        try {
          const from2 = createAbsolutePositionFromRelativePosition(
            createRelativePositionFromJSON(claim.anchor.from),
            this.doc
          );
          const to2 = createAbsolutePositionFromRelativePosition(
            createRelativePositionFromJSON(claim.anchor.to),
            this.doc
          );
          if (!from2 || !to2 || from2.type !== text2 || to2.type !== text2) return { from: claim.from, to: claim.to };
          const fromLine = lineAt(text2.toString(), from2.index);
          const toLine = lineAt(text2.toString(), to2.index);
          return { from: fromLine, to: Math.max(fromLine, toLine) };
        } catch {
          return { from: claim.from, to: claim.to };
        }
      }
      removeClaim(id2, origin) {
        const claim = this.claims.get(id2);
        if (claim) this.doc.transact(() => {
          this.claims.delete(id2);
        }, origin);
        return claim;
      }
      /** Replace a claim's line range and any obsolete overlay anchor after HEAD changes. */
      moveClaim(id2, from2, to2, origin, claimedHash) {
        const claim = this.claims.get(id2);
        if (!claim) return void 0;
        const text2 = this.overlayText(claim.by, claim.path);
        const { anchor: _oldAnchor, claimedHash: _oldHash, ...rest } = claim;
        const next = { ...rest, from: from2, to: to2, ...claimedHash !== void 0 ? { claimedHash } : {}, ...text2 && !claim.mirrorOf ? { anchor: makeAnchor(text2, from2, to2) } : {} };
        this.doc.transact(() => {
          this.claims.set(id2, next);
        }, origin);
        return next;
      }
      // ---- bus ---------------------------------------------------------------
      messages() {
        return this.bus.toArray();
      }
      /** Addressed messages that left the bus while owed or answerable; written by the trim (delivery.ts). */
      get mail() {
        return this.doc.getMap("mail");
      }
      /** Terminal outcomes of addressed messages that were never receipted. */
      get outcomes() {
        return this.doc.getMap("outcomes");
      }
      /** Compact records of every message the trim removed from the bus. */
      get archive() {
        return this.doc.getMap("archive");
      }
      /** A message on the bus, else in mail. */
      message(id2) {
        return deliveryIndex(this).bus.first(id2) ?? this.mail.get(id2);
      }
      lastMessages(n) {
        const messages = this.messages();
        return messages.slice(Math.max(0, messages.length - n));
      }
      // ---- read receipts ------------------------------------------------------
      /** `seen:<P>`: message ids P's agent was handed, after a confirmed handoff (ledger R2). Legacy receipts are a number. */
      seen(name) {
        return this.doc.getMap(`seen:${encodeURIComponent(name)}`);
      }
      /** Receipts for a confirmed handoff to session `s` by `via`. */
      markSeen(name, ids, receipt, origin) {
        if (!ids.length) return;
        const value2 = { ...receipt, at: Date.now() };
        this.doc.transact(() => {
          const m = this.seen(name);
          for (const id2 of ids) if (!m.has(id2)) m.set(id2, value2);
        }, origin);
      }
      /** Remove orphaned receipts only while this writer still holds its authority fence. */
      pruneSeen(name, current) {
        if (!current()) return;
        this.doc.transact(() => {
          if (!current()) return;
          const refs = /* @__PURE__ */ new Set([...this.messages().map((m) => m.id), ...this.mail.keys(), ...this.outcomes.keys()]);
          const seen = this.seen(name);
          for (const id2 of seen.keys()) if (!refs.has(id2)) seen.delete(id2);
        });
      }
      seenBy(msgId) {
        const out = [];
        for (const key of this.doc.share.keys()) if (key.startsWith("seen:") && this.doc.getMap(key).has(msgId)) out.push(decodeURIComponent(key.slice(5)));
        return out.sort();
      }
      // ---- chats (human <-> own agent) --------------------------------------
      chat(name) {
        return this.doc.getArray(`chat:${encodeURIComponent(name)}`);
      }
      say(name, item, origin) {
        const value2 = { ...item, id: newId("h_"), at: Date.now() };
        this.doc.transact(() => {
          this.chat(name).push([value2]);
        }, origin);
        return value2;
      }
    };
  }
});

// packages/shared/src/views.ts
var ROOM_STALE_MS, STALE_WORKER_MS;
var init_views = __esm({
  "packages/shared/src/views.ts"() {
    "use strict";
    init_claims();
    init_worker_memory();
    init_identity();
    init_doc();
    init_types();
    ROOM_STALE_MS = 7 * 24 * 60 * 60 * 1e3;
    STALE_WORKER_MS = 60 * 60 * 1e3;
  }
});

// packages/shared/src/manifest.ts
function manifestKey(name, fence) {
  return `${name}\0${fence}`;
}
var init_manifest = __esm({
  "packages/shared/src/manifest.ts"() {
    "use strict";
    init_doc();
    init_views();
    init_worker_memory();
  }
});

// packages/shared/src/near.ts
function normalizeCoordinationPath(p) {
  const parts = [];
  for (const part of p.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/") || ".";
}
function containsPath(parent, child) {
  const valid = (p) => p.trim().length > 0 && !/^(?:[\\/]|[a-z]:)/i.test(p) && (normalizeCoordinationPath(p) !== "." || p === "." || p === "./");
  if (!valid(parent) || !valid(child)) return false;
  const a = normalizeCoordinationPath(parent), b = normalizeCoordinationPath(child);
  return a === "." || a === b || b.startsWith(a + "/");
}
var init_near = __esm({
  "packages/shared/src/near.ts"() {
    "use strict";
    init_identity();
    init_manifest();
  }
});

// packages/shared/src/messages.ts
function validMessageShape(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2)) return false;
  const m = value2;
  const str = (key, required = true) => m[key] === void 0 ? !required : typeof m[key] === "string" && m[key].length <= 64 * 1024;
  const arr = (key, required = true) => m[key] === void 0 ? !required : Array.isArray(m[key]) && m[key].every((x) => typeof x === "string" && x.length <= 4096);
  const num = (key) => Number.isSafeInteger(m[key]) && m[key] >= 0;
  const plan = (p) => !!p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).every((k) => ["kind", "symbol", "detail"].includes(k)) && ["rename", "signature", "delete", "add"].includes(p.kind) && typeof p.symbol === "string" && p.symbol.length <= 512 && (p.detail === void 0 || typeof p.detail === "string" && p.detail.length <= 4096);
  const plans = (key) => m[key] === void 0 || Array.isArray(m[key]) && m[key].every(plan);
  if (!str("id") || !str("from") || !str("to", false) || !str("copyOf", false) || typeof m.type !== "string" || !Object.hasOwn(MessageKinds, m.type)) return false;
  if (m.priority !== void 0 && !["fyi", "notify", "interrupt"].includes(m.priority)) return false;
  if (m.fromKind !== void 0 && !["human", "agent", "bot", "ci"].includes(m.fromKind)) return false;
  if (m.at !== void 0 && !num("at")) return false;
  if (m.seq !== void 0 && !num("seq")) return false;
  const common = ["id", "type", "from", "fromKind", "to", "priority", "at", "seq", "copyOf"];
  const fields = {
    claim: ["claimId", "path", "from_line", "to_line", "intent", "plans"],
    release: ["claimId", "path", "summary", "unfulfilled"],
    changed: ["paths", "summary", "symbols"],
    question: ["text"],
    note: ["text", "inReplyTo"],
    answer: ["inReplyTo", "text"],
    conflict: ["claimId", "otherClaimId", "path", "text", "clearedFrom", "merges"],
    "merge-conflict": ["path", "text", "clearedFrom"],
    contract: ["path", "symbol", "text"],
    scope: ["area", "summary", "paths"],
    base: ["base", "prev", "commits", "paths", "summary"],
    pushed: ["branch", "upstream", "fromSha", "toSha", "commits", "paths", "summary", "rewrite"],
    plan: ["status", "claimId", "path", "plan", "replacedBy", "text"],
    done: ["tag", "summary", "changed"]
  };
  if (!fields[m.type] || Object.keys(m).some((k) => !common.includes(k) && !fields[m.type].includes(k))) return false;
  switch (m.type) {
    case "claim":
      return str("claimId") && str("path") && num("from_line") && num("to_line") && str("intent") && plans("plans");
    case "release":
      return str("claimId") && str("path") && str("summary", false) && plans("unfulfilled");
    case "changed":
      return arr("paths") && str("summary") && arr("symbols", false);
    case "question":
    case "note":
      return str("text") && str("inReplyTo", false);
    case "answer":
      return str("inReplyTo") && str("text");
    case "conflict":
      return str("claimId") && str("otherClaimId") && str("path") && str("text") && (m.clearedFrom === void 0 || ["conflict", "possible"].includes(m.clearedFrom)) && (m.merges === void 0 || m.merges === "clean");
    case "merge-conflict":
      return str("path") && str("text") && (m.clearedFrom === void 0 || ["conflict", "possible"].includes(m.clearedFrom));
    case "contract":
      return str("path") && str("symbol") && str("text");
    case "scope":
      return str("area") && str("summary") && arr("paths");
    case "base":
      return str("base") && str("prev") && num("commits") && arr("paths") && str("summary");
    case "pushed":
      return str("branch") && str("upstream") && str("fromSha") && str("toSha") && num("commits") && arr("paths") && str("summary") && (m.rewrite === void 0 || ["yes", "unknown"].includes(m.rewrite));
    case "plan":
      return ["cancelled", "superseded"].includes(m.status) && str("claimId") && str("path") && plan(m.plan) && (m.replacedBy === void 0 || plan(m.replacedBy)) && str("text");
    case "done":
      return str("tag") && str("summary") && arr("changed");
    default:
      return false;
  }
}
function isRoomNotice(m) {
  return m.from === "room" && m.fromKind === "bot";
}
function isLegacyBranchNotice(m) {
  return m.type === "note" && m.fromKind === "bot" && (m.from === "room" || /^\?[0-9a-f]{16}$/.test(m.from)) && typeof m.text === "string" && /^you switched to \S+; the room is for \S+;/.test(m.text);
}
function messageKind(m) {
  const kind = MessageKinds[m.type];
  if (!kind) throw new Error(`unregistered message kind: ${m.type}`);
  return kind;
}
function holdsClaim(me, m, claims) {
  const ids = "claimId" in m ? [m.claimId, ..."otherClaimId" in m ? [m.otherClaimId] : []] : [];
  if (claims.some((c) => c.by === me && ids.includes(c.id))) return true;
  return "path" in m && claims.some((c) => c.by === me && isAgentic(c.byKind) && claimsOverlap(c, { path: m.path, from: 1, to: Number.MAX_SAFE_INTEGER }));
}
function messageForMe(me, m, context = {}) {
  if (m.type === "note" && !m.to && (m.from === me.name || m.priority === "fyi")) return false;
  if (m.from === me.name && m.fromKind !== "human") return false;
  if (m.type === "plan" && m.priority === "fyi") return false;
  if (m.to === me.name) return true;
  if (m.to) return false;
  const kind = messageKind(m);
  if (m.priority === "interrupt") return true;
  if (kind.inbox === false) return false;
  if (kind.audience === "everyone") return true;
  if (kind.audience === "addressed") return false;
  if (kind.audience === "claim-holders" && !holdsClaim(me.name, m, context.claims ?? [])) return false;
  if (m.priority === "notify") return context.inMyAreas?.(m) ?? false;
  return false;
}
function formatPlans(plans) {
  return plans.map((p) => `${p.kind} ${p.symbol}${p.detail ? ` \u2192 ${p.detail}` : ""}`).join("; ");
}
var who, to, priority, conflictLabel, PEER_NOTICE_TEXT, scopePaths, BASE_CATCH_UP, builtins, MessageKinds;
var init_messages = __esm({
  "packages/shared/src/messages.ts"() {
    "use strict";
    init_claims();
    init_identity();
    init_near();
    who = (m) => displayName({ name: m.from, kind: m.fromKind });
    to = (m) => m.to ? ` \u2192 ${displayName({ name: m.to, kind: "agent" })}` : "";
    priority = (m) => `[${m.priority}] `;
    conflictLabel = (m) => m.clearedFrom === "possible" ? "POSSIBLE conflict cleared" : m.clearedFrom === "conflict" ? m.merges === "clean" ? "overlap cleared" : "CONFLICT cleared" : m.merges === "clean" ? "overlap" : m.priority !== "fyi" ? "CONFLICT" : "POSSIBLE conflict";
    PEER_NOTICE_TEXT = /^\d+ files? (?:conflicts?|no longer conflict) with /;
    scopePaths = (paths) => [...new Set(paths.map(normalizeCoordinationPath))].sort().join("\0");
    BASE_CATCH_UP = "Run git pull --ff-only --autostash to catch up. If it refuses, or your push is rejected, stop and tell your human; never merge another branch into this one, and do not undo, rebase or recommit your commits to get past it without their yes.";
    builtins = {
      claim: { priority: "fyi", audience: "claim-holders", inbox: false, wakes: "never", format: (m, context) => context?.claims && !context.claims.some((c) => c.id === m.claimId) ? `${priority(m)}earlier: ${who(m)} claimed ${m.path}:${m.from_line}-${m.to_line} (${new Date(m.at).toISOString().slice(11, 19)}) \u2014 ${m.intent}` : `${priority(m)}${who(m)} claims ${m.path}:${m.from_line}-${m.to_line} \u2014 ${m.intent}${m.plans?.length ? ` (plans: ${formatPlans(m.plans)})` : ""}` },
      release: { priority: "fyi", audience: "everyone", inbox: false, wakes: "never", format: (m) => `${priority(m)}${who(m)} released ${m.path}${m.summary ? ` \u2014 ${m.summary}` : ""}${m.unfulfilled?.length ? ` (not done: ${formatPlans(m.unfulfilled)})` : ""}` },
      changed: { priority: (m) => m.symbols?.length ? "notify" : "fyi", audience: "everyone", inbox: false, wakes: "addressed", format: (m) => `${priority(m)}${who(m)} changed ${m.paths.join(", ")} \u2014 ${m.summary}${m.symbols?.length ? ` (${m.symbols.join(", ")})` : ""}` },
      question: { priority: "notify", audience: "addressed", wakes: "addressed", endsWait: (m, w) => !w.answersOnly && m.to === w.me && (w.workersRoom || !w.claimId && !w.questionId), format: (m) => `${priority(m)}${who(m)}${to(m)} asks: ${m.text}` },
      answer: { priority: "notify", audience: "addressed", wakes: "addressed", endsWait: (m, w) => !!w.questionId && m.inReplyTo === w.questionId && m.to === w.me, format: (m) => `${priority(m)}${who(m)}${to(m)} answers: ${m.text}` },
      // A certified clean overlap needs coordination, but is not a reason to interrupt an edit.
      conflict: { priority: (m) => m.merges === "clean" ? "notify" : "interrupt", audience: "claim-holders", wakes: "always", format: (m) => `${priority(m)}${conflictLabel(m)} on ${m.path}: ${m.text}` },
      "merge-conflict": { priority: "notify", audience: "addressed", inbox: true, wakes: "addressed", endsWait: (m, w) => !w.answersOnly && m.to === w.me, format: (m) => PEER_NOTICE_TEXT.test(m.text) ? `${priority(m)}${m.clearedFrom ? "CONFLICT cleared" : "CONFLICT"}: ${m.text}` : `${priority(m)}${conflictLabel(m)} on ${m.path}: ${m.text}` },
      contract: { priority: "notify", audience: "addressed", inbox: true, wakes: "always", format: (m) => `${priority(m)}CONTRACT on ${m.path}: ${m.text}` },
      note: { priority: (m) => m.to ? "notify" : "fyi", audience: "everyone", inbox: true, wakes: (m, ctx) => m.to === ctx.me.name, endsWait: (m, w) => !w.answersOnly && (m.to === w.me || !m.to && m.priority === "interrupt" && !!w.me && messageForMe({ name: w.me }, m)), format: (m) => `${priority(m)}${who(m)}${to(m)}: ${m.text}` },
      done: { priority: "fyi", audience: "addressed", wakes: "addressed", endsWait: (m, w) => !w.answersOnly && m.to === w.me, format: (m) => `${priority(m)}${who(m)} (worker ${m.tag}) finished: ${m.summary}${m.changed.length ? ` \u2014 changed ${m.changed.join(", ")}` : ""}` },
      base: { priority: "fyi", audience: "everyone", wakes: "never", format: (m) => `${priority(m)}${who(m)} moved the base to ${m.base.slice(0, 10)} (+${m.commits} commit${m.commits === 1 ? "" : "s"}: ${m.summary}) \u2014 ${BASE_CATCH_UP}` },
      pushed: { priority: "notify", audience: "everyone", wakes: (m, ctx) => m.from !== ctx.me.name && ctx.hasUncommitted, format: (m) => m.rewrite === "yes" ? `${priority(m)}${who(m)} rewrote ${m.branch} (force-push): ${m.fromSha.slice(0, 7)} was replaced by ${m.toSha.slice(0, 7)}; git pull --ff-only will refuse. If you have no local commits on it: git fetch && git reset --keep ${m.upstream}; if you do: git rebase --onto ${m.upstream} ${m.fromSha.slice(0, 7)} \u2014 ask your human first.` : m.rewrite === "unknown" ? `${priority(m)}${who(m)}: the branch moved from ${m.fromSha.slice(0, 7)} to ${m.toSha.slice(0, 7)} (history may have been rewritten)` : `${priority(m)}${m.from}'s local commits ${m.fromSha.slice(0, 7)}..${m.toSha.slice(0, 7)} are now on ${m.upstream} (${m.commits} commit${m.commits === 1 ? "" : "s"}: ${m.summary}) \u2014 if you work on ${m.upstream}: ${BASE_CATCH_UP}` },
      plan: { priority: "fyi", audience: "broadcast", wakes: "interrupt", format: (m) => `${priority(m)}${who(m)} ${m.status} plan ${formatPlans([m.plan])} in ${m.path}${m.replacedBy ? ` \u2192 now ${formatPlans([m.replacedBy])}` : ""}${m.text ? ` \u2014 ${m.text}` : ""}` },
      scope: { priority: "notify", audience: "everyone", inbox: false, wakes: "never", format: (m, context) => {
        const current = context?.scopes.some((s) => s.by === m.from && s.area === m.area && s.summary === m.summary && scopePaths(s.paths) === scopePaths(m.paths)) && context.messages.filter((x) => x.type === "scope" && x.from === m.from && x.area === m.area && x.summary === m.summary && scopePaths(x.paths) === scopePaths(m.paths)).at(-1)?.id === m.id;
        return current ? `${priority(m)}${who(m)} is on ${m.area}: ${m.summary} (${m.paths.join(", ")})` : `${priority(m)}earlier: ${who(m)} was on ${m.area} (${new Date(m.at).toISOString().slice(11, 19)}): ${m.summary} (${m.paths.join(", ")})`;
      } }
    };
    MessageKinds = builtins;
  }
});

// packages/shared/src/format.ts
var init_format = __esm({
  "packages/shared/src/format.ts"() {
    "use strict";
    init_messages();
  }
});

// packages/shared/src/claims.ts
function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  return aFrom <= bTo && bFrom <= aTo;
}
function claimsOverlap(a, b) {
  if (/[\\/]$/.test(a.path) && containsPath(a.path, b.path)) return true;
  if (/[\\/]$/.test(b.path) && containsPath(b.path, a.path)) return true;
  return normalizeCoordinationPath(a.path) === normalizeCoordinationPath(b.path) && rangesOverlap(a.from, a.to, b.from, b.to);
}
var init_claims = __esm({
  "packages/shared/src/claims.ts"() {
    "use strict";
    init_identity();
    init_format();
    init_near();
  }
});

// packages/shared/src/manifest-node.ts
var init_manifest_node = __esm({
  "packages/shared/src/manifest-node.ts"() {
    "use strict";
    init_near();
  }
});

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length2) {
      for (let i = 0; i < length2; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = __require("bufferutil");
        module.exports.mask = function(source, mask, output, offset, length2) {
          if (length2 < 48) _mask(source, mask, output, offset, length2);
          else bufferUtil.mask(source, mask, output, offset, length2);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params2 = {};
        if (this._options.serverNoContextTakeover) {
          params2.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params2.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params2.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params2.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params2.client_max_window_bits = true;
        }
        return params2;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params2) => {
          if (opts.serverNoContextTakeover === false && params2.server_no_context_takeover || params2.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params2.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params2.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params2.client_max_window_bits : !params2.client_max_window_bits)) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params2 = response[0];
        if (this._options.clientNoContextTakeover === false && params2.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params2.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params2.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params2.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params2;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params2) => {
          Object.keys(params2).forEach((key) => {
            let value2 = params2[key];
            if (value2.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value2 = value2[0];
            if (key === "client_max_window_bits") {
              if (value2 !== true) {
                const num = +value2;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value2}`
                  );
                }
                value2 = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value2}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value2;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value2}`
                );
              }
              value2 = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value2 !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value2}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params2[key] = value2;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value2) {
      return hasBlob && typeof value2 === "object" && typeof value2.arrayBuffer === "function" && typeof value2.type === "string" && typeof value2.stream === "function" && (value2[Symbol.toStringTag] === "Blob" || value2[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix2, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix2 ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var {
      types: { isUint8Array }
    } = __require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length2 = Buffer.byteLength(data);
          if (length2 > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length2);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params2 = this._queue.shift();
          this._bufferedBytes -= params2[3][kByteLength];
          Reflect.apply(params2[0], this, params2.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params2) {
        this._bufferedBytes += params2[3][kByteLength];
        this._queue.push(params2);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params2 = sender._queue[i];
        const callback = params2[params2.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params2 = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params2);
              params2 = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params2, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params2);
              params2 = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value2 = header.slice(start, end);
            if (mustUnescape) {
              value2 = value2.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params2, paramName, value2);
            if (code === 44) {
              push(offers, extensionName, params2);
              params2 = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params2);
      } else {
        if (paramName === void 0) {
          push(params2, token, true);
        } else if (mustUnescape) {
          push(params2, paramName, token.replace(/\\/g, ""));
        } else {
          push(params2, paramName, token);
        }
        push(offers, extensionName, params2);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params2) => {
          return [extension2].concat(
            Object.keys(params2).map((k) => {
              let values = params2[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http3 = __require("http");
    var net = __require("net");
    var tls = __require("tls");
    var { randomBytes: randomBytes2, createHash: createHash3 } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL: URL2 } = __require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener: addEventListener2, removeEventListener: removeEventListener2 }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener2;
    WebSocket2.prototype.removeEventListener = removeEventListener2;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes2(16).toString("base64");
      const request = isSecure ? https.request : http3.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value2] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value2;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location2 = res.headers.location;
        const statusCode = res.statusCode;
        if (location2 && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location2, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location2}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash3("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length2 = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length2;
        else websocket._bufferedAmount += length2;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http3 = __require("http");
    var { Duplex } = __require("stream");
    var { createHash: createHash3 } = __require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http3.createServer((req, res) => {
            const body = http3.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash3("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params2 = extensions[PerMessageDeflate2.extensionName].params;
          const value2 = extension2.format({
            [PerMessageDeflate2.extensionName]: [params2]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value2}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http3.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http3.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// packages/relay/src/daemon-bin.ts
import fs10 from "node:fs";
import path11 from "node:path";

// packages/relay/src/daemon.ts
import fs9 from "node:fs";
import path10 from "node:path";
import crypto6 from "node:crypto";

// packages/hub-core/src/protocol.ts
init_encoding();
init_decoding();

// packages/hub-core/src/negotiation.ts
var COMPAT_BOOTSTRAP = 1;
var COMPAT_MAX_BYTES = 1024;
var BOOTSTRAP_MAX_BYTES = 8192;
var BOOTSTRAP_SESSION_ID_MAX_LENGTH = 128;
var BOOTSTRAP_HELLO_TIMEOUT_MS = 5e3;
var BOOTSTRAP_ACK_TIMEOUT_MS = 5e3;
var BOOTSTRAP_MAX_PENDING_PER_PRINCIPAL = 8;
var BOOTSTRAP_MAX_BUFFERED_BYTES = 1024 * 1024;
var MAX_CONTRACT_VERSION = 65535;
function freeze(value2) {
  if (value2 && typeof value2 === "object") {
    for (const child of Object.values(value2)) freeze(child);
    Object.freeze(value2);
  }
  return value2;
}
var CAPABILITY_REGISTRY = freeze({
  "room.generation": { scope: "connection", wire: "schema/gen query and 4403/4409 fencing", documentEffects: "meta.generation identifies a replica epoch", versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
  "room.manifest": { scope: "room", wire: "schema-2 manifest records", documentEffects: "baseline per-participant manifests and sharing revisions", versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
  "room.ledger": { scope: "room", wire: "proto-1 ordered post and baseline event vocabulary", documentEffects: "schema-2 bus, mail, archive, outcomes and receipts; no stronger durability", versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
  "room.daemon": { scope: "connection", wire: "negotiated standalone local transport; no in-session takeover", documentEffects: "client retains its replica across involuntary transport rebinding; delayed snapshot durability unchanged", versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
  "room.worker-handover": { scope: "participant", wire: "reserved; not implemented", documentEffects: "reserved; grants no worker lifecycle guarantee", versions: {} }
});
function baseline() {
  return { bootstrap: 1, hub: { min: 1, max: 1 }, schemas: { read: [2], write: [2] }, capabilities: { "room.generation": [1], "room.manifest": [1], "room.ledger": [1] }, legacy: { schema: 2, hub: 1 } };
}
var LEGACY_COMPAT = freeze(baseline());
var CURRENT_COMPAT = freeze(baseline());
var CompatibilityValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "CompatibilityValidationError";
  }
};
function invalid(message) {
  throw new CompatibilityValidationError(message);
}
function object(value2, label) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2)) invalid(`${label} must be an object`);
  return value2;
}
function keys(value2, allowed, label) {
  if (Object.keys(value2).some((key) => !allowed.includes(key))) invalid(`${label} has unknown fields`);
}
function integer(value2) {
  return Number.isSafeInteger(value2) && value2 > 0 && value2 <= MAX_CONTRACT_VERSION;
}
function versions(value2, label, allowEmpty = false) {
  if (!Array.isArray(value2) || value2.length > 8 || !allowEmpty && !value2.length || !value2.every(integer) || new Set(value2).size !== value2.length) invalid(`${label} must be an explicit set of at most eight positive versions`);
  return [...value2].sort((a, b) => a - b);
}
function range(value2, label) {
  const r = object(value2, label);
  keys(r, ["min", "max"], label);
  if (!integer(r.min) || !integer(r.max) || r.min > r.max) invalid(`${label} must be a bounded inclusive version range`);
  return { min: r.min, max: r.max };
}
function capabilities(value2, label) {
  const caps = object(value2, label), entries = Object.entries(caps);
  if (entries.length > 32) invalid(`${label} has more than 32 names`);
  const result = {};
  for (const [name, set] of entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (name.length > 64 || !/^[a-zA-Z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+$/.test(name)) invalid(`${label} has an invalid namespaced ASCII name`);
    Object.defineProperty(result, name, { value: versions(set, `${label}.${name}`), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function bounded(value2, max2, label) {
  let json;
  try {
    json = JSON.stringify(value2);
  } catch {
    invalid(`${label} is not JSON`);
  }
  if (json === void 0 || new TextEncoder().encode(json).length > max2) invalid(`${label} exceeds ${max2} UTF-8 bytes`);
}
function text(value2, label, max2 = 256) {
  if (typeof value2 !== "string" || !value2.length || value2.length > max2) invalid(`${label} must be a nonempty string of at most ${max2} characters`);
  return value2;
}
function parseAdvertisement(value2) {
  bounded(value2, COMPAT_MAX_BYTES, "compat");
  const ad = object(value2, "compat");
  keys(ad, ["bootstrap", "hub", "schemas", "capabilities", "requiredCapabilities", "legacy", "release"], "compat");
  if (ad.bootstrap !== COMPAT_BOOTSTRAP) invalid("unsupported bootstrap; implement bootstrap 1");
  const schemas = object(ad.schemas, "schemas");
  keys(schemas, ["read", "write"], "schemas");
  const result = { bootstrap: 1, hub: range(ad.hub, "hub"), schemas: { read: versions(schemas.read, "schemas.read"), write: versions(schemas.write, "schemas.write", true) }, capabilities: capabilities(ad.capabilities, "capabilities") };
  if (ad.requiredCapabilities !== void 0) result.requiredCapabilities = capabilities(ad.requiredCapabilities, "requiredCapabilities");
  if (ad.legacy !== void 0) {
    const legacy = object(ad.legacy, "legacy");
    keys(legacy, ["schema", "hub"], "legacy");
    if (legacy.schema !== 2 || legacy.hub !== 1 || result.hub.min > 1 || !result.schemas.read.includes(2) || !result.schemas.write.includes(2)) invalid("legacy requires the implemented schema-2/proto-1 profile");
    result.legacy = { schema: 2, hub: 1 };
  }
  if (ad.release !== void 0) result.release = text(ad.release, "release", 128);
  return result;
}
function selectContract(clientInput, serverInput, policy) {
  let client = null, server = null;
  const refuse = (code, change, message, missingCapabilities = {}) => ({ ok: false, error: { code, side: change.side, text: message, requiredChanges: [change], missingCapabilities, supported: { client, server } } });
  try {
    client = parseAdvertisement(clientInput);
  } catch (e) {
    return refuse("invalid-advertisement", { side: "client", action: "update", contract: "advertisement" }, `Update/restart the client with a valid bootstrap-1 advertisement: ${e.message}`);
  }
  try {
    server = parseAdvertisement(serverInput);
  } catch (e) {
    return refuse("invalid-advertisement", { side: "server", action: "update", contract: "advertisement" }, `Update/restart the server with a valid bootstrap-1 advertisement: ${e.message}`);
  }
  if (!integer(policy.activeSchema)) return refuse("schema-incompatible", { side: "room", action: "configure", contract: "schema", versions: server.schemas.read }, "Configure the room with an implemented active schema; no migration is automatic");
  const schemaChanges = [];
  for (const [side, ad] of [["server", server], ["client", client]]) {
    if (!ad.schemas.read.includes(policy.activeSchema) || !policy.readOnly && !ad.schemas.write.includes(policy.activeSchema)) schemaChanges.push({ side, action: "update", contract: "schema", versions: [policy.activeSchema] });
  }
  if (schemaChanges.length) return { ok: false, error: { code: "schema-incompatible", side: schemaChanges[0].side, text: `Update/restart the ${schemaChanges.map((c) => c.side).join(" and ")} to ${policy.readOnly ? "read" : "read and write"} document schema ${policy.activeSchema}`, requiredChanges: schemaChanges, missingCapabilities: {}, supported: { client, server } } };
  const min2 = Math.max(client.hub.min, server.hub.min), max2 = Math.min(client.hub.max, server.hub.max);
  if (min2 > max2) {
    const side = client.hub.max < server.hub.min ? "client" : "server", target = side === "client" ? server.hub : client.hub;
    return refuse("hub-incompatible", { side, action: "update", contract: "hub", range: target }, `Update/restart the ${side} to support hub protocol ${target.min}\u2013${target.max}`);
  }
  let roomRequired;
  try {
    bounded(policy.requiredCapabilities ?? {}, COMPAT_MAX_BYTES, "room requirements");
    roomRequired = capabilities(policy.requiredCapabilities ?? {}, "room requirements");
  } catch (e) {
    return refuse("invalid-advertisement", { side: "room", action: "configure", contract: "advertisement" }, `Configure valid room requirements: ${e.message}`);
  }
  const requirements = [["client", client.requiredCapabilities ?? {}], ["server", server.requiredCapabilities ?? {}], ["room", roomRequired]];
  for (const [owner, required] of requirements) for (const [name, set] of Object.entries(required)) {
    const registered = CAPABILITY_REGISTRY[name];
    if (!registered || !set.some((v) => registered.versions[v])) return refuse("capability-incompatible", { side: owner, action: owner === "room" ? "configure" : "update", contract: "capability", capability: name, versions: set }, `${owner === "room" ? "Configure the room requirements" : `Update/restart the ${owner}`} for required capability ${name} version ${set.join(" or ")}; this implementation has no registered version in that set`, { [name]: set });
  }
  let lastFailure;
  const candidates = /* @__PURE__ */ new Set([max2, min2]);
  for (const entry of Object.values(CAPABILITY_REGISTRY)) for (const version of Object.values(entry.versions)) {
    if (version.hub.max >= min2 && version.hub.max <= max2) candidates.add(version.hub.max);
  }
  for (const hub of [...candidates].sort((a, b) => b - a)) {
    const selected = {};
    for (const [name, entry] of Object.entries(CAPABILITY_REGISTRY)) {
      const accepted = requirements.flatMap(([, required]) => required[name] ? [required[name]] : []);
      const common = (client.capabilities[name] ?? []).filter((v) => server.capabilities[name]?.includes(v) && accepted.every((set) => set.includes(v)));
      for (const v of common.sort((a, b) => b - a)) {
        const rule = entry.versions[v];
        if (rule && hub >= rule.hub.min && hub <= rule.hub.max && rule.schemas.includes(policy.activeSchema)) {
          selected[name] = v;
          break;
        }
      }
    }
    let removed;
    do {
      removed = false;
      for (const [name, v] of Object.entries(selected)) {
        const dependencies = CAPABILITY_REGISTRY[name].versions[v].dependencies;
        if (Object.entries(dependencies).some(([dep, set]) => !set.includes(selected[dep]))) {
          delete selected[name];
          removed = true;
        }
      }
    } while (removed);
    const changes = [], missing = {};
    for (const [owner, required] of requirements) for (const [name, set] of Object.entries(required)) {
      if (set.includes(selected[name])) continue;
      const registered = CAPABILITY_REGISTRY[name];
      const sides = [];
      if (!registered || !set.some((v) => registered.versions[v])) sides.push(owner);
      else {
        if (!set.some((v) => client.capabilities[name]?.includes(v))) sides.push("client");
        if (!set.some((v) => server.capabilities[name]?.includes(v))) sides.push("server");
        if (!sides.length) sides.push(owner);
      }
      missing[name] = [.../* @__PURE__ */ new Set([...missing[name] ?? [], ...set])].sort((a, b) => a - b);
      for (const side of sides) {
        const change = { side, action: side === "room" ? "configure" : "update", contract: "capability", capability: name, versions: set };
        if (!changes.some((c) => JSON.stringify(c) === JSON.stringify(change))) changes.push(change);
      }
    }
    if (!changes.length) return { ok: true, selection: { bootstrap: 1, hub, schema: policy.activeSchema, capabilities: selected } };
    const guidance = changes.map((c) => `${c.side === "room" ? "Configure the room" : `Update/restart the ${c.side}`} for ${c.capability} version ${c.versions.join(" or ")}`);
    lastFailure = { ok: false, error: { code: "capability-incompatible", side: changes[0].side, text: `${guidance.join("; ")}; required schema/protocol dependencies must also be supported`, requiredChanges: changes, missingCapabilities: missing, supported: { client, server } } };
  }
  return lastFailure;
}
function legacyHello(id2, client, sessionId) {
  return { v: 1, id: id2, op: "hello", proto: 1, schema: 2, client, sessionId };
}
function parseBootstrapFrame(value2) {
  bounded(value2, BOOTSTRAP_MAX_BYTES, "bootstrap frame");
  const f = object(value2, "bootstrap frame");
  if (f.v !== 1) invalid("bootstrap envelope must be v1");
  if (f.op === "compat-hello") {
    keys(f, ["v", "op", "id", "sessionId", "offer"], "hello");
    return { v: 1, op: "compat-hello", id: text(f.id, "id"), sessionId: text(f.sessionId, "sessionId", BOOTSTRAP_SESSION_ID_MAX_LENGTH), offer: parseAdvertisement(f.offer) };
  }
  if (f.op === "compat-ack") {
    keys(f, ["v", "op", "id", "selectionId"], "ack");
    return { v: 1, op: "compat-ack", id: text(f.id, "id"), selectionId: text(f.selectionId, "selectionId") };
  }
  if (f.ok === true && !Object.hasOwn(f, "selection")) {
    keys(f, ["v", "re", "ok"], "acknowledged");
    return { v: 1, re: text(f.re, "re"), ok: true };
  }
  if (f.ok === true) {
    keys(f, ["v", "re", "ok", "selectionId", "selection", "compat", "generation", "policyRevision", "incarnation", "ttlMs", "renewMs", "requiredCapabilities"], "selection");
    const s = object(f.selection, "selection");
    keys(s, ["bootstrap", "hub", "schema", "capabilities"], "selection");
    if (s.bootstrap !== 1 || !integer(s.hub) || !integer(s.schema)) invalid("invalid selected contract");
    const caps = object(s.capabilities, "selected capabilities"), selected = {};
    capabilities(Object.fromEntries(Object.entries(caps).map(([name, v]) => [name, [v]])), "selected capabilities");
    for (const [name, v] of Object.entries(caps)) selected[name] = v;
    for (const key of ["policyRevision", "incarnation", "ttlMs", "renewMs"]) if (!Number.isSafeInteger(f[key]) || f[key] < (key.endsWith("Ms") ? 1 : 0)) invalid(`invalid ${key}`);
    return { v: 1, re: text(f.re, "re"), ok: true, selectionId: text(f.selectionId, "selectionId"), selection: { bootstrap: 1, hub: s.hub, schema: s.schema, capabilities: selected }, compat: parseAdvertisement(f.compat), generation: text(f.generation, "generation"), policyRevision: f.policyRevision, incarnation: f.incarnation, ttlMs: f.ttlMs, renewMs: f.renewMs, requiredCapabilities: capabilities(f.requiredCapabilities, "requiredCapabilities") };
  }
  if (f.ok === false) {
    keys(f, ["v", "re", "ok", "error"], "refusal");
    const e = object(f.error, "refusal error");
    keys(e, ["code", "side", "text", "requiredChanges", "missingCapabilities", "supported"], "refusal error");
    if (!["invalid-advertisement", "hub-incompatible", "schema-incompatible", "capability-incompatible"].includes(e.code) || !["client", "server", "room"].includes(e.side)) invalid("invalid refusal code or side");
    text(e.text, "error text", 2048);
    if (!Array.isArray(e.requiredChanges) || !e.requiredChanges.length) invalid("missing required changes");
    capabilities(e.missingCapabilities, "missingCapabilities");
    const supported = object(e.supported, "supported");
    keys(supported, ["client", "server"], "supported");
    for (const side of ["client", "server"]) if (supported[side] !== null) parseAdvertisement(supported[side]);
    for (const change of e.requiredChanges) {
      const c = object(change, "required change");
      keys(c, ["side", "action", "contract", "versions", "range", "capability"], "required change");
      if (!["client", "server", "room"].includes(c.side) || !["update", "configure"].includes(c.action) || !["advertisement", "hub", "schema", "capability"].includes(c.contract)) invalid("invalid required change");
      if (c.versions !== void 0) versions(c.versions, "required versions");
      if (c.range !== void 0) range(c.range, "required range");
      if (c.capability !== void 0) capabilities({ [text(c.capability, "capability", 64)]: [1] }, "required capability");
    }
    return { v: 1, re: text(f.re, "re"), ok: false, error: e };
  }
  return invalid("unknown bootstrap frame");
}

// packages/hub-core/src/protocol.ts
var MSG_HUB = 7;
var HUB_PROTO = 1;
var HUB_ORIGIN = /* @__PURE__ */ Symbol("room-hub");
var LEASE_TTL_MS = 45e3;
var LEASE_RENEW_MS = 15e3;
var SETTLE_MS = 5e3;
var STARTING_RETRY_MS = 1e3;
function encodeFrame(frame) {
  const enc = createEncoder();
  writeVarUint(enc, MSG_HUB);
  writeVarString(enc, JSON.stringify(frame));
  return toUint8Array(enc);
}
function decodeFrame(input) {
  let dec;
  if (input instanceof Uint8Array) {
    dec = createDecoder(input);
    const type = readVarUint(dec);
    if (type !== MSG_HUB) throw new Error(`not a hub frame: message type ${type}`);
  } else dec = input;
  return JSON.parse(readVarString(dec));
}
var COUNTER_BITS = 21;
var COUNTER_LIMIT = 2 ** COUNTER_BITS;
function encodeSeq(incarnation, n) {
  if (!Number.isInteger(incarnation) || incarnation < 0 || incarnation >= 2 ** 32) throw new RangeError(`incarnation out of range: ${incarnation}`);
  if (!Number.isInteger(n) || n < 0 || n >= COUNTER_LIMIT) throw new RangeError(`counter out of range: ${n}`);
  return incarnation * COUNTER_LIMIT + n;
}
function incarnationOf(value2) {
  return Math.floor(value2 / COUNTER_LIMIT);
}

// packages/shared/src/index.ts
init_types();
init_identity();
init_claims();
init_doc();
init_manifest();
init_manifest_node();
init_format();
init_messages();

// packages/shared/src/wake.ts
init_identity();
init_claims();
init_messages();

// packages/shared/src/index.ts
init_ledger();
init_delivery();

// packages/shared/src/graph.ts
var KEYWORDS = new Set("def class return if else elif for while in not and or import from as with try except finally raise pass break continue lambda yield await async None True False self cls function const let var new this export default import from return if else for while do switch case break continue typeof instanceof void null undefined true false async await class extends super interface type enum implements".split(" "));
var CONTRACT_TEXT_MAX_CHARS = 256 * 1024;

// packages/shared/src/index.ts
init_views();

// packages/shared/src/memory.ts
init_yjs();
init_delivery();
init_worker_memory();
var MAX_MEMORY_BYTES = 5 * 1024 * 1024;
var ROOM_DOC_MAX_BYTES = 64 * 1024 * 1024;
var MEMORY_TYPES = {
  bus: "array",
  ledger: "map",
  retiredWorkers: "array",
  workers: "map",
  scopes: "map",
  claims: "map",
  unresolved: "map",
  aliases: "map",
  colors: "map",
  meta: "map",
  mail: "map",
  outcomes: "map",
  archive: "map"
};
var MEMORY_PREFIXES = { "seen:": "map" };
function* memoryTypes(doc, includePublications = false) {
  for (const [name, kind] of Object.entries(MEMORY_TYPES)) if (doc.share.has(name)) yield [name, kind];
  if (includePublications) for (const name of ["completedPublications", "completedPublicationRevisions"]) {
    if (doc.share.has(name)) yield [name, "map"];
  }
  for (const name of doc.share.keys()) {
    for (const [prefix2, kind] of Object.entries(MEMORY_PREFIXES)) if (name.startsWith(prefix2)) yield [name, kind];
  }
}
var compare2 = (a, b) => a < b ? -1 : a > b ? 1 : 0;
var entrySize = (key, value2) => key.length + JSON.stringify(value2).length;
function validReceipt(value2) {
  if (typeof value2 === "number") return Number.isFinite(value2);
  const r = value2;
  return !!r && typeof r === "object" && typeof r.s === "string" && typeof r.via === "string" && typeof r.at === "number" && Number.isFinite(r.at);
}
function memorySnapshot(doc, { maxBytes = MAX_MEMORY_BYTES, log: log2, onShed } = {}) {
  const { publications, copyRevisionsTo } = workerMemory(doc);
  const arrays = /* @__PURE__ */ new Map(), maps = /* @__PURE__ */ new Map();
  const seenMaps = /* @__PURE__ */ new Map();
  for (const [name, kind] of memoryTypes(doc)) {
    if (kind === "array") arrays.set(name, JSON.parse(JSON.stringify(doc.getArray(name).toArray())));
    else (name.startsWith("seen:") ? seenMaps : maps).set(name, Object.entries(JSON.parse(JSON.stringify(doc.getMap(name).toJSON()))));
  }
  const bus = arrays.get("bus") ?? [];
  const held = new Set([...maps.get("mail") ?? [], ...maps.get("outcomes") ?? []].map(([id2]) => id2));
  const broadcastIndex = /* @__PURE__ */ new Map();
  bus.forEach((m, index) => {
    if (typeof m?.id !== "string") return;
    if (m.to) held.add(m.id);
    else broadcastIndex.set(m.id, index);
  });
  const receipts = /* @__PURE__ */ new Map();
  const keep = (map, id2, value2) => {
    const kept = receipts.get(map) ?? /* @__PURE__ */ new Map();
    kept.set(id2, value2);
    receipts.set(map, kept);
  };
  let spent = 0;
  const broadcasts = [];
  for (const [map, entries] of seenMaps) for (const [id2, value2] of entries) {
    if (!validReceipt(value2)) continue;
    const size2 = entrySize(id2, value2);
    if (held.has(id2)) {
      keep(map, id2, value2);
      spent += size2;
    } else if (broadcastIndex.has(id2)) broadcasts.push({ map, id: id2, value: value2, size: size2, index: broadcastIndex.get(id2) });
  }
  broadcasts.sort((a, b) => b.index - a.index || compare2(a.map, b.map));
  const keptBroadcasts = [];
  for (const r of broadcasts) {
    if (spent + r.size > RECEIPTS_BYTES) break;
    keep(r.map, r.id, r.value);
    spent += r.size;
    keptBroadcasts.push(r);
  }
  if (keptBroadcasts.length < broadcasts.length) onShed?.();
  const build = () => {
    const copy2 = new Doc();
    try {
      copy2.transact(() => {
        for (const [name, values] of arrays) if (values.length) copy2.getArray(name).push(values);
        for (const [name, entries] of maps) for (const [key, value2] of entries) copy2.getMap(name).set(key, value2);
        for (const [name, kept] of receipts) for (const [key, value2] of kept) copy2.getMap(name).set(key, value2);
        for (const publication of publications) publication.copyTo(copy2);
        copyRevisionsTo(copy2);
      });
      return encodeStateAsUpdate(copy2);
    } finally {
      copy2.destroy();
    }
  };
  let update = build();
  if (update.byteLength <= maxBytes) return update;
  const shed = (list, size2, drop) => {
    let dropped = 0;
    while (update.byteLength > maxBytes && list.length) {
      let need = update.byteLength - maxBytes, n = 0;
      while (n < list.length && need > 0) need -= size2(list[n++]);
      drop(list.splice(0, n));
      dropped += n;
      update = build();
    }
    return dropped;
  };
  const publicationsDropped = shed(publications, (value2) => value2.size, () => {
  });
  if (publicationsDropped) onShed?.();
  if (publicationsDropped) log2?.(`snapshot over ${maxBytes} bytes: dropped ${publicationsDropped} completed worker publications`);
  const archive = (maps.get("archive") ?? []).sort(([a, x], [b, y]) => x[2] - y[2] || compare2(a, b));
  const archiveDropped = shed(archive, ([id2, value2]) => entrySize(id2, value2), () => {
  });
  const receiptsDropped = shed(keptBroadcasts.reverse(), (r) => r.size, (items) => {
    for (const r of items) receipts.get(r.map).delete(r.id);
  });
  const oldest = bus.filter((m) => typeof m?.id === "string" && !m.to);
  const busDropped = shed(oldest, (m) => JSON.stringify(m).length, (items) => {
    const gone = new Set(items);
    arrays.set("bus", arrays.get("bus").filter((m) => !gone.has(m)));
  });
  if (archiveDropped || receiptsDropped || busDropped) onShed?.();
  log2?.(`snapshot over ${maxBytes} bytes: dropped ${archiveDropped} archive entries, ${receiptsDropped} broadcast receipts, ${busDropped} bus broadcasts${update.byteLength > maxBytes ? "; still over" : ""}`);
  return update;
}

// packages/shared/src/index.ts
init_near();

// packages/shared/src/expiry.ts
init_doc();
init_views();
var ROOM_STALE_DAYS = ROOM_STALE_MS / (24 * 60 * 60 * 1e3);
var same = (a, b) => a === b || !!a && !!b && a.observedMs === b.observedMs && a.epoch === b.epoch;
var ExpiryTenure = class {
  /** `clock` is monotonic and local; nothing another machine wrote is ever compared with it. */
  constructor(epoch, clock) {
    this.epoch = epoch;
    this.clock = clock;
  }
  epoch;
  clock;
  segments = /* @__PURE__ */ new Map();
  /**
   * One leader tick. A participant is measured only when it has a `holder` (a lease-holding session that
   * could be fresh) and is not a worker. A segment adds time only while `expiry[name]` still holds what
   * this tenure last saw there, so a concurrent leader's write restarts the measurement instead of being
   * counted twice. Returns the names it expired; `post` appends their release notices.
   */
  observe(room, view, origin, post) {
    const now = this.clock();
    const expired = [];
    const measured = /* @__PURE__ */ new Set();
    room.doc.transact(() => {
      for (const [id2, claim] of room.claims.entries()) {
        if (!claim || typeof claim.id !== "string" || typeof claim.by !== "string" || typeof claim.path !== "string" || !["human", "agent", "bot", "ci"].includes(claim.byKind)) room.claims.delete(id2);
      }
      for (const participant of view) {
        const { name } = participant;
        const holder = participantRecord(room, name)?.holder;
        if (!holder || holder.workerId || room.workerViewOf(name)) continue;
        measured.add(name);
        const raw = room.expiry.get(name);
        const current = raw && Number.isFinite(raw.observedMs) && raw.observedMs >= 0 && typeof raw.epoch === "string" ? raw : void 0;
        if (raw && !current) room.expiry.delete(name);
        if (participant.fresh) {
          this.segments.delete(name);
          if (current) room.expiry.delete(name);
          continue;
        }
        const segment = this.segments.get(name);
        if (!segment || !same(current, segment.expect)) {
          this.segments.set(name, { t0: now, base: current?.observedMs ?? 0, expect: current });
          continue;
        }
        const next = { observedMs: segment.base + Math.max(0, now - segment.t0), epoch: this.epoch };
        room.expiry.set(name, next);
        segment.expect = next;
        if (next.observedMs >= ROOM_STALE_MS) expired.push(name);
      }
      for (const name of expired) expireParticipant(room, name, origin, post);
    }, origin);
    for (const name of this.segments.keys()) if (!measured.has(name) || expired.includes(name)) this.segments.delete(name);
    return expired;
  }
  /** The participant is back (a lease granted or adopted between ticks): its absence restarts from zero. */
  present(room, name, origin) {
    this.segments.delete(name);
    if (room.expiry.has(name)) room.doc.transact(() => {
      room.expiry.delete(name);
    }, origin);
  }
};
function expireParticipant(room, name, origin, post) {
  const prefix2 = `${name}\0`;
  const dropOwned = (map) => {
    for (const key of [...map.keys()]) if (key.startsWith(prefix2)) map.delete(key);
  };
  room.doc.transact(() => {
    dropOwned(room.participants);
    dropOwned(room.doc.getMap("manifest"));
    room.doc.getMap("manifestHead").delete(name);
    dropOwned(room.doc.getMap("conflicts"));
    room.clearWorkerCoordination(name, `expired after ${ROOM_STALE_DAYS} days offline`, post);
    room.expiry.delete(name);
  }, origin);
}

// packages/shared/src/build-output.ts
var REGENERABLE_BUILD_DIRS = [
  "dist",
  "build",
  "out",
  ".astro",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  "test-results",
  "playwright-report",
  "node_modules",
  "vendor",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  "target"
];
var buildDirs = new Set(REGENERABLE_BUILD_DIRS);

// packages/shared/src/compact.ts
var GENERATION_KEY = "generation";
var docGeneration = (doc) => {
  const value2 = doc.getMap("meta").get(GENERATION_KEY);
  return typeof value2 === "string" && value2 ? value2 : void 0;
};
var GENERATION_PARAM = "gen";
var FRESH_GENERATION = "fresh";
var UNCOMPACTED = "0";
var STALE_REPLICA_CODE = 4409;
var STALE_REPLICA_REASON = "this room's document was compacted when the server restarted; rejoin with a fresh copy";
var COMPACTED_UPDATE_REASON = "update Room to 0.17.0 or later (browser: reload the page): this room's document was compacted";
function generationGate(stated, current) {
  const room = current ?? UNCOMPACTED;
  if (stated === null) return room === UNCOMPACTED ? "accept" : "update";
  return stated === FRESH_GENERATION || stated === room ? "accept" : "stale";
}
function historyOf(doc) {
  let structs = 0, deleted = 0;
  for (const list of doc.store.clients.values()) {
    structs += list.length;
    for (const struct of list) if (struct.deleted) deleted++;
  }
  return { structs, deleted };
}
function compactMinDeleted(raw) {
  if (raw === void 0 || raw === "") return 1e4;
  const n = Number(raw);
  return raw === "off" || n === 0 ? Infinity : Number.isFinite(n) && n > 0 ? n : 1e4;
}

// packages/hub-core/src/hub.ts
var MAINTENANCE_MS = 6e4;
var MAX_HUB_FRAME_BYTES = 96 * 1024;
var MAX_HUB_REQUESTS_PER_SECOND = 500;
var MAX_HUB_REPLY_ID_LENGTH = 128;
var hubReplyId = (frame) => isObject(frame) && typeof frame.id === "string" && frame.id.length <= MAX_HUB_REPLY_ID_LENGTH ? frame.id : "";
var HubRequestBudget = class {
  connections = /* @__PURE__ */ new WeakMap();
  take(conn, now = Date.now()) {
    const current = this.connections.get(conn);
    if (!current || now - current.at >= 1e3) {
      this.connections.set(conn, { at: now, count: 1 });
      return void 0;
    }
    if (current.count >= MAX_HUB_REQUESTS_PER_SECOND) return Math.max(1, 1e3 - (now - current.at));
    current.count++;
    return void 0;
  }
};
var MAX_HOLDER_FIELD_LENGTH = 512;
var MAX_LEASES_PER_ROOM = 512;
var MAX_LEASES_PER_PRINCIPAL = 64;
var MAX_RETAINED_NAMES = 1024;
var MAX_RETAINED_NAMES_PER_PRINCIPAL = 128;
var POST_RATE_PER_LEASE = 250;
var POST_RATE_PER_PRINCIPAL = 500;
var POST_RATE_PER_ROOM = 1e3;
var POST_RATE_WINDOW_MS = 1e3;
var MAX_RATE_KEYS = 2048;
var MAX_INCARNATION_AHEAD = 1e6;
function serializedStore(record) {
  let queue = Promise.resolve();
  const valid = (v, ceiling = 2 ** 32 - 1) => v !== void 0 && Number.isSafeInteger(v) && v >= 0 && v < 2 ** 32 && v <= ceiling ? v : void 0;
  return {
    current: async (ceiling) => valid(await record.read(), ceiling),
    advance(floor2) {
      const run = queue.then(async () => {
        if (!Number.isSafeInteger(floor2) || floor2 < 0 || floor2 >= 2 ** 32) throw new RoomStateError("incarnation floor is out of range");
        const next = Math.max((valid(await record.read(), floor2 + MAX_INCARNATION_AHEAD) ?? -1) + 1, floor2);
        if (next >= 2 ** 32) throw new RoomStateError("incarnation counter exhausted");
        await record.write(next);
        return next;
      });
      queue = run.catch(() => void 0);
      return run;
    }
  };
}
var RoomStateError = class extends Error {
  name = "RoomStateError";
};
var HOLDER = "\0holder";
var holderKey = (name) => `${name}${HOLDER}`;
var encoder2 = new TextEncoder();
var sizeOf2 = (value2) => encoder2.encode(JSON.stringify(value2)).length;
var isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var isName = (v) => typeof v === "string" && validParticipantName(v) && v.length <= 200;
var isCounter = (v) => Number.isSafeInteger(v) && v >= 0 && v < 2 ** 32 * COUNTER_LIMIT;
function parseHolder(v, record = false) {
  if (!isObject(v) || typeof v.sessionId !== "string" || !v.sessionId || v.sessionId.length > MAX_HOLDER_FIELD_LENGTH || !Number.isSafeInteger(v.pid) || v.pid < 0 || v.pid > 2 ** 31 - 1 || typeof v.startTime !== "string" || v.startTime.length > MAX_HOLDER_FIELD_LENGTH || typeof v.executable !== "string" || v.executable.length > MAX_HOLDER_FIELD_LENGTH || v.workerId !== void 0 && (typeof v.workerId !== "string" || v.workerId.length > MAX_HOLDER_FIELD_LENGTH) || Object.keys(v).some((k) => !["sessionId", "pid", "startTime", "executable", "workerId", ...record ? ["epoch", "at", "ended", "session", "principal"] : []].includes(k))) return void 0;
  return { sessionId: v.sessionId, pid: v.pid, startTime: v.startTime, executable: v.executable, ...v.workerId !== void 0 ? { workerId: v.workerId } : {} };
}
function hubHolder(v) {
  const holder = parseHolder(v, true);
  if (!holder || !isObject(v) || !isCounter(v.epoch) || !Number.isFinite(v.at) || v.ended !== void 0 && v.ended !== "released" && v.ended !== "expired" || v.session !== void 0 && (typeof v.session !== "string" || v.session.length > MAX_HOLDER_FIELD_LENGTH) || v.principal !== void 0 && (typeof v.principal !== "string" || v.principal.length > MAX_HOLDER_FIELD_LENGTH)) return void 0;
  const ended = v.ended === "released" || v.ended === "expired" ? v.ended : void 0;
  return {
    ...holder,
    epoch: v.epoch,
    at: typeof v.at === "number" ? v.at : 0,
    ...ended ? { ended } : {},
    ...typeof v.session === "string" ? { session: v.session } : {},
    ...typeof v.principal === "string" ? { principal: v.principal } : {}
  };
}
var sameRecord = (a, b) => !!a && JSON.stringify(a) === JSON.stringify(b);
var higher = (a, b) => a === void 0 ? b : b === void 0 ? a : Math.max(a, b);
function visible(doc) {
  let epoch, seq;
  let invalid2 = false;
  const see = (v, kind) => {
    if (v === void 0) return;
    if (!isCounter(v)) {
      invalid2 = true;
      return;
    }
    if (kind === "epoch") epoch = higher(epoch, v);
    else seq = higher(seq, v);
  };
  const meta = doc.metaMap;
  see(meta.get("hubEpoch"), "epoch");
  see(meta.get("hubSeq"), "seq");
  for (const m of doc.bus.toArray()) see(m?.seq, "seq");
  for (const m of doc.mail.values()) see(m?.seq, "seq");
  const rawIncarnation = meta.get("hubIncarnation");
  if (rawIncarnation !== void 0 && (!Number.isSafeInteger(rawIncarnation) || rawIncarnation < 0 || rawIncarnation >= 2 ** 32)) invalid2 = true;
  const incarnation = Math.max(
    isCounter(rawIncarnation) ? rawIncarnation : -1,
    ...[epoch, seq].map((v) => v === void 0 ? -1 : incarnationOf(v))
  );
  return { epoch, seq, incarnation, invalid: invalid2 };
}
async function startHub(host) {
  const hub = new RoomHub(host);
  await hub.start();
  return hub;
}
var RoomHub = class {
  constructor(host) {
    this.host = host;
    this.limit = host.counterLimit ?? COUNTER_LIMIT;
  }
  host;
  incarnation = 0;
  limit;
  epochs = 0;
  seqs = 0;
  lastEpoch;
  lastSeq;
  reincarnating;
  startedAt = 0;
  freshAtStart = false;
  settled = false;
  maintainedAt = 0;
  dirty = false;
  stopped = false;
  unauthorized = false;
  unavailableSince;
  tenure;
  leases = /* @__PURE__ */ new Map();
  records = /* @__PURE__ */ new Map();
  unadopted = /* @__PURE__ */ new Map();
  stored = /* @__PURE__ */ new Map();
  leaseWrite;
  leaseDirty = false;
  leaseWriteFailed = false;
  greeted = /* @__PURE__ */ new Set();
  sessions = /* @__PURE__ */ new Map();
  rates = /* @__PURE__ */ new Map();
  push = () => {
  };
  onUpdate = (_update, origin) => {
    if (origin === HUB_ORIGIN) return;
    this.dirty = true;
    if (this.settling() && !this.storageUnavailable()) this.adoptSynced();
  };
  get doc() {
    return this.host.doc;
  }
  async start() {
    if (this.host.unavailable?.()) throw new Error("hub storage unavailable at startup");
    const before = visible(this.doc);
    const wallFloor = Math.floor(this.host.wall() / 1e3);
    const trusted = Math.max(await this.host.store.current?.(wallFloor + MAX_INCARNATION_AHEAD) ?? -1, wallFloor, this.incarnation);
    if (before.invalid || before.incarnation > trusted || trusted >= 2 ** 32) throw new RoomStateError("room hub counters exceed the trusted incarnation bound");
    this.freshAtStart = this.host.fresh === true && before.epoch === void 0 && before.seq === void 0 && before.incarnation < 0 && ![...this.doc.participants.keys()].some((key) => key.endsWith(HOLDER));
    await this.incarnate();
    if (this.host.leases) {
      try {
        const rows = await this.host.leases.read();
        if (!Array.isArray(rows) || rows.length > MAX_RETAINED_NAMES) throw new Error("invalid lease count");
        const loaded = /* @__PURE__ */ new Map();
        for (const row of rows) {
          if (!isObject(row) || Object.keys(row).some((k) => !["name", "epoch", "at", "holder", "principal", "session", "ended"].includes(k)) || !isName(row.name) || !isCounter(row.epoch) || incarnationOf(row.epoch) >= this.incarnation || !Number.isFinite(row.at) || row.at < 0 || !parseHolder(row.holder) || typeof row.principal !== "string" || !row.principal || row.principal.length > MAX_HOLDER_FIELD_LENGTH || typeof row.session !== "string" || !row.session || row.session.length > MAX_HOLDER_FIELD_LENGTH || row.ended !== void 0 && row.ended !== "released" && row.ended !== "expired" || loaded.has(row.name)) throw new Error("invalid lease record");
          loaded.set(row.name, row);
        }
        this.stored = loaded;
      } catch (e) {
        if (this.host.requireLeaseLoad) throw new Error(`hub authority lease recovery failed: ${e instanceof Error ? e.message : e}`, { cause: e });
        this.stored.clear();
        this.host.log(`hub: lease store unreadable; no leases adopted: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.tenure = new ExpiryTenure(`inc:${this.incarnation}`, () => this.host.mono());
    this.startedAt = this.maintainedAt = this.host.mono();
    this.adoptStored();
    deliveryIndex(this.doc);
    this.adoptSynced();
    this.doc.doc.on("update", this.onUpdate);
    this.host.log(`hub: incarnation ${this.incarnation}, ${this.leases.size} lease(s) carried over`);
  }
  /** Take a new incarnation (§3): durable before anything is issued under it. */
  async incarnate() {
    const seen = visible(this.doc);
    const wallFloor = Math.floor(this.host.wall() / 1e3);
    const trusted = Math.max(await this.host.store.current?.(wallFloor + MAX_INCARNATION_AHEAD) ?? -1, wallFloor, this.incarnation);
    if (seen.invalid || seen.incarnation > trusted || trusted >= 2 ** 32) throw new RoomStateError("room hub counters exceed the trusted incarnation bound");
    const floor2 = Math.max(seen.incarnation + 1, this.incarnation + 1, wallFloor);
    const next = await this.host.store.advance(floor2);
    if (!Number.isInteger(next) || next < floor2 || next >= 2 ** 32) throw new Error(`incarnation store returned ${next} for floor ${floor2}`);
    this.incarnation = next;
    this.epochs = this.seqs = 0;
    this.doc.doc.transact(() => {
      this.doc.metaMap.set("hubIncarnation", next);
    }, HUB_ORIGIN);
  }
  stop() {
    this.stopped = true;
    this.doc.doc.off("update", this.onUpdate);
  }
  async flushLeases() {
    if (!this.host.leases) return;
    while (this.leaseWrite || this.leaseDirty) {
      if (!this.leaseWrite) {
        this.leaseWriteFailed = false;
        this.writeLeases();
      }
      await this.leaseWrite;
      if (this.leaseWriteFailed) throw new Error("lease store write failed");
    }
  }
  onPush(fn) {
    this.push = fn;
  }
  closed(conn) {
    this.greeted.delete(conn);
    this.sessions.delete(conn);
    for (const lease of this.leases.values()) if (lease.conn === conn) lease.conn = void 0;
  }
  settling() {
    return !this.freshAtStart && this.host.mono() - this.startedAt < SETTLE_MS;
  }
  notify(name, lease, reason) {
    if (lease.conn) this.push(lease.conn, { v: 1, push: "lease-lost", name, epoch: lease.epoch, reason });
  }
  authorized() {
    if (this.stopped) return false;
    if (!this.host.authority || this.host.authority()) {
      this.unauthorized = false;
      return true;
    }
    if (!this.unauthorized) {
      this.unauthorized = true;
      this.host.log("hub: lost the authority lock; answering not-authority");
      for (const [name, lease] of this.leases) this.notify(name, lease, "not-authority");
    }
    return false;
  }
  // ---- leases ----
  record(name) {
    return hubHolder(this.doc.participants.get(holderKey(name)));
  }
  /** The doc record for what the hub knows of a name, when it knows the holder. */
  recordOf(k) {
    return k.holder && {
      ...k.holder,
      epoch: k.epoch,
      at: k.at,
      ...k.ended ? { ended: k.ended } : {},
      ...k.session ? { session: k.session } : {},
      ...k.principal ? { principal: k.principal } : {}
    };
  }
  /** A lease is live from here: granted, or adopted from an earlier incarnation. The participant is back (§8). */
  hold(name, lease) {
    this.leases.set(name, lease);
    this.records.set(name, lease);
    this.tenure.present(this.doc, name, HUB_ORIGIN);
    this.remember(name, lease);
  }
  remember(name, known) {
    if (!known.holder || !known.principal || !known.session) return;
    this.stored.set(name, {
      name,
      epoch: known.epoch,
      at: known.at,
      holder: known.holder,
      principal: known.principal,
      session: known.session,
      ...known.ended ? { ended: known.ended } : {}
    });
    this.leaseDirty = true;
    this.leaseWriteFailed = false;
    this.writeLeases();
  }
  writeLeases() {
    if (!this.host.leases || this.leaseWrite || !this.leaseDirty) return;
    this.leaseDirty = false;
    const snapshot = [...this.stored.values()];
    this.leaseWrite = Promise.resolve().then(() => this.host.leases.write(snapshot)).catch((e) => {
      this.leaseDirty = true;
      this.leaseWriteFailed = true;
      this.host.log(`hub: lease store write failed: ${e instanceof Error ? e.message : e}`);
    }).finally(() => {
      this.leaseWrite = void 0;
      if (this.leaseDirty && !this.stopped && !this.leaseWriteFailed) this.writeLeases();
    });
  }
  adoptStored() {
    for (const record of this.stored.values()) {
      if (this.allocationFailure(record.name, record.principal, !record.ended)) {
        this.unadopted.set(record.name, record);
        this.stored.delete(record.name);
        this.leaseDirty = true;
        continue;
      }
      const known = {
        epoch: record.epoch,
        at: record.at,
        holder: record.holder,
        principal: record.principal,
        session: record.session,
        ...record.ended ? { ended: record.ended } : {}
      };
      if (record.ended) this.records.set(record.name, known);
      else {
        this.leases.set(record.name, { ...known, renewed: this.host.mono() });
        this.records.set(record.name, known);
        this.tenure.present(this.doc, record.name, HUB_ORIGIN);
      }
    }
    this.writeLeases();
  }
  principal(p) {
    return "local" in p ? "local" : p.id ?? `login:${p.login ?? ""}`;
  }
  owner(conn, p, name, lease) {
    if (this.host.owns && !this.host.owns(p, name)) return false;
    if (!lease?.principal || lease.principal !== this.principal(p)) return false;
    const session = this.sessions.get(conn);
    return !!session && (lease?.session ? lease.session === session : lease?.holder?.sessionId === session);
  }
  storageUnavailable() {
    const text2 = this.host.unavailable?.();
    if (text2) {
      this.unavailableSince ??= this.host.mono();
      return text2;
    }
    if (this.unavailableSince !== void 0) {
      this.unavailableSince = void 0;
      const now = this.host.mono();
      for (const lease of this.leases.values()) lease.renewed = now;
      this.maintainedAt = now;
      this.tenure = new ExpiryTenure(`inc:${this.incarnation}`, () => this.host.mono());
    }
    return void 0;
  }
  unavailable(fail) {
    const text2 = this.storageUnavailable();
    return text2 ? fail("unavailable", text2, { retryMs: 1e3 }) : void 0;
  }
  limited(key, limit) {
    const now = this.host.mono();
    const rate = this.rates.get(key);
    if (!rate || now - rate.at >= POST_RATE_WINDOW_MS) {
      if (!rate && this.rates.size >= MAX_RATE_KEYS) {
        for (const [k, v] of this.rates) if (now - v.at >= POST_RATE_WINDOW_MS) this.rates.delete(k);
        if (this.rates.size >= MAX_RATE_KEYS) {
          const oldLease = [...this.rates.keys()].find((k) => k.startsWith("lease:"));
          if (oldLease) this.rates.delete(oldLease);
        }
      }
      this.rates.set(key, { at: now, count: 1 });
      return void 0;
    }
    if (rate.count >= limit) return Math.max(1, POST_RATE_WINDOW_MS - (now - rate.at));
    rate.count++;
    return void 0;
  }
  pruneRecords() {
    if (this.records.size < MAX_RETAINED_NAMES) return;
    const ended = [...this.records].filter(([name, r]) => r.ended && !this.leases.has(name)).sort((a, b) => a[1].at - b[1].at);
    for (const [name] of ended) {
      if (this.records.size < MAX_RETAINED_NAMES) break;
      this.records.delete(name);
      this.stored.delete(name);
      this.leaseDirty = true;
      this.writeLeases();
      this.doc.doc.transact(() => {
        this.doc.participants.delete(holderKey(name));
      }, HUB_ORIGIN);
    }
  }
  prunePrincipal(principal) {
    const mine = [...this.records].filter(([, r]) => r.principal === principal);
    if (mine.length < MAX_RETAINED_NAMES_PER_PRINCIPAL) return;
    const ended = mine.filter(([name, r]) => r.ended && !this.leases.has(name)).sort((a, b) => a[1].at - b[1].at);
    for (const [name] of ended) {
      if ([...this.records.values()].filter((r) => r.principal === principal).length < MAX_RETAINED_NAMES_PER_PRINCIPAL) break;
      this.records.delete(name);
      this.stored.delete(name);
      this.leaseDirty = true;
      this.writeLeases();
      this.doc.doc.transact(() => {
        this.doc.participants.delete(holderKey(name));
      }, HUB_ORIGIN);
    }
  }
  /** The same allocation budget governs new grants and both ways of carrying a synced holder. */
  allocationFailure(name, principal, live) {
    this.prunePrincipal(principal);
    this.pruneRecords();
    if (live && [...this.leases].filter(([n]) => n !== name).length >= MAX_LEASES_PER_ROOM) return "the room has too many live leases";
    if (live && [...this.leases].filter(([n, l]) => n !== name && l.principal === principal).length >= MAX_LEASES_PER_PRINCIPAL) return "this principal has too many live leases";
    if ([...this.records].filter(([n]) => n !== name).length >= MAX_RETAINED_NAMES) return "the room has too many retained names";
    if ([...this.records].filter(([n, r]) => n !== name && r.principal === principal).length >= MAX_RETAINED_NAMES_PER_PRINCIPAL) return "this principal has too many retained names";
    return void 0;
  }
  /**
   * The name's live lease. One past its TTL, or whose process is gone, ends here; so does one inherited from
   * an earlier incarnation whose own record now says it ended (that hub's release or expiry, synced late).
   */
  live(name) {
    const lease = this.leases.get(name);
    if (!lease) return void 0;
    const expired = this.host.mono() - lease.renewed >= LEASE_TTL_MS || !!(lease.holder && this.host.holderDead?.(lease.holder));
    if (!expired) return lease;
    this.end(name, lease, "expired");
    this.notify(name, lease, "expired");
    return void 0;
  }
  end(name, lease, how) {
    this.leases.delete(name);
    const ended = { epoch: lease.epoch, at: lease.at, ...lease.holder ? { holder: lease.holder } : {}, principal: lease.principal, session: lease.session, ended: how };
    this.records.set(name, ended);
    this.remember(name, ended);
    const record = this.recordOf(ended);
    if (record) this.doc.doc.transact(() => {
      this.doc.participants.set(holderKey(name), record);
    }, HUB_ORIGIN);
    this.host.log(`hub: lease ${lease.epoch} on ${name} ${how}`);
  }
  /**
   * Take in earlier incarnations' holders (§4.4), at the start and while settling: an un-ended one above
   * what the hub knows is carried over with a fresh TTL, an ended one is remembered. The mirrors' baselines
   * rise to the highest values seen.
   */
  adoptSynced() {
    const seen = visible(this.doc);
    this.lastEpoch = higher(this.lastEpoch, seen.epoch);
    this.lastSeq = higher(this.lastSeq, seen.seq);
  }
  /** Whether `count` more values can be issued now; if not, a new incarnation is taken (§3). */
  reserve(kind, count) {
    if (this.reincarnating) return false;
    if ((kind === "epoch" ? this.epochs : this.seqs) + count <= this.limit) return true;
    this.reincarnating = this.incarnate().catch((e) => this.host.log(`hub: could not take a new incarnation: ${e instanceof Error ? e.message : e}`)).finally(() => {
      this.reincarnating = void 0;
    });
    return false;
  }
  /** The next epoch or seq, or undefined while a new incarnation is being taken. */
  issue(kind) {
    if (!this.reserve(kind, 1)) return void 0;
    const n = kind === "epoch" ? this.epochs++ : this.seqs++;
    return encodeSeq(this.incarnation, n);
  }
  /** Append a message with the next seq and the hub's `at`, mirrored in `meta.hubSeq`; undefined while reincarnating. */
  append(msg, wall) {
    const seq = this.issue("seq");
    if (seq === void 0) return void 0;
    const record = { ...msg, seq, at: wall };
    this.lastSeq = seq;
    this.doc.doc.transact(() => {
      this.doc.bus.push([record]);
      this.doc.metaMap.set("hubSeq", seq);
    }, HUB_ORIGIN);
    const keep = this.host.busKeep ?? BUS_KEEP;
    const highBytes = BUS_BYTES - MAX_MESSAGE_BYTES - 1024;
    if (this.doc.bus.length > keep + Math.max(1, Math.ceil(keep / 10)) || deliveryIndex(this.doc).bus.bytes > highBytes)
      trim(this.doc, wall, { origin: HUB_ORIGIN, busKeep: keep, busBytes: highBytes * 0.9 });
    return record;
  }
  // ---- requests ----
  handle(conn, frame, p, frameBytes) {
    const re = hubReplyId(frame);
    const fail = (reason, text2, extra = {}) => ({ v: 1, re, ok: false, reason, text: text2, ...extra });
    try {
      return this.handleSafe(conn, frame, p, fail, frameBytes);
    } catch (error) {
      this.host.log(`hub: rejected request: ${error instanceof Error ? error.message : String(error)}`);
      return fail("invalid", "invalid hub request");
    }
  }
  handleSafe(conn, frame, p, fail, frameBytes) {
    const re = isObject(frame) && typeof frame.id === "string" ? frame.id : "";
    if ((frameBytes ?? sizeOf2(frame)) > MAX_HUB_FRAME_BYTES) return fail("too-large", "hub request exceeds the frame limit");
    if (!isObject(frame) || frame.v !== 1 || !re || re.length > 128 || typeof frame.op !== "string") {
      this.host.log(`hub: invalid frame ${JSON.stringify(frame)?.slice(0, 200)}`);
      return fail("invalid", "a hub request needs v: 1, an id and an op");
    }
    const fields = {
      hello: ["proto", "schema", "client", "sessionId"],
      acquire: ["name", "holder", "supersedes"],
      renew: ["name", "epoch"],
      release: ["name", "epoch"],
      post: ["lease", "msg", "auto"]
    };
    const op = frame.op;
    if (fields[op] && Object.keys(frame).some((k) => !["v", "id", "op", ...fields[op]].includes(k))) return fail("invalid", "unknown hub request field");
    if (!this.authorized()) return fail("not-authority", "not the authority; reconnect");
    if ("readOnly" in p && p.readOnly) return fail("read-only", "this connection is read-only");
    const req = frame;
    if (req.op === "hello") return this.hello(conn, req, fail);
    if (!this.greeted.has(conn)) return fail("hello-first", "send hello first");
    const starting = () => fail("starting", "the hub is starting", { retryMs: STARTING_RETRY_MS });
    switch (req.op) {
      case "acquire":
        return this.acquire(conn, req, p, fail, starting);
      case "renew":
        return this.renew(conn, req, p, fail);
      case "release":
        return this.release(conn, req, p, fail);
      case "post":
        return this.post(conn, req, p, fail, starting);
      default:
        return fail("invalid", `unknown op ${JSON.stringify(req.op)}`);
    }
  }
  hello(conn, req, fail) {
    if (req.proto !== HUB_PROTO) {
      return fail("version", typeof req.proto === "number" && req.proto > HUB_PROTO ? `[room] this room's hub speaks protocol ${HUB_PROTO}; the hub needs updating` : `[room] this room's hub speaks protocol ${HUB_PROTO}; update Room to 0.17 or later`);
    }
    if (typeof req.sessionId !== "string" || !req.sessionId || req.sessionId.length > MAX_HOLDER_FIELD_LENGTH || typeof req.client !== "string" || req.client.length > 128 || req.schema !== 2) return fail("invalid", "hello needs a supported schema, client and session");
    this.greeted.add(conn);
    this.sessions.set(conn, req.sessionId);
    return { v: 1, re: req.id, ok: true, proto: HUB_PROTO, incarnation: this.incarnation, ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS, authority: true };
  }
  acquire(conn, req, p, fail, starting) {
    const holder = parseHolder(req.holder);
    if (!isName(req.name) || !holder || req.supersedes !== void 0 && !isCounter(req.supersedes)) return fail("invalid", "acquire needs a name and a holder");
    const { name } = req;
    if (this.host.owns && !this.host.owns(p, name)) return fail("not-yours", `${name} is not a name this login may hold`);
    const unavailable = this.unavailable(fail);
    if (unavailable) return unavailable;
    if (this.host.full?.()) return fail("room-full", "this room's document is over its size limit");
    const live = this.live(name);
    if (req.supersedes !== void 0 && this.records.get(name)?.epoch === req.supersedes && this.records.get(name)?.principal !== this.principal(p)) return fail("not-yours", `${name} belongs to another principal`);
    if (!live && this.settling()) return starting();
    if (live && live.principal !== this.principal(p)) return fail("not-yours", `${name} belongs to another principal`);
    if (live && req.supersedes !== live.epoch && (live.holder?.sessionId !== holder.sessionId || (live.session ?? live.holder?.sessionId) !== this.sessions.get(conn))) {
      return fail("held", `${name} is held by another session`, { holder: { sessionId: live.holder?.sessionId, since: live.at } });
    }
    const capacity2 = this.allocationFailure(name, this.principal(p), true);
    if (capacity2) return fail("room-full", capacity2);
    const epoch = this.issue("epoch");
    if (epoch === void 0) return starting();
    if (live) this.notify(name, live, "superseded");
    const lease = { epoch, holder, at: this.host.wall(), renewed: this.host.mono(), conn, principal: this.principal(p), session: this.sessions.get(conn) };
    this.lastEpoch = epoch;
    this.doc.doc.transact(() => {
      this.hold(name, lease);
      this.doc.participants.set(holderKey(name), this.recordOf(lease));
      this.doc.metaMap.set("hubEpoch", epoch);
    }, HUB_ORIGIN);
    this.host.log(`hub: granted ${name} to ${holder.sessionId} at epoch ${epoch}${live ? ` (superseding ${live.epoch})` : ""}`);
    return { v: 1, re: req.id, ok: true, epoch, ttlMs: LEASE_TTL_MS };
  }
  renew(conn, req, p, fail) {
    if (!isName(req.name) || !isCounter(req.epoch)) return fail("invalid", "renew needs a name and an epoch");
    const { name, epoch } = req;
    const existing = this.leases.get(name) ?? this.records.get(name);
    const denied = this.unadopted.get(name);
    if (denied?.epoch === epoch && denied.principal === this.principal(p) && denied.session === this.sessions.get(conn))
      return fail("room-full", "the stored lease exceeds this room\u2019s lease quota");
    if (this.host.owns && !this.host.owns(p, name) || existing?.epoch === epoch && !this.owner(conn, p, name, existing)) {
      return fail("not-yours", `${name} belongs to another holder session`);
    }
    const outage = this.unavailable(fail);
    if (outage) {
      const lease = this.leases.get(name);
      if (lease?.epoch !== epoch) return outage;
      lease.renewed = this.host.mono();
      lease.conn = conn;
      return { v: 1, re: req.id, ok: true, ttlMs: LEASE_TTL_MS };
    }
    const live = this.live(name);
    const ok = () => ({ v: 1, re: req.id, ok: true, ttlMs: LEASE_TTL_MS });
    if (live?.epoch === epoch) {
      if (!this.owner(conn, p, name, live)) return fail("not-yours", `${name} belongs to another holder session`);
      live.renewed = this.host.mono();
      live.conn = conn;
      return ok();
    }
    return fail("stale", `epoch ${epoch} is not the live lease on ${name}`);
  }
  release(conn, req, p, fail) {
    if (!isName(req.name) || !isCounter(req.epoch)) return fail("invalid", "release needs a name and an epoch");
    const existing = this.leases.get(req.name) ?? this.records.get(req.name);
    if (this.host.owns && !this.host.owns(p, req.name) || existing?.epoch === req.epoch && !this.owner(conn, p, req.name, existing)) {
      return fail("not-yours", `${req.name} belongs to another holder session`);
    }
    const unavailable = this.unavailable(fail);
    if (unavailable) return unavailable;
    const live = this.live(req.name);
    const known = this.records.get(req.name);
    if ((live?.epoch === req.epoch || known?.epoch === req.epoch) && !this.owner(conn, p, req.name, live ?? known)) return fail("not-yours", `${req.name} belongs to another holder session`);
    if (live?.epoch === req.epoch) this.end(req.name, live, "released");
    else if (!(known?.epoch === req.epoch && known.ended)) return fail("stale", `epoch ${req.epoch} is not the live lease on ${req.name}`);
    return { v: 1, re: req.id, ok: true };
  }
  post(conn, req, p, fail, starting) {
    const msg = req.msg;
    if (sizeOf2(msg) > MAX_MESSAGE_BYTES) return fail("too-large", `the message exceeds ${MAX_MESSAGE_BYTES / 1024} KiB`);
    if (!validMessageShape(msg) || !msg.id || !isName(msg.from) || msg.to !== void 0 && !isName(msg.to) || msg.at !== void 0 || msg.seq !== void 0 || req.auto !== void 0 && typeof req.auto !== "boolean") return fail("invalid", "post has invalid message fields");
    if (!isObject(req.lease) || Object.keys(req.lease).some((k) => k !== "name" && k !== "epoch") || !isName(req.lease.name) || !isCounter(req.lease.epoch)) return fail("invalid", "a post carries the poster's name lease");
    const existing = this.leases.get(req.lease.name) ?? this.records.get(req.lease.name);
    if (this.host.owns && !this.host.owns(p, req.lease.name) || existing?.epoch === req.lease.epoch && !this.owner(conn, p, req.lease.name, existing)) {
      return fail("not-yours", `${req.lease.name} belongs to another holder session`);
    }
    const unavailable = this.unavailable(fail);
    if (unavailable) return unavailable;
    const live = this.live(req.lease.name);
    if (live?.epoch !== req.lease.epoch) return fail("stale", `epoch ${req.lease.epoch} is not the live lease on ${req.lease.name}`);
    if (!this.owner(conn, p, req.lease.name, live)) return fail("not-yours", `${req.lease.name} belongs to another holder session`);
    const retryMs = this.limited(`lease:${req.lease.name}`, POST_RATE_PER_LEASE) ?? this.limited(`principal:${this.principal(p)}`, POST_RATE_PER_PRINCIPAL) ?? this.limited("room", POST_RATE_PER_ROOM);
    if (retryMs) return fail("rate-limited", "posting too quickly; retry shortly", { retryMs });
    const found = this.doc.message(msg.id);
    if (found) {
      const seq = found.seq;
      return { v: 1, re: req.id, ok: true, ...isCounter(seq) ? { seq } : {}, at: found.at, duplicate: true };
    }
    if (this.doc.archive.has(msg.id) || this.doc.outcomes.has(msg.id)) return { v: 1, re: req.id, ok: true, duplicate: true, gone: true };
    const size2 = sizeOf2(msg);
    if (size2 > MAX_MESSAGE_BYTES) return fail("too-large", `the message is ${Math.ceil(size2 / 1024)} KiB; the limit is ${MAX_MESSAGE_BYTES / 1024} KiB`);
    if (this.host.full?.()) return fail("room-full", "this room's document is over its size limit; close and reopen the repo, or ask the operator to raise ROOM_DOC_MAX_MB");
    const wall = this.host.wall();
    if (msg.to && !req.auto) {
      const admission = admit(this.doc, msg, wall, { origin: HUB_ORIGIN });
      if (!admission.ok) return fail("over-cap", admission.reason);
    }
    if (!isRoomNotice(msg) && this.host.owns && !this.host.owns(p, msg.from)) this.host.log(`hub: observed a post from ${JSON.stringify(msg.from)} by ${"login" in p ? p.login ?? "an anonymous connection" : "a local connection"}; accepted`);
    let priority2;
    try {
      priority2 = msg.priority ?? defaultPriority(msg);
    } catch {
      return fail("invalid", `cannot prioritise a ${msg.type} message`);
    }
    const record = this.append({ ...msg, priority: priority2 }, wall);
    if (!record) return starting();
    return { v: 1, re: req.id, ok: true, seq: record.seq, at: wall };
  }
  // ---- maintenance ----
  tick() {
    if (this.leaseWriteFailed) {
      this.leaseWriteFailed = false;
      this.writeLeases();
    }
    try {
      this.tickSafe();
    } catch (error) {
      this.host.log(`hub: maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  tickSafe() {
    if (!this.authorized()) return;
    if (this.storageUnavailable()) return;
    for (const name of [...this.leases.keys()]) this.live(name);
    if (this.settling()) return;
    if (!this.settled) {
      this.settled = true;
      this.dirty = true;
    }
    if (this.dirty) this.reassert();
    const now = this.host.mono();
    if (now - this.maintainedAt >= MAINTENANCE_MS) {
      this.maintainedAt = now;
      this.repairMailAliases();
      trim(this.doc, this.host.wall(), { origin: HUB_ORIGIN, busKeep: this.host.busKeep });
      const drift = deliveryIndex(this.doc).verify();
      if (drift) this.host.log(`hub: ledger index drift corrected (${drift})`);
      this.expire();
    }
  }
  /**
   * Re-key member mail held under a key other than its message id, a state the hub never writes (it keeps the
   * index's certainty guard on). Decided from one snapshot, grouped by embedded id, so an alias key that names
   * another message's id can't lose either message. Per id the survivor is the legacy winner: the first owed
   * copy in mail order, else the first copy, unless the bus holds an owed copy (non-owed canonical mail would
   * stop trim moving it to mail). Canonical mail+bus pairs are left as they are.
   */
  repairMailAliases() {
    const entries = [...this.doc.mail.entries()].filter(([, m]) => validMessageShape(m));
    const aliased = entries.filter(([key, m]) => key !== m.id);
    if (!aliased.length) return;
    const owedCopy = (m) => !!m.to && !(m.from === m.to && m.fromKind !== "human") && !this.doc.outcomes.has(m.id) && !this.doc.seen(m.to).has(m.id);
    const ids = new Set(aliased.map(([, m]) => m.id));
    const keys3 = /* @__PURE__ */ new Set([...aliased.map(([key]) => key), ...ids]);
    const copies = /* @__PURE__ */ new Map();
    for (const [, m] of entries) if (ids.has(m.id)) {
      const list = copies.get(m.id);
      if (list) list.push(m);
      else copies.set(m.id, [m]);
    }
    const target = /* @__PURE__ */ new Map();
    for (const [id2, list] of copies) {
      const winner = list.find(owedCopy);
      const busOwed = [...deliveryIndex(this.doc).bus.ids.get(id2)?.values() ?? []].some((x) => validMessageShape(x) && owedCopy(x));
      if (winner || !busOwed) target.set(id2, winner ?? list[0]);
    }
    this.doc.doc.transact(() => {
      for (const key of keys3) {
        const want = target.get(key);
        if (!want) {
          if (this.doc.mail.has(key)) this.doc.mail.delete(key);
        } else if (this.doc.mail.get(key) !== want) this.doc.mail.set(key, want);
      }
    }, HUB_ORIGIN);
  }
  /** Rewrite hub-owned values a stale replica won back (§4.4). */
  reassert() {
    this.dirty = false;
    const { doc } = this;
    const archived = (id2) => doc.archive.has(id2) || doc.outcomes.has(id2);
    doc.doc.transact(() => {
      const names = new Set(this.records.keys());
      for (const [key, value2] of doc.participants.entries()) if (key.endsWith(HOLDER) && hubHolder(value2)) names.add(key.slice(0, -HOLDER.length));
      for (const name of names) {
        const current = this.record(name);
        let known = this.records.get(name);
        if (!known) {
          if (current && !current.ended)
            doc.participants.set(holderKey(name), { ...current, ended: "expired" });
          continue;
        }
        const want = this.recordOf(known);
        if (want) {
          if (!sameRecord(current, want)) doc.participants.set(holderKey(name), want);
        }
      }
      const meta = doc.metaMap;
      if (meta.get("hubIncarnation") !== this.incarnation) meta.set("hubIncarnation", this.incarnation);
      if (this.lastEpoch !== void 0 && meta.get("hubEpoch") !== this.lastEpoch) meta.set("hubEpoch", this.lastEpoch);
      if (this.lastSeq !== void 0 && meta.get("hubSeq") !== this.lastSeq) meta.set("hubSeq", this.lastSeq);
      const index = deliveryIndex(doc).bus;
      const changed = new Set(index.changed);
      index.changed.clear();
      if (![...changed].some((id2) => index.count(id2) > 1 || index.count(id2) && archived(id2))) return;
      const seen = /* @__PURE__ */ new Set();
      const drop = [];
      doc.bus.toArray().forEach((m, i) => {
        const id2 = m?.id;
        if (typeof id2 !== "string") return;
        if (seen.has(id2) || archived(id2)) drop.push(i);
        seen.add(id2);
      });
      for (const i of drop.reverse()) doc.bus.delete(i, 1);
    }, HUB_ORIGIN);
  }
  /**
   * Measure absence as "no live lease" and expire at ROOM_STALE_DAYS (§8). An expired participant's claims
   * are released with sequenced notices, so a pass runs only when every claim could get a seq.
   */
  expire() {
    if (!this.reserve("seq", Math.min(this.doc.claims.size, this.limit))) return;
    const view = [];
    for (const key of this.doc.participants.keys()) {
      if (!key.endsWith(HOLDER)) continue;
      const name = key.slice(0, -HOLDER.length);
      view.push({ name, fresh: !!this.live(name), visible: true });
    }
    const wall = this.host.wall();
    const post = (from2, body) => this.append({ ...body, priority: body.priority ?? defaultPriority(body), id: newId("m_"), from: from2.name, fromKind: from2.kind }, wall);
    for (const name of this.tenure.observe(this.doc, view, HUB_ORIGIN, post)) {
      this.host.log(`hub: expired ${name}: no lease for the room's stale period`);
      const lease = this.leases.get(name);
      if (lease) {
        this.end(name, lease, "expired");
        this.notify(name, lease, "expired-participant");
      }
      this.records.delete(name);
      this.stored.delete(name);
      this.leaseDirty = true;
      this.writeLeases();
    }
  }
};

// packages/hub-core/src/doc-cap.ts
init_decoding();
var MESSAGE_SYNC = 0;
var SYNC_STEP2 = 1;
var SYNC_UPDATE = 2;
var DOC_SIZE_CAP_CODE = 4413;
function sizeCapReason(maxBytes) {
  return `room is over its size cap (${(maxBytes / 1048576).toFixed(0)} MB)`;
}
function isWriteMessage(buf) {
  try {
    const d = createDecoder(buf);
    if (readVarUint(d) !== MESSAGE_SYNC) return false;
    const sub = readVarUint(d);
    return sub === SYNC_STEP2 || sub === SYNC_UPDATE;
  } catch {
    return true;
  }
}
function insertsNothing(update) {
  try {
    const d = createDecoder(update);
    if (readVarUint(d) !== 0) return false;
    for (let clients = readVarUint(d); clients > 0; clients--) {
      readVarUint(d);
      for (let ranges = readVarUint(d); ranges > 0; ranges--) {
        readVarUint(d);
        readVarUint(d);
      }
    }
    return !hasContent(d);
  } catch {
    return false;
  }
}
var NON_GROWING_MAX_DECODE_BYTES = 4 * 1048576;
function nonGrowingWrite(buf) {
  try {
    const d = createDecoder(buf);
    readVarUint(d);
    readVarUint(d);
    const update = readVarUint8Array(d);
    return !hasContent(d) && insertsNothing(update);
  } catch {
    return false;
  }
}
function sizeCapRefusal(buf, sizeBytes, maxBytes, o = {}) {
  if (!isWriteMessage(buf)) return void 0;
  const size2 = sizeBytes(buf.byteLength);
  if (size2 <= maxBytes) return void 0;
  if (o.allowNonGrowing && buf.byteLength <= (o.maxDecodeBytes ?? NON_GROWING_MAX_DECODE_BYTES) && nonGrowingWrite(buf)) return void 0;
  return size2;
}
var DocSizeMeter = class {
  constructor(measure, o = {}) {
    this.measure = measure;
    this.maxAgeMs = o.maxAgeMs ?? 3e4;
    this.maxWrites = o.maxWrites ?? 200;
    this.maxBytes = o.maxBytes ?? 8 * 1048576;
    this.now = o.now ?? Date.now;
  }
  measure;
  cached;
  writes = 0;
  received = 0;
  maxAgeMs;
  maxWrites;
  maxBytes;
  now;
  /** Size of the document as of the last measurement, counting this write message towards the next one. */
  size(messageBytes = 0) {
    const c = this.cached;
    const stale = !c || this.now() - c.at >= this.maxAgeMs || this.writes >= this.maxWrites || this.received >= this.maxBytes;
    if (stale) {
      const bytes = this.measure();
      this.cached = { at: this.now(), bytes };
      this.writes = 0;
      this.received = 0;
    }
    this.writes++;
    this.received += messageBytes;
    return this.cached.bytes;
  }
};

// packages/hub-core/src/http.ts
var HttpFailure = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
};
function safeUrl(target) {
  if (!target || !target.startsWith("/") || target.startsWith("//") || /[\x00-\x1f\x7f]/.test(target)) throw new HttpFailure(400, "Bad Request");
  try {
    return new URL(target, "http://x");
  } catch {
    throw new HttpFailure(400, "Bad Request");
  }
}

// packages/hub-core/src/incarnation-file.ts
function incarnationFile(file, io) {
  return serializedStore({
    read: async () => {
      try {
        const record = JSON.parse(await io.read(file));
        if (record === null && io.nullIsMissing) return void 0;
        const max2 = record.max;
        return typeof max2 === "number" ? max2 : void 0;
      } catch (e) {
        if (e.code === "ENOENT") return void 0;
        throw e;
      }
    },
    write: async (max2) => {
      await io.write(file, { max: max2 });
    }
  });
}

// packages/relay/src/hub.ts
import fs5 from "node:fs";
import path6 from "node:path";
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";

// packages/relay/src/leases.ts
import fs4 from "node:fs";
import path5 from "node:path";
import { createHash, randomUUID } from "node:crypto";

// packages/relay/src/private-state.ts
import fs2 from "node:fs";
import path2 from "node:path";
import { execFile, execFileSync } from "node:child_process";

// packages/relay/src/private-core.ts
import fs from "node:fs";
import path from "node:path";
function privateDirectoryPath(dir) {
  dir = path.resolve(dir);
  const directories = [dir];
  let root = dir;
  while (path.basename(root) !== "room" && path.dirname(root) !== root) {
    root = path.dirname(root);
    directories.unshift(root);
    if (directories.length > 64) throw new Error(`Room state directory path is too deep: ${dir}`);
  }
  return { directories, root, inState: path.basename(root) === "room" };
}
function verifyPosixPath(file, stat = fs.lstatSync(file)) {
  if (stat.isSymbolicLink() || !process.getuid || stat.uid !== process.getuid() || (stat.mode & 63) !== 0) {
    throw new Error(`Room state must be owned by the current user and private: ${file}`);
  }
}
function initializePrivateDirectory(dir, repair) {
  let created = false;
  try {
    fs.mkdirSync(dir, { mode: 448 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Room state path must be a directory, not a symlink or junction: ${dir}`);
  if (process.platform === "win32") return;
  if (!process.getuid || stat.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`);
  if (created || repair && (stat.mode & 511) !== 448) {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`);
      fs.fchmodSync(fd, 448);
    } finally {
      fs.closeSync(fd);
    }
    if (!created) console.error(`Room repaired private state directory: ${dir}`);
  }
  verifyPosixPath(dir);
}

// packages/relay/src/private-state.ts
function checkWindowsAcl(report, file) {
  const allowed = /* @__PURE__ */ new Set([report.user, "S-1-5-18", "S-1-5-32-544"]);
  if (report.owner !== report.user && report.owner !== "S-1-5-32-544" || report.directory !== false && !report.protected || report.grants.some((sid) => !allowed.has(sid))) {
    throw new Error(`Room state is not private: ${file}; owner ${report.owner}; offending grants ${report.grants.filter((sid) => !allowed.has(sid)).join(", ") || "none"}; DACL must be protected and access restricted to the current user, SYSTEM and Administrators. Use a private local clone, remove broad inherited grants and protect its Room state DACL, then retry`);
  }
}
var verifiedWindows = /* @__PURE__ */ new Map();
var windowsKey = (file) => path2.resolve(file).toLowerCase();
function windowsIdentity(file) {
  try {
    const stat = fs2.lstatSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return void 0;
  }
}
function windowsPowerShellEnv(file) {
  const env = {};
  for (const [key, value2] of Object.entries(process.env)) if (key.toLowerCase() !== "psmodulepath") env[key] = value2;
  env.ROOM_PRIVATE_PATH = file;
  return env;
}
function windowsAclScript(protectNew, createDirectory, repair) {
  return `$ErrorActionPreference='Stop'; $p=$env:ROOM_PRIVATE_PATH; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $trusted=@($u.Value,'S-1-5-18','S-1-5-32-544');
    function IsDir($path) { ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -ne 0 };
    function ReadAcl($path) { if (IsDir $path) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) } };
    # Room's own writers remove files concurrently (atomic-write temporaries, retired records). A descendant that
    # vanished during the walk has no access to protect; any other failure still fails the walk. Absence must be
    # reported as not-found by a throwing probe: Exists() also answers false when access is denied.
    function NotFound($e) { while ($e) { if ($e -is [IO.FileNotFoundException] -or $e -is [IO.DirectoryNotFoundException]) { return $true }; $e=$e.InnerException }; $false };
    function Vanished($path, $err) { if (NotFound $err.Exception) { return $true }; try { [IO.File]::GetAttributes($path) | Out-Null; $false } catch { NotFound $_.Exception } };
    function Entries($dir) { try { @([IO.Directory]::EnumerateFileSystemEntries($dir)) } catch { if (Vanished $dir $_) { @() } else { throw } } };
    function WriteAcl($path, $acl) { if (IsDir $path) { [IO.Directory]::SetAccessControl($path, $acl) } else { [IO.File]::SetAccessControl($path, $acl) } };
    function Rules($acl) { @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) };
    function Grants($acl) { @(Rules $acl | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Value}) };
    function PrivateAcl($directory) {
      if ($directory) { $acl=[Security.AccessControl.DirectorySecurity]::new(); $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
      else { $acl=[Security.AccessControl.FileSecurity]::new(); $inherit=[Security.AccessControl.InheritanceFlags]::None };
      $acl.SetOwner($u); $acl.SetAccessRuleProtection($true,$false);
      foreach ($sid in $trusted) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl',$inherit,'None','Allow'))
      }; return $acl
    };
    $created=$false; $repaired=$false;
    ${createDirectory ? "if (!([IO.Directory]::Exists($p) -or [IO.File]::Exists($p))) { [IO.Directory]::CreateDirectory($p,(PrivateAcl $true)) | Out-Null; $created=$true };" : ""}
    if ([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) { throw 'Room state must not be a reparse point' };
    $isDir=IsDir $p;
    $a=ReadAcl $p; $g=Grants $a;
    $o=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;
    # An elevated administrator's new directories are owned by BUILTIN\\Administrators (Windows Server default); that
    # user can already rewrite the ACL, so the repair may take ownership back for them.
    $elevated=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
    $owned=($o -eq $u.Value) -or ($o -eq 'S-1-5-32-544' -and $elevated);
    $broad=@($g | Where-Object {$_ -notin $trusted});
    ${repair ? `$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';
    $inheritable=@(Rules $a | Where-Object {
      $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -eq $u.Value -and
      ($_.InheritanceFlags -band $inherit) -eq $inherit -and $_.PropagationFlags -eq 'None' -and
      ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl
    }).Count -gt 0;` : ""}
    ${repair ? `# Count and reject reparse points before the root ACL can propagate through an oversized subtree.
    $pending=[System.Collections.Generic.Stack[string]]::new(); $pending.Push($p);
    $children=[System.Collections.Generic.List[string]]::new();
    while ($pending.Count -gt 0) {
      foreach ($child in (Entries $pending.Pop())) {
        if ($children.Count -ge 20000) { throw "Room state subtree exceeds the 20000 entry inspection limit: $p (at $child)" };
        try { $attributes=[IO.File]::GetAttributes($child) } catch { if (Vanished $child $_) { continue } else { throw } };
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Room state must not be a symlink or junction: $child" };
        $children.Add($child);
        if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($child) }
      }
    };` : ""}
    ${protectNew || repair ? `if ($owned -and (${protectNew ? "$true" : "!$a.AreAccessRulesProtected -or $broad.Count -gt 0 -or !$inheritable"})) {
      WriteAcl $p (PrivateAcl $isDir); $repaired=!$created;
      ${repair ? "$inheritable=$true;" : ""}
      $a=ReadAcl $p; $g=Grants $a
    };` : ""}
    ${repair ? `# Establish inheritance for the whole existing subtree before caching this root. Never follow reparse points.
    if (!$inheritable -or !$a.AreAccessRulesProtected -or @($g | Where-Object {$_ -notin $trusted}).Count -gt 0 -or
        $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($u.Value,'S-1-5-32-544')) { throw "Room state is not private: $p" };
    $icacls=[IO.Path]::Combine($env:SystemRoot, 'System32', 'icacls.exe');
    foreach ($child in $children) {
      try {
        if ([IO.File]::GetAttributes($child) -band [IO.FileAttributes]::ReparsePoint) { throw "Room state must not be a symlink or junction: $child" };
        $childAcl=ReadAcl $child; $rules=Rules $childAcl;
        # A foreign owner can rewrite its own DACL later, whatever the parent grants: refuse it outright.
        $childOwner=$childAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
        if ($childOwner -ne $u.Value -and !($childOwner -eq 'S-1-5-32-544' -and $elevated)) { throw "Room state is owned by $childOwner : $child" };
        $explicitBroad=@($rules | Where-Object {!$_.IsInherited -and $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $trusted});
        if ($childAcl.AreAccessRulesProtected -or @($rules | Where-Object {$_.IsInherited}).Count -eq 0 -or $explicitBroad.Count -gt 0) {
          # icacls /reset re-enables inheritance and removes every explicit entry. Writing back an ACL that was
          # read with its inherited entries would persist those entries as explicit ones.
          & $icacls $child /reset /q | Out-Null;
          if ($LASTEXITCODE -ne 0) { throw "Cannot reset Room state ACL ($LASTEXITCODE): $child" };
          $childAcl=ReadAcl $child; $rules=Rules $childAcl
        };
        if ($childAcl.AreAccessRulesProtected -or @($rules | Where-Object {$_.IsInherited}).Count -eq 0 -or
            @($rules | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $trusted}).Count -gt 0) { throw "Room state descendant is not private: $child" };
      } catch { if (Vanished $child $_) { continue } else { throw } }
    };` : ""}
    # SIDs and booleans only, so the report is built without ConvertTo-Json.
    $bool={ param($v) if ($v) { 'true' } else { 'false' } };
    '{"owner":"' + $a.GetOwner([Security.Principal.SecurityIdentifier]).Value + '","user":"' + $u.Value + '","protected":' + (& $bool $a.AreAccessRulesProtected) +
      ',"directory":' + (& $bool $isDir) + ',"repaired":' + (& $bool $repaired) + ',"grants":[' + ((@($g) | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']}'`;
}
function windowsAclError(file, error) {
  const e = error;
  const cause = e.code === "ETIMEDOUT" || e.signal ? "PowerShell timed out" : (String(e.stderr ?? "").trim().split(/\r?\n/).find(Boolean) ?? e.message).slice(0, 300);
  return new Error(`Cannot verify the Windows owner/DACL for ${file} (${cause}); use a private local state directory and permit bounded ACL inspection, then retry`);
}
function rememberWindowsAcl(file, output, repair) {
  let report;
  try {
    report = JSON.parse(output);
  } catch (error) {
    throw windowsAclError(file, error);
  }
  if (!report || !Array.isArray(report.grants) || typeof report.user !== "string") throw new Error(`Invalid Windows ACL inspection for ${file}`);
  checkWindowsAcl(report, file);
  if (repair && report.repaired) console.error(`Room repaired private state directory: ${file}`);
  const identity = windowsIdentity(file);
  if (identity) verifiedWindows.set(windowsKey(file), { identity, subtree: repair });
}
function windowsVerified(file, subtree = false) {
  const known = verifiedWindows.get(windowsKey(file));
  return !!known && (!subtree || known.subtree) && known.identity === windowsIdentity(file);
}
function windowsAcl(file, protectNew = false, createDirectory = false, repair = false) {
  if (!protectNew && windowsVerified(file, repair)) return;
  let output;
  try {
    output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsAclScript(protectNew, createDirectory, repair)], { env: windowsPowerShellEnv(file), timeout: 2e4, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw windowsAclError(file, error);
  }
  rememberWindowsAcl(file, output, repair);
}
var primingWindows = /* @__PURE__ */ new Map();
function primeWindowsDirectory(dir, repair) {
  if (process.platform !== "win32") return Promise.resolve();
  dir = path2.resolve(dir);
  const key = windowsKey(dir);
  const running = primingWindows.get(key);
  if (running) return running;
  if (windowsVerified(dir, repair)) return Promise.resolve();
  const work = (async () => {
    if (!fs2.statSync(path2.dirname(dir)).isDirectory()) throw new Error(`Room state parent must be a directory: ${dir}`);
    const output = await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsAclScript(false, true, repair)],
        { env: windowsPowerShellEnv(dir), timeout: 2e4, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8" },
        (error, stdout, stderr2) => error ? reject(windowsAclError(dir, Object.assign(error, { stderr: stderr2 }))) : resolve(stdout)
      );
    });
    rememberWindowsAcl(dir, output, repair);
  })().finally(() => {
    if (primingWindows.get(key) === work) primingWindows.delete(key);
  });
  primingWindows.set(key, work);
  return work;
}
function primePrivateState(commonDir) {
  return primeWindowsDirectory(path2.join(commonDir, "room"), true);
}
function verifyPrivatePath(file, created = false) {
  const stat = fs2.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`Room state path must not be a symlink: ${file}`);
  if (process.platform === "win32") {
    if (underVerifiedRoomRoot(file)) return;
    windowsAcl(file, created);
    return;
  }
  verifyPosixPath(file, stat);
}
function underVerifiedRoomRoot(file) {
  let dir = path2.resolve(file);
  while (path2.basename(dir).toLowerCase() !== "room" && path2.dirname(dir) !== dir) dir = path2.dirname(dir);
  if (path2.basename(dir).toLowerCase() !== "room" || path2.resolve(file) === dir) return false;
  const known = verifiedWindows.get(windowsKey(dir));
  return !!known?.subtree && known.identity === windowsIdentity(dir);
}
function privateStateDirectory(dir) {
  dir = path2.resolve(dir);
  const { directories, root, inState } = privateDirectoryPath(dir);
  if (!fs2.statSync(path2.dirname(inState ? root : dir)).isDirectory()) throw new Error(`Room state parent must be a directory: ${dir}`);
  for (const directory of inState ? directories : [dir]) {
    if (process.platform === "win32" && (!inState || directory === root)) {
      if (fs2.existsSync(directory)) {
        const stat = fs2.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Room state path must be a directory, not a symlink or junction: ${directory}`);
      }
      windowsAcl(directory, false, true, inState);
    } else initializePrivateDirectory(directory, inState);
  }
}

// packages/relay/src/windows-process-core.ts
import path3 from "node:path";
function windowsProcessName(name) {
  return path3.win32.basename(name).toLowerCase().replace(/\.exe$/, "");
}
function parseWindowsProcessTable(output) {
  const table = /* @__PURE__ */ new Map();
  let parsed;
  try {
    parsed = JSON.parse(output.replace(/^\uFEFF/, "").trim());
  } catch {
    return table;
  }
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!row || typeof row !== "object") continue;
    const { pid, ppid, creationDate, name } = row;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    let startTime;
    if (typeof creationDate === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(creationDate)) {
      const millis = Date.parse(creationDate);
      if (Number.isFinite(millis) && new Date(millis).toISOString() === creationDate.slice(0, 23) + "Z") startTime = `windows:${creationDate}`;
    }
    const executable = typeof name === "string" && name ? windowsProcessName(name) || void 0 : void 0;
    table.set(pid, { ppid, startTime, executable });
  }
  return table;
}
function windowsProcessCommand(pid) {
  if (pid !== void 0 && (!Number.isSafeInteger(pid) || pid <= 0)) return void 0;
  const filter = pid === void 0 ? "" : ` WHERE ProcessId = ${pid}`;
  const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $searcher = [wmisearcher]'SELECT ProcessId, ParentProcessId, CreationDate, Name FROM Win32_Process${filter}'; $rows = foreach ($p in $searcher.Get()) { $c = if ($p.CreationDate) { '"' + [Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) + '"' } else { 'null' }; $n = [regex]::Replace(([string]$p.Name).Replace('\\', '\\\\').Replace('"', '\\"'), '[\\x00-\\x1f]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value }); '{"pid":' + [int]$p.ProcessId + ',"ppid":' + [int]$p.ParentProcessId + ',"creationDate":' + $c + ',"name":"' + $n + '"}' }; '[' + ($rows -join ',') + ']'`;
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

// packages/relay/src/process.ts
import { execFile as execFile2, execFileSync as execFileSync2 } from "node:child_process";
import fs3 from "node:fs";
import path4 from "node:path";
function validPid(pid) {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= 2147483647;
}
function pidAlive(pid) {
  if (!validPid(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}
var systemProcessReaders = {
  platform: process.platform,
  readFile: (file) => fs3.readFileSync(file, "utf8"),
  readLink: (file) => fs3.readlinkSync(file),
  exec: (file, args3, options) => execFileSync2(file, args3, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3e3,
    ...options,
    ...file === "ps" ? { env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" } } : {}
  }),
  execAsync: (file, args3, options, done) => {
    execFile2(file, args3, { encoding: "utf8", windowsHide: true, ...options }, (error, stdout) => done(error, stdout));
  }
};
function readWindowsProcessTable(readers, pid, timeout = 3e3) {
  const args3 = windowsProcessCommand(pid);
  return args3 ? parseWindowsProcessTable(readers.exec("powershell.exe", args3, { timeout, maxBuffer: WINDOWS_MAX_BUFFER })) : /* @__PURE__ */ new Map();
}
var WINDOWS_SYNC_READ_MS = 1e4;
var WINDOWS_ASYNC_READ_MS = 15e3;
var WINDOWS_MAX_BUFFER = 8 * 1024 * 1024;
var WINDOWS_MAX_IN_FLIGHT = 4;
function sameStartTime(a, b) {
  if (a === b) return true;
  const x = /^darwin:(\d+):(\d+)$/.exec(a), y = /^darwin:(\d+):(\d+)$/.exec(b);
  return !!x && !!y && x[2] === y[2] && Math.abs(Number(x[1]) - Number(y[1])) <= 60;
}
function parsePsLstartUtc(line) {
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(line.trim());
  if (!match) return void 0;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[1]);
  const seconds = Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1e3;
  return Number.isInteger(seconds) ? seconds : void 0;
}
function linuxProcessName(files) {
  const read2 = (file) => {
    try {
      return file();
    } catch {
      return void 0;
    }
  };
  let name = read2(files.comm)?.replace(/\n$/, "") || void 0;
  if (!name || name.length >= 15) {
    const argv0 = read2(files.cmdline)?.split("\0")[0];
    const invoked = argv0 ? path4.basename(argv0) : void 0;
    if (invoked && (!name || invoked.startsWith(name))) name = invoked;
  }
  if (name && !/^\d+(?:\.\d+)+/.test(name)) return name;
  const exe = read2(files.exe)?.replace(/ \(deleted\)$/, "");
  if (exe && /[\\/]claude[\\/]versions[\\/][^\\/]+$/.test(exe)) return "claude";
  return name ?? (exe ? path4.basename(exe) : void 0);
}
function probeProcess(pid, readers) {
  return readers ? probeUncached(pid, readers) : systemProbe(pid);
}
function probeUncached(pid, readers, boottime = () => readers.exec("sysctl", ["-n", "kern.boottime"])) {
  if (!validPid(pid)) return {};
  const unreadable = () => pidAlive(pid) ? {} : void 0;
  try {
    if (readers.platform === "linux") {
      const stat = readers.readFile(`/proc/${pid}/stat`);
      const close = stat.lastIndexOf(")");
      if (close < 0) return unreadable();
      const startTicks = stat.slice(close + 1).trim().split(/\s+/)[19];
      if (!/^\d+$/.test(startTicks ?? "")) return unreadable();
      const bootId = readers.readFile("/proc/sys/kernel/random/boot_id").trim();
      if (!bootId) return unreadable();
      const executable = linuxProcessName({
        comm: () => readers.readFile(`/proc/${pid}/comm`),
        cmdline: () => readers.readFile(`/proc/${pid}/cmdline`),
        exe: () => readers.readLink(`/proc/${pid}/exe`)
      });
      return { startTime: `linux:${bootId}:${startTicks}`, executable };
    }
    if (readers.platform === "win32") {
      const info = readWindowsProcessTable(readers, pid, WINDOWS_SYNC_READ_MS).get(pid);
      return info ? { startTime: info.startTime, executable: info.executable } : unreadable();
    }
    if (readers.platform === "darwin") {
      const lstart = readers.exec("ps", ["-o", "lstart=", "-p", String(pid)]).trim();
      const startSeconds2 = parsePsLstartUtc(lstart);
      if (startSeconds2 === void 0) return unreadable();
      const boot = boottime().match(/sec\s*=\s*(\d+)/)?.[1];
      if (!boot) return unreadable();
      let executable;
      try {
        executable = path4.basename(readers.exec("ps", ["-o", "comm=", "-p", String(pid)]).trim());
      } catch {
      }
      return { startTime: `darwin:${boot}:${startSeconds2}`, executable };
    }
  } catch {
  }
  return unreadable();
}
var PROBE_TTL_MS = 2e3;
var YOUNG_TTL_MS = 250;
var SETTLED_AFTER_S = 5;
var BOOTTIME_TTL_MS = 6e4;
var CONFIRMED_TTL_MS = 6e4;
var startSeconds = (startTime) => startTime?.startsWith("windows:") ? Date.parse(startTime.slice("windows:".length)) / 1e3 : Number(/^darwin:\d+:(\d+)$/.exec(startTime ?? "")?.[1]);
var agrees = (info, recorded) => (!info.startTime || !recorded.startTime || sameStartTime(info.startTime, recorded.startTime)) && (!info.executable || !recorded.executable || info.executable === recorded.executable);
function createProcessProbe(readers, options = {}) {
  if (readers.platform !== "darwin" && readers.platform !== "win32") {
    const read3 = (pid) => probeUncached(pid, readers);
    return Object.assign(read3, { confirm: read3, fresh: read3, read: async (pid) => read3(pid) });
  }
  const now = options.now ?? (() => performance.now()), wall = options.wall ?? Date.now, alive = readers.alive ?? pidAlive;
  const cache = /* @__PURE__ */ new Map();
  let reads = 0;
  const confirmed = /* @__PURE__ */ new Map();
  let boot;
  const boottime = () => {
    if (!boot || now() - boot.at >= BOOTTIME_TTL_MS) boot = { text: readers.exec("sysctl", ["-n", "kern.boottime"]), at: now() };
    return boot.text;
  };
  const store = (pid, info, read3) => {
    const started = startSeconds(info?.startTime);
    if (info && (readers.platform === "win32" || info.executable && Number.isFinite(started))) {
      if (cache.size >= 1024) cache.clear();
      cache.set(pid, { info, read: read3, until: now() + (info.executable && Number.isFinite(started) && wall() / 1e3 - started >= SETTLED_AFTER_S ? PROBE_TTL_MS : YOUNG_TTL_MS) });
    } else cache.delete(pid);
    return info;
  };
  const fresh = (pid) => {
    const read3 = ++reads;
    return store(pid, probeUncached(pid, readers, boottime), read3);
  };
  const inFlight = /* @__PURE__ */ new Map();
  const readInBackground = (pid) => {
    const pending = inFlight.get(pid);
    if (pending) return pending;
    const args3 = windowsProcessCommand(pid);
    if (!args3 || !readers.execAsync || inFlight.size >= WINDOWS_MAX_IN_FLIGHT) return Promise.resolve({});
    const started = ++reads, execAsync = readers.execAsync;
    let settled = false;
    const read3 = new Promise((resolve) => {
      const done = (error, stdout) => {
        if (settled) return;
        settled = true;
        inFlight.delete(pid);
        const row = error ? void 0 : parseWindowsProcessTable(stdout).get(pid);
        const info = row ? { startTime: row.startTime, executable: row.executable } : alive(pid) ? {} : void 0;
        const current = cache.get(pid);
        resolve(current && current.read > started ? current.info : store(pid, info, started));
      };
      try {
        execAsync("powershell.exe", args3, { timeout: WINDOWS_ASYNC_READ_MS, maxBuffer: WINDOWS_MAX_BUFFER }, done);
      } catch (error) {
        done(error, "");
      }
    });
    if (!settled) inFlight.set(pid, read3);
    return read3;
  };
  const probe = (pid) => {
    const hit = cache.get(pid);
    if (!validPid(pid)) return {};
    if (!alive(pid)) {
      cache.delete(pid);
      return void 0;
    }
    if (hit && now() < hit.until) return hit.info;
    if (readers.platform !== "win32") return fresh(pid);
    void readInBackground(pid);
    return { pending: true };
  };
  const read2 = async (pid) => {
    const info = probe(pid);
    return info?.pending ? readInBackground(pid) : info;
  };
  const confirm = (pid, recorded) => {
    if (!validPid(pid)) return {};
    if (!alive(pid)) return void 0;
    const key = `${pid}\0${recorded.startTime ?? ""}\0${recorded.executable ?? ""}`;
    const hit = confirmed.get(key);
    if (hit && now() < hit.until) return hit.info;
    const info = fresh(pid);
    if (info && !agrees(info, recorded) && wall() / 1e3 - startSeconds(info.startTime) >= SETTLED_AFTER_S) {
      if (confirmed.size >= 1024) confirmed.clear();
      confirmed.set(key, { info, until: now() + CONFIRMED_TTL_MS });
    } else confirmed.delete(key);
    return info;
  };
  return Object.assign(probe, { confirm, fresh, read: read2 });
}
var systemProbe = createProcessProbe(systemProcessReaders);
var ownIdentity;
var ownRead = false;
function probeOwnProcess() {
  if (ownIdentity?.startTime && ownIdentity.executable) return ownIdentity;
  const info = ownRead ? systemProbe(process.pid) : systemProbe.fresh(process.pid);
  ownRead = true;
  if (info?.startTime && info.executable) ownIdentity = info;
  return info?.pending ? {} : info;
}
function probeProcessConfirm(pid, recorded) {
  return systemProbe.confirm(pid, recorded);
}

// packages/relay/src/leases.ts
function liveness(identity, probe = probeProcess) {
  const verdict = livenessBy(identity, probe);
  return verdict === "dead" && probe === probeProcess && pidAlive(identity.pid) ? livenessBy(identity, (pid) => probeProcessConfirm(pid, identity)) : verdict;
}
function livenessBy(identity, probe) {
  if (!validPid(identity.pid)) return "unknown";
  const observed = probe(identity.pid);
  if (!observed) return "dead";
  if (observed.startTime && identity.startTime && !sameStartTime(observed.startTime, identity.startTime)) return "dead";
  if (observed.executable && identity.executable && observed.executable !== identity.executable) return "dead";
  if (!observed.startTime || !observed.executable || !identity.startTime || !identity.executable) return "unknown";
  return "alive";
}
function syncDirectory(dir) {
  let fd;
  try {
    fd = fs4.openSync(dir, "r");
    fs4.fsyncSync(fd);
  } catch (e) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(e.code ?? "")) throw e;
  } finally {
    if (fd !== void 0) fs4.closeSync(fd);
  }
}
function ensureDurableDirectory(dir, holdsFile = true) {
  const parent = path5.dirname(dir);
  if (parent === dir) {
    if (!fs4.statSync(dir).isDirectory()) throw Object.assign(new Error(`Not a directory: ${dir}`), { code: "ENOTDIR" });
    return;
  }
  ensureDurableDirectory(parent, false);
  try {
    if (process.platform === "win32" && !holdsFile) fs4.mkdirSync(dir);
    else if (!fs4.existsSync(dir)) privateStateDirectory(dir);
    else fs4.mkdirSync(dir, { mode: 448 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  syncDirectory(parent);
}
var startMarker = (startTime) => createHash("sha256").update(startTime).digest("hex").slice(0, 24);
var tempPattern = /\.roomtmp-p(\d+)-s([a-f0-9]{24}|u)-n[0-9a-f-]{36}\.tmp$/;
function cleanupOrphanTemps(dir, probe = probeProcess) {
  let removed = 0;
  for (const name of fs4.readdirSync(dir)) {
    const match = tempPattern.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!validPid(pid)) continue;
    const observed = probe(pid);
    if (observed && (match[2] === "u" || !observed.startTime || startMarker(observed.startTime) === match[2])) continue;
    if (pidAlive(pid)) continue;
    try {
      fs4.unlinkSync(path5.join(dir, name));
      removed++;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (removed) syncDirectory(dir);
  return removed;
}
function writeTemp(file, content) {
  const dir = path5.dirname(file);
  ensureDurableDirectory(dir);
  cleanupOrphanTemps(dir);
  const start = probeOwnProcess()?.startTime;
  const temp = `${file}.roomtmp-p${process.pid}-s${start ? startMarker(start) : "u"}-n${randomUUID()}.tmp`;
  const fd = fs4.openSync(temp, "wx", 384);
  try {
    fs4.writeFileSync(fd, JSON.stringify(content) + "\n");
    fs4.fsyncSync(fd);
  } catch (e) {
    fs4.closeSync(fd);
    fs4.rmSync(temp, { force: true });
    syncDirectory(dir);
    throw e;
  }
  fs4.closeSync(fd);
  return temp;
}
function createExclusive(file, content) {
  const temp = writeTemp(file, content);
  try {
    try {
      fs4.linkSync(temp, file);
    } catch (e) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
    syncDirectory(path5.dirname(file));
    return true;
  } finally {
    fs4.rmSync(temp, { force: true });
    syncDirectory(path5.dirname(file));
  }
}
function writeAtomic(file, content) {
  const temp = writeTemp(file, content);
  try {
    renameAtomic(temp, file);
    syncDirectory(path5.dirname(file));
  } finally {
    fs4.rmSync(temp, { force: true });
    syncDirectory(path5.dirname(file));
  }
}
function renameAtomic(temp, file) {
  const until = performance.now() + 2e3;
  let sleeper;
  let attempts = 0;
  for (; ; ) {
    try {
      fs4.renameSync(temp, file);
      return;
    } catch (error) {
      const remaining = until - performance.now();
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code ?? "") || remaining <= 0) throw error;
      const delay = Math.min(remaining, Math.min(100, ++attempts * 10) + Math.random() * 10);
      Atomics.wait(sleeper ??= new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}
function read(file) {
  try {
    return JSON.parse(fs4.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return void 0;
    throw e;
  }
}
function leaseToken(value2) {
  const candidate = value2.holder ?? value2;
  return candidate && typeof candidate.pid === "number" && typeof candidate.startTime === "string" && typeof candidate.executable === "string" && typeof candidate.sessionId === "string" && typeof candidate.nonce === "string" ? candidate : void 0;
}
function ownToken() {
  const current = probeOwnProcess();
  return { pid: process.pid, startTime: current?.startTime ?? "", executable: current?.executable ?? "", sessionId: `mcp:${process.pid}:${current?.startTime ?? "unknown"}`, nonce: randomUUID() };
}
function acquireGuard(file, probe, depth = 0) {
  if (depth > 12) throw new Error(`too many stale lease guards at ${file}`);
  const token = ownToken();
  if (createExclusive(file, token)) return token;
  const previous = read(file);
  const previousHolder = previous && leaseToken(previous);
  if (!previousHolder || liveness(previousHolder, probe) !== "dead") throw new Error(`lease guard busy: ${file}`);
  const outer = acquireGuard(`${file}.guard`, probe, depth + 1);
  try {
    const latest = read(file);
    const latestHolder = latest && leaseToken(latest);
    if (latestHolder && liveness(latestHolder, probe) === "dead") {
      fs4.unlinkSync(file);
      syncDirectory(path5.dirname(file));
    }
  } finally {
    releaseGuard(`${file}.guard`, outer);
  }
  if (createExclusive(file, token)) return token;
  throw new Error(`lease guard busy: ${file}`);
}
function releaseGuard(file, token) {
  const current = read(file);
  if (current && leaseToken(current)?.nonce === token.nonce) {
    fs4.unlinkSync(file);
    syncDirectory(path5.dirname(file));
  }
}
function withGuard(file, fn, probe = probeProcess) {
  const guard = `${file}.guard`;
  const token = acquireGuard(guard, probe);
  try {
    const result = fn();
    if (result && typeof result.then === "function") throw new TypeError("lease guard callback must be synchronous");
    return result;
  } finally {
    releaseGuard(guard, token);
  }
}
function compareAndRelease(file, token) {
  return withGuard(file, () => {
    const current = read(file);
    if (!current || leaseToken(current)?.nonce !== token.nonce) return false;
    fs4.unlinkSync(file);
    syncDirectory(path5.dirname(file));
    return true;
  });
}
function recover(file, orphan, probe = probeProcess) {
  return withGuard(file, () => {
    const current = read(file);
    const owner = current && leaseToken(current);
    if (!current || !owner || liveness(owner, probe) !== "dead" || !orphan(current)) return false;
    fs4.unlinkSync(file);
    syncDirectory(path5.dirname(file));
    return true;
  });
}

// packages/relay/src/hub.ts
var hubDir = (commonDir) => path6.join(commonDir, "room", "hub");
function readJson(file) {
  try {
    return JSON.parse(fs5.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return void 0;
    throw e;
  }
}
var AuthorityLock = class _AuthorityLock {
  constructor(file, token) {
    this.file = file;
    this.token = token;
  }
  file;
  token;
  /** Take the lock, recovering it from a dead holder; undefined while a live (or unknown) process holds it. */
  static take(commonDir) {
    const file = path6.join(hubDir(commonDir), "authority.lock");
    const own = probeOwnProcess();
    const token = { pid: process.pid, startTime: own?.startTime ?? "", executable: own?.executable ?? "", sessionId: `relay:${process.pid}`, nonce: randomUUID2() };
    if (createExclusive(file, token)) return new _AuthorityLock(file, token);
    try {
      if (recover(file, () => true) && createExclusive(file, token)) return new _AuthorityLock(file, token);
    } catch {
    }
    return void 0;
  }
  /** The lock file still carries this lock's token (nonce included). */
  held() {
    try {
      return readJson(this.file)?.nonce === this.token.nonce;
    } catch {
      return false;
    }
  }
  release() {
    try {
      compareAndRelease(this.file, this.token);
    } catch {
    }
  }
};
function incarnationFile2(commonDir) {
  const file = path6.join(hubDir(commonDir), "incarnation.json");
  return incarnationFile(file, { nullIsMissing: true, read: (file2) => fs5.readFileSync(file2, "utf8"), write: writeAtomic });
}
function relayLeaseFile(commonDir, room) {
  const file = path6.join(commonDir, "room", "hub-leases", `${createHash2("sha256").update(room).digest("hex")}.json`);
  return {
    read: async () => {
      try {
        if (fs5.statSync(file).size > 2 * 1024 * 1024) throw new Error("lease file exceeds size limit");
        return JSON.parse(fs5.readFileSync(file, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") return [];
        throw e;
      }
    },
    write: async (leases) => {
      writeAtomic(file, leases);
    }
  };
}
var PROBE_CACHE_MS = 5e3;
function holderDeadCheck(now = Date.now) {
  const cache = /* @__PURE__ */ new Map();
  return (h) => {
    if (!pidAlive(h.pid)) return true;
    const key = `${h.pid}\0${h.startTime}\0${h.executable}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < PROBE_CACHE_MS) return hit.dead;
    const dead = liveness(h) === "dead";
    cache.set(key, { at: now(), dead });
    if (cache.size > 256) {
      for (const [k, v] of cache) if (now() - v.at >= PROBE_CACHE_MS) cache.delete(k);
    }
    return dead;
  };
}

// packages/relay/src/proof.ts
import crypto from "node:crypto";
import http from "node:http";
var PROOF_WINDOW_MS = 3e4;
var REPLAY_CACHE_MAX = 1e4;
var prefix = "room-relay-v1\0";
function mac(key, message) {
  return crypto.createHmac("sha256", key).update(prefix + message).digest("hex");
}
function sameProof(a, b) {
  if (typeof a !== "string" || !/^[a-f0-9]{64}$/.test(a)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function relayProof(key, nonce, port) {
  return mac(key, `relay\0${nonce}\0${port}`);
}
function relayMetadataProof(key, nonce, port, health) {
  const { proof: _proof, metadataProof: _metadata, ...metadata } = health;
  return mac(key, `metadata\0${nonce}\0${port}\0${JSON.stringify(metadata)}`);
}
function localViewKey(key, room) {
  return mac(key, `view\0${room}`);
}
function viewTicketProof(viewKey, room, ts, nonce) {
  return mac(viewKey, `ticket\0${room}\0${ts}\0${nonce}`);
}
function localProofHeader(key, method, path12, port, ts = Date.now(), nonce = crypto.randomBytes(16).toString("hex")) {
  return `Room-Proof ${ts}.${nonce}.${mac(key, `client\0${method.toUpperCase()}\0${path12}\0${port}\0${ts}\0${nonce}`)}`;
}
var ProofVerifier = class {
  constructor(key, port, now = Date.now) {
    this.key = key;
    this.port = port;
    this.now = now;
  }
  key;
  port;
  now;
  seen = /* @__PURE__ */ new Map();
  verify(header, method, path12) {
    if (typeof header !== "string") return false;
    const match = /^Room-Proof (\d{13})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(header);
    if (!match) return false;
    const [, rawTs, nonce, proof] = match;
    const ts = Number(rawTs), now = this.now();
    if (Math.abs(ts - now) > PROOF_WINDOW_MS) return false;
    for (const [n, expiry] of this.seen) if (expiry <= now) this.seen.delete(n);
    if (this.seen.has(nonce) || this.seen.size >= REPLAY_CACHE_MAX) return false;
    const expected = mac(this.key, `client\0${method.toUpperCase()}\0${path12}\0${this.port}\0${ts}\0${nonce}`);
    if (!sameProof(proof, expected)) return false;
    this.seen.set(nonce, now + PROOF_WINDOW_MS);
    return true;
  }
};
async function relayIdentity(port, key, timeoutMs = 800) {
  const probe = await relayIdentityProbe(port, key, timeoutMs);
  return probe.timedOut ? void 0 : probe.identity;
}
var HEALTH_MAX_BYTES = 2048;
async function relayIdentityProbe(port, key, timeoutMs = 800) {
  const nonce = crypto.randomBytes(16).toString("hex");
  return new Promise((done) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      done(result);
    };
    const answer = (identity) => finish({ identity, timedOut: false });
    const deadline = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: timeoutMs, headers: { "x-room-nonce": nonce } }, (res) => {
      const chunks = [];
      let length2 = 0;
      res.on("data", (chunk) => {
        length2 += chunk.length;
        if (length2 > HEALTH_MAX_BYTES) answer(void 0);
        else chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const health = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode !== 200 || !health || typeof health !== "object") {
            answer(void 0);
            return;
          }
          answer({ health, proven: sameProof(health.proof, relayProof(key, nonce, port)) && (health.runtime !== "daemon" || sameProof(health.metadataProof, relayMetadataProof(key, nonce, port, health))) });
        } catch {
          answer(void 0);
        }
      });
      res.on("aborted", () => answer(void 0));
      res.on("error", () => answer(void 0));
      res.on("close", () => answer(void 0));
    });
    req.on("timeout", () => finish({ timedOut: true }));
    req.on("error", () => answer(void 0));
    req.on("close", () => answer(void 0));
  });
}
async function relayHealth(port, key, timeoutMs = 800) {
  const identity = await relayIdentity(port, key, timeoutMs);
  return identity?.proven ? identity.health : void 0;
}

// packages/relay/src/memory.ts
import fs6 from "node:fs";
import path7 from "node:path";
import crypto2 from "node:crypto";
init_yjs();
var stderr = (line) => {
  process.stderr.write(`${line}
`);
};
var mb = (bytes) => (bytes / 1048576).toFixed(1);
var WARN_EVERY_MS = 6e4;
var WARN_KEYS_MAX = 64;
var WarningLimiter = class {
  constructor(now = Date.now) {
    this.now = now;
  }
  now;
  // Insertion order is time order: a key is re-inserted only after it expired.
  warnedAt = /* @__PURE__ */ new Map();
  get size() {
    return this.warnedAt.size;
  }
  warn(key, line, log2) {
    const now = this.now();
    for (const [old, at] of this.warnedAt) {
      if (now - at < WARN_EVERY_MS) break;
      this.warnedAt.delete(old);
    }
    if (this.warnedAt.has(key)) return;
    this.warnedAt.set(key, now);
    if (this.warnedAt.size > WARN_KEYS_MAX) this.warnedAt.delete(this.warnedAt.keys().next().value);
    log2(line());
  }
  clear() {
    this.warnedAt.clear();
  }
};
var sharedWarnings = new WarningLimiter();
function largestRoots(update) {
  const doc = new Doc();
  try {
    applyUpdate(doc, update);
    return [...memoryTypes(doc, true)].map(([name, kind]) => [name, JSON.stringify(kind === "array" ? doc.getArray(name).toJSON() : doc.getMap(name).toJSON()).length]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, size2]) => `${name} ${mb(size2)} MB`).join(", ");
  } finally {
    doc.destroy();
  }
}
function memoryFile(commonDir, room) {
  return path7.join(commonDir, "room", "relay", `${encodeURIComponent(room)}.ydoc`);
}
function syncDirectory2(dir) {
  let fd;
  try {
    fd = fs6.openSync(dir, "r");
    fs6.fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code ?? "")) throw error;
  } finally {
    if (fd !== void 0) fs6.closeSync(fd);
  }
}
var MemoryLoadError = class extends Error {
  constructor(state, file, cause) {
    super(`local room memory ${state}: ${file}: ${cause instanceof Error ? cause.message : String(cause)}; preserve the snapshot and repair it before retrying`);
    this.state = state;
    this.file = file;
    this.name = "MemoryLoadError";
  }
  state;
  file;
};
function loadMemory(commonDir, room, log2 = stderr) {
  const file = memoryFile(commonDir, room);
  let bytes;
  try {
    if (fs6.statSync(file).size > ROOM_DOC_MAX_BYTES) throw new MemoryLoadError("capacity", file, "snapshot exceeds load ceiling");
    if (process.platform === "win32") verifyPrivatePath(file);
    bytes = fs6.readFileSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return new Doc();
    const error = e instanceof MemoryLoadError ? e : new MemoryLoadError("unreadable", file, e);
    log2(error.message);
    throw error;
  }
  const doc = new Doc();
  try {
    applyUpdate(doc, bytes);
    const schema = doc.getMap("meta").get("schemaVersion");
    if (schema !== void 0 && schema !== 2) throw new Error("unsupported snapshot schema");
    return doc;
  } catch (e) {
    doc.destroy();
    const error = new MemoryLoadError("invalid", file, e);
    log2(error.message);
    throw error;
  }
}
function saveMemory(commonDir, room, doc, log2 = stderr, warnings = sharedWarnings) {
  return writeMemory(commonDir, room, doc, log2, warnings) === void 0;
}
function writeMemory(commonDir, room, doc, log2, warnings, failure, generation) {
  const file = memoryFile(commonDir, room);
  const temp = `${file}.${process.pid}-${crypto2.randomBytes(6).toString("hex")}.tmp`;
  try {
    let shed = false;
    let update = memorySnapshot(doc, { onShed: () => {
      shed = true;
    }, maxBytes: MAX_MEMORY_BYTES, log: (line) => warnings.warn(`${file}\0shed`, () => `local room memory: ${room}: ${line}`, log2) });
    if (generation !== void 0 && shed) return "snapshot would shed content";
    if (generation !== void 0) {
      const copy2 = new Doc();
      try {
        applyUpdate(copy2, update);
        copy2.getMap("meta").set("generation", generation);
        update = encodeStateAsUpdate(copy2);
      } finally {
        copy2.destroy();
      }
    }
    if (update.byteLength > ROOM_DOC_MAX_BYTES) {
      const cause = `snapshot is ${mb(update.byteLength)} MB, over the ${ROOM_DOC_MAX_BYTES / 1048576} MB ceiling`;
      warnings.warn(`${file}\0over`, () => `local room memory: skipping ${room}: ${cause}; keeping the last good file`, log2);
      failure?.("capacity", cause);
      return cause;
    }
    if (update.byteLength > MAX_MEMORY_BYTES) {
      warnings.warn(`${file}\0over`, () => `local room memory: ${room}: snapshot is ${mb(update.byteLength)} MB after dropping everything droppable (largest roots: ${largestRoots(update)}); saved anyway; target ${MAX_MEMORY_BYTES / 1048576} MB`, log2);
    }
    privateStateDirectory(path7.dirname(file));
    fs6.chmodSync(path7.dirname(file), 448);
    const fd = fs6.openSync(temp, "wx", 384);
    try {
      fs6.writeFileSync(fd, update);
      fs6.fsyncSync(fd);
    } finally {
      fs6.closeSync(fd);
    }
    if (process.platform === "win32") verifyPrivatePath(temp, true);
    fs6.renameSync(temp, file);
    syncDirectory2(path7.dirname(file));
    return void 0;
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    failure?.("io", cause);
    if (generation === void 0) warnings.warn(`${file}\0io`, () => `local room memory: cannot save ${file}: ${e}; keeping the replica and retrying`, log2);
    return cause;
  } finally {
    try {
      fs6.unlinkSync(temp);
    } catch {
    }
  }
}
var RoomMemory = class {
  constructor(commonDir, room, log2 = stderr) {
    this.commonDir = commonDir;
    this.room = room;
    this.log = log2;
    this.doc = loadMemory(commonDir, room, log2);
    this.doc.on("update", this.schedule);
  }
  commonDir;
  room;
  log;
  state = { dirtyGeneration: 0, savedGeneration: 0 };
  get status() {
    return { ...this.state };
  }
  retry;
  retryDelay = 1e3;
  doc;
  debounce;
  deadline;
  forgotten = false;
  reconciling = false;
  warnings = new WarningLimiter();
  schedule = () => {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      this.doc.transact(() => {
        for (const name of ["bus", "retiredWorkers"]) {
          if (!this.doc.share.has(name)) continue;
          const array = this.doc.getArray(name), seen = /* @__PURE__ */ new Set();
          const duplicates = [];
          array.toArray().forEach((value2, index) => {
            if (!value2 || typeof value2 !== "object") return;
            const key = name === "bus" ? typeof value2.id === "string" ? value2.id : void 0 : typeof value2.name === "string" && typeof value2.startedAt === "number" && typeof value2.lead === "string" ? JSON.stringify([value2.name, value2.startedAt, value2.lead]) : void 0;
            if (key === void 0) return;
            if (seen.has(key)) duplicates.push(index);
            else seen.add(key);
          });
          for (const index of duplicates.reverse()) array.delete(index);
        }
      });
    } finally {
      this.reconciling = false;
    }
    if (this.forgotten) return;
    this.state.dirtyGeneration++;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.flush(), 2e3);
    this.deadline ??= setTimeout(() => this.flush(), 1e4);
    this.debounce.unref?.();
    this.deadline.unref?.();
  };
  flush() {
    this.save();
  }
  /** Save now; returns why the snapshot was not saved, or undefined (also once forgotten: nothing is owed). */
  save(generation) {
    if (generation !== void 0) {
      clearTimeout(this.retry);
      this.retry = void 0;
    }
    clearTimeout(this.debounce);
    clearTimeout(this.deadline);
    this.debounce = this.deadline = void 0;
    if (this.forgotten) return void 0;
    const cause = writeMemory(this.commonDir, this.room, this.doc, this.log, this.warnings, (kind, why) => {
      this.state[kind] = why;
    }, generation);
    if (cause === void 0) {
      this.state.savedGeneration = this.state.dirtyGeneration;
      this.state.lastSavedAt = Date.now();
      delete this.state.capacity;
      delete this.state.io;
      clearTimeout(this.retry);
      this.retry = void 0;
      this.retryDelay = 1e3;
    } else if (generation === void 0 && !this.retry) {
      this.retry = setTimeout(() => {
        this.retry = void 0;
        this.save();
      }, this.retryDelay);
      this.retry.unref?.();
      this.retryDelay = Math.min(6e4, this.retryDelay * 2);
    }
    if (generation !== void 0 && cause !== void 0) {
      this.log(`local room memory: planned compaction save failed for ${this.room}: ${cause}; exiting without reopening`);
    }
    return cause;
  }
  /** Compute the real budgeted snapshot before committing to a generation change. */
  canCompact() {
    let shed = false;
    memorySnapshot(this.doc, { onShed: () => {
      shed = true;
    } });
    return !shed;
  }
  /** Stop saving on updates. Call only after a final save() succeeded, or the room's latest state is lost. */
  detach() {
    clearTimeout(this.retry);
    clearTimeout(this.debounce);
    clearTimeout(this.deadline);
    this.doc.off("update", this.schedule);
    this.warnings.clear();
  }
  forget() {
    fs6.rmSync(memoryFile(this.commonDir, this.room), { force: true });
    this.forgotten = true;
    clearTimeout(this.retry);
    this.retry = void 0;
    delete this.state.capacity;
    delete this.state.io;
    clearTimeout(this.debounce);
    clearTimeout(this.deadline);
    this.doc.transact(() => {
      for (const [name, kind] of memoryTypes(this.doc, true)) {
        if (kind === "map") this.doc.getMap(name).clear();
        else {
          const array = this.doc.getArray(name);
          array.delete(0, array.length);
        }
      }
    });
  }
  /** Final save, then detach. Rejects with FinalSaveError, still attached, if the save keeps failing. */
  async close(delays = FINAL_SAVE_RETRY_MS) {
    await finalSave(() => [this], delays);
    this.detach();
  }
};
var FINAL_SAVE_RETRY_MS = [100, 200, 400, 800, 1500];
var FinalSaveError = class extends Error {
  constructor(causes) {
    super(causes.join("; "));
    this.causes = causes;
    this.name = "FinalSaveError";
  }
  causes;
};
async function finalSave(memories, delays = FINAL_SAVE_RETRY_MS, generation) {
  if (generation !== void 0) {
    for (const memory of memories()) memory.save(generation);
    return;
  }
  for (let attempt = 0; ; attempt++) {
    const causes = memories().map((m) => m.save(generation)).filter((cause) => cause !== void 0);
    if (!causes.length) return;
    if (attempt >= delays.length) throw new FinalSaveError([...new Set(causes)]);
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
}

// packages/relay/src/local-migrate.ts
init_yjs();
import crypto3 from "node:crypto";
import fs7 from "node:fs";
import path8 from "node:path";
var empty2 = () => ({ messages: [], claims: [], scopes: [], scopeSnapshots: {}, sources: {}, messageSources: {}, identities: {}, complete: false });
var ledgerFile = (common, room) => path8.join(common, "room", "relay", `migrated-${crypto3.createHash("sha256").update(room).digest("hex").slice(0, 16)}.json`);
var legacyDir = (common) => path8.join(common, "room-local");
function oldRunning(common, probe) {
  try {
    const info = JSON.parse(fs7.readFileSync(path8.join(common, "room-local.json"), "utf8"));
    const observed = probe(info.pid);
    if (!observed) return false;
    if (info.startTime && observed.startTime && !sameStartTime(info.startTime, observed.startTime)) return false;
    if (info.executable && observed.executable && info.executable !== observed.executable) return false;
    return true;
  } catch {
    return false;
  }
}
function readLedger(common, room) {
  const scoped = ledgerFile(common, room);
  let file = scoped;
  if (!fs7.existsSync(scoped)) {
    const old = path8.join(common, "room", "relay", "migrated.json");
    try {
      const candidate = JSON.parse(fs7.readFileSync(old, "utf8"));
      const names = Object.keys(candidate.sources ?? {});
      if (names.length && names.every((name) => name === room || name.startsWith(`${room}/`))) file = old;
    } catch {
    }
  }
  let value2;
  try {
    value2 = JSON.parse(fs7.readFileSync(file, "utf8"));
  } catch {
    return empty2();
  }
  const ledger2 = { messages: value2.messages ?? [], claims: value2.claims ?? [], scopes: value2.scopes ?? [], scopeSnapshots: value2.scopeSnapshots ?? {}, sources: value2.sources ?? {}, messageSources: value2.messageSources ?? {}, identities: value2.identities ?? {}, complete: !!value2.complete };
  if (file !== scoped) writeLedger(common, room, ledger2);
  return ledger2;
}
function writeLedger(common, room, ledger2) {
  const file = ledgerFile(common, room), temp = `${file}.${process.pid}-${crypto3.randomBytes(4).toString("hex")}.tmp`;
  privateStateDirectory(path8.dirname(file));
  try {
    fs7.writeFileSync(temp, JSON.stringify(ledger2) + "\n", { flag: "wx", mode: 384 });
    fs7.renameSync(temp, file);
  } finally {
    fs7.rmSync(temp, { force: true });
  }
}
var DEFAULT_LIMITS = { fileBytes: ROOM_DOC_MAX_BYTES, files: 64, totalBytes: 2 * ROOM_DOC_MAX_BYTES };
var SUMMARIES_MAX = 1024;
var SUMMARY_NAMES_MAX = 1e4;
var summaries = /* @__PURE__ */ new Map();
function remember(key, revision, persons) {
  summaries.delete(key);
  if (persons.length > SUMMARY_NAMES_MAX) return;
  summaries.set(key, { revision, persons });
  if (summaries.size > SUMMARIES_MAX) summaries.delete(summaries.keys().next().value);
}
function personsOf(source) {
  const persons = /* @__PURE__ */ new Set();
  const add = (person) => {
    if (person) persons.add(person);
  };
  for (const person of source.scopes.keys()) add(person);
  for (const claim of source.claims.values()) add(claim.by);
  for (const person of source.overlays.keys()) add(person);
  for (const person of source.legacyDeleted.keys()) add(person);
  for (const msg of [...source.bus.toArray(), ...source.mail.values()]) {
    if (!isRoomNotice(msg)) add(msg.from);
    add(msg.to);
  }
  return [...persons];
}
function sources(common, room) {
  try {
    return fs7.readdirSync(legacyDir(common)).filter((file) => file.endsWith(".ydoc")).flatMap((file) => {
      let name;
      try {
        name = decodeURIComponent(file.slice(0, -5));
      } catch {
        throw new Error(`invalid legacy snapshot name: ${file}`);
      }
      if (name !== room && !name.startsWith(`${room}/`)) return [];
      const full2 = path8.join(legacyDir(common), file);
      const stat = fs7.statSync(full2);
      return [{ file: full2, name, mtime: stat.mtimeMs, size: stat.size, revision: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` }];
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
function catchUpLocal(common, room, targetDoc, log2 = console.error, probe = probeProcess, limits = DEFAULT_LIMITS) {
  let files;
  try {
    files = sources(common, room);
  } catch (error) {
    log2(`local migration: cannot enumerate ${legacyDir(common)}: ${String(error)}`);
    new RoomDoc(targetDoc).metaMap.set("localMigrating", 1);
    if (!saveMemory(common, room, targetDoc, log2)) throw new Error("local migration could not save the new room snapshot");
    return true;
  }
  const running = oldRunning(common, probe);
  const ledger2 = readLedger(common, room);
  if (ledger2.complete) return false;
  if (!files.length && !running) return false;
  const decoded = [];
  try {
    return catchUpDecoded(common, room, targetDoc, log2, limits, files, running, ledger2, decoded);
  } finally {
    for (const doc of decoded) doc.destroy();
  }
}
function catchUpDecoded(common, room, targetDoc, log2, limits, files, running, ledger2, decoded) {
  const target = new RoomDoc(targetDoc);
  const messages = new Set(ledger2.messages), claims = new Set(ledger2.claims), scopes = new Set(ledger2.scopes);
  const existing = /* @__PURE__ */ new Set([...target.bus.toArray().map((m) => m.id), ...target.mail.keys()]);
  const noticeKey = (m) => `${m.type}\0${m.to ?? ""}\0${JSON.stringify(m.text ?? null)}`;
  const notices = new Set([...target.bus.toArray(), ...target.mail.values()].filter(isRoomNotice).map(noticeKey));
  const occurrences = new Map(Object.entries(ledger2.identities).map(([person, names]) => [person, new Set(names)]));
  const mark = (person, source) => {
    if (!person) return;
    let names = occurrences.get(person);
    if (!names) {
      names = /* @__PURE__ */ new Set();
      occurrences.set(person, names);
    }
    names.add(source);
  };
  const loaded = [];
  let unreadable = false, deferred = false, decodedBytes = 0;
  for (const { file, name, mtime, size: size2, revision } of files) {
    const imported = ledger2.sources[name] === mtime;
    const key = `${common}\0${file}`;
    const summary = summaries.get(key);
    if (imported && summary?.revision === revision) {
      for (const person of summary.persons) mark(person, name);
      continue;
    }
    if (size2 > limits.fileBytes) {
      log2(`local migration: cannot read ${file}: ${size2} bytes exceeds the ${limits.fileBytes}-byte snapshot limit`);
      unreadable = true;
      continue;
    }
    if (decoded.length >= limits.files || decodedBytes + size2 > limits.totalBytes) {
      deferred = true;
      continue;
    }
    decodedBytes += size2;
    const doc = new Doc();
    decoded.push(doc);
    try {
      applyUpdate(doc, fs7.readFileSync(file));
    } catch (error) {
      log2(`local migration: cannot read ${file}: ${String(error)}`);
      unreadable = true;
      continue;
    }
    const source = new RoomDoc(doc);
    const persons = personsOf(source);
    for (const person of persons) mark(person, name);
    remember(key, revision, persons);
    if (!imported) loaded.push({ name, mtime, source });
  }
  const aliases = targetDoc.getMap("aliases");
  const placeholder = (person, source) => `?${crypto3.createHash("sha256").update(`${source}\0${person}`).digest("hex").slice(0, 16)}`;
  const translated = (person, source) => {
    const by = placeholder(person, source);
    return aliases.get(by) ?? ((occurrences.get(person)?.size ?? 0) > 1 ? by : person);
  };
  const unresolved = targetDoc.getMap("unresolved");
  let changed = false;
  let scanned = false;
  targetDoc.transact(() => {
    for (const [person, found] of occurrences) if (found.size > 1) for (const source of found) {
      const key = `${source}\0${person}`, by = placeholder(person, source);
      if (!aliases.has(by) && !unresolved.has(key)) {
        unresolved.set(key, { placeholder: by, claims: [] });
        changed = true;
      }
    }
    for (const [person, prior] of Object.entries(ledger2.identities)) {
      if (prior.length !== 1 || (occurrences.get(person)?.size ?? 0) <= 1) continue;
      const source = prior[0], by = translated(person, source), key = `${source}\0${person}`;
      const old = unresolved.get(key) ?? { placeholder: by, claims: [] };
      const moved = [...old.claims];
      for (const [id2, claim] of target.claims) {
        if (claim.by !== person || claim.origin !== source) continue;
        target.claims.delete(id2);
        if (!moved.some((item) => item.id === id2)) moved.push({ ...claim, by });
        changed = true;
      }
      const oldScope = target.scopes.get(person);
      const importedScope = !!oldScope && ledger2.scopeSnapshots[key] === JSON.stringify(oldScope);
      const scope = importedScope ? { ...oldScope, by } : old.scope;
      if (importedScope) {
        target.scopes.delete(person);
        changed = true;
      }
      for (const [id2, message] of target.mail) {
        if (ledger2.messageSources[id2] !== source || message.from !== person && message.to !== person) continue;
        target.mail.set(id2, {
          ...message,
          from: message.from === person ? by : message.from,
          ...message.to === person ? { to: by } : {}
        });
        changed = true;
      }
      if (by.startsWith("?")) {
        if (moved.length || scope) {
          unresolved.set(key, { placeholder: by, claims: moved, ...scope ? { scope } : {} });
          changed = true;
        }
      } else {
        for (const claim of moved) if (!target.claims.has(claim.id)) {
          target.claims.set(claim.id, { ...claim, by });
          changed = true;
        }
        if (scope && !target.scopes.has(by)) {
          const copy2 = { ...scope, by };
          target.scopes.set(by, copy2);
          ledger2.scopeSnapshots[key] = JSON.stringify(copy2);
          changed = true;
        }
        if (unresolved.has(key)) {
          unresolved.delete(key);
          changed = true;
        }
      }
    }
  });
  for (const { name, mtime, source } of loaded) {
    scanned = true;
    targetDoc.transact(() => {
      for (const msg of [...source.bus.toArray(), ...source.mail.values()]) {
        if (messages.has(msg.id)) continue;
        const skip = isLegacyBranchNotice(msg) || isRoomNotice(msg) && notices.has(noticeKey(msg));
        if (!existing.has(msg.id) && !skip) {
          if (isRoomNotice(msg)) notices.add(noticeKey(msg));
          const copy2 = { ...msg, from: isRoomNotice(msg) ? msg.from : translated(msg.from, name), ...msg.to ? { to: translated(msg.to, name) } : {} };
          if (msg.to) {
            if (!source.seen(msg.to).has(msg.id)) {
              target.mail.set(msg.id, copy2);
              existing.add(msg.id);
              changed = true;
            }
          } else {
            target.bus.push([copy2]);
            existing.add(msg.id);
            changed = true;
          }
        }
        messages.add(msg.id);
        ledger2.messageSources[msg.id] = name;
      }
      for (const claim of source.claims.values()) {
        if (claims.has(claim.id)) continue;
        const by = translated(claim.by, name);
        const { anchor: _anchor, ...rest } = claim;
        const copy2 = { ...rest, by, origin: name };
        if (by.startsWith("?")) {
          const key = `${name}\0${claim.by}`;
          const old = unresolved.get(key) ?? { placeholder: by, claims: [] };
          if (!old.claims.some((item) => item.id === claim.id)) {
            unresolved.set(key, { ...old, claims: [...old.claims, copy2] });
            changed = true;
          }
        } else if (!target.claims.has(claim.id)) {
          target.claims.set(claim.id, copy2);
          changed = true;
        }
        claims.add(claim.id);
      }
      for (const [person, scope] of source.scopes) {
        const key = `${name}\0${person}`;
        if (scopes.has(key)) continue;
        const by = translated(person, name);
        const copy2 = { ...scope, by, origin: name };
        if (by.startsWith("?")) {
          const old = unresolved.get(key) ?? { placeholder: by, claims: [] };
          unresolved.set(key, { ...old, scope: copy2 });
          changed = true;
        } else if (!target.scopes.has(by)) {
          target.scopes.set(by, copy2);
          ledger2.scopeSnapshots[key] = JSON.stringify(copy2);
          changed = true;
        }
        scopes.add(key);
      }
    });
    ledger2.sources[name] = mtime;
  }
  const pending = running || unreadable || deferred;
  if (target.metaMap.get("localMigrating") !== Number(pending)) {
    target.metaMap.set("localMigrating", Number(pending));
    changed = true;
  }
  const completionChanged = ledger2.complete !== !pending;
  ledger2.complete = !pending;
  if ((scanned || changed || completionChanged) && !saveMemory(common, room, targetDoc, log2)) throw new Error("local migration could not save the new room snapshot");
  ledger2.messages = [...messages];
  ledger2.claims = [...claims];
  ledger2.scopes = [...scopes];
  ledger2.identities = Object.fromEntries([...occurrences].map(([person, names]) => [person, [...names].sort()]));
  if (scanned || changed || completionChanged) writeLedger(common, room, ledger2);
  return pending;
}
function forgetLegacyLocal(common, room) {
  for (const { file } of sources(common, room)) fs7.rmSync(file, { force: true });
  fs7.rmSync(ledgerFile(common, room), { force: true });
  const old = path8.join(common, "room", "relay", "migrated.json");
  try {
    const ledger2 = JSON.parse(fs7.readFileSync(old, "utf8"));
    const names = Object.keys(ledger2.sources ?? {});
    if (names.length && names.every((name) => name === room || name.startsWith(`${room}/`))) fs7.rmSync(old, { force: true });
  } catch {
  }
}

// packages/relay/src/index.ts
import crypto5 from "node:crypto";
import fs8 from "node:fs";
import http2 from "node:http";
import path9 from "node:path";

// node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);

// packages/relay/src/index.ts
init_yjs();
init_encoding();
init_decoding();

// node_modules/y-protocols/sync.js
init_encoding();
init_decoding();
init_yjs();
var messageYjsSyncStep1 = 0;
var messageYjsSyncStep2 = 1;
var messageYjsUpdate = 2;
var writeSyncStep1 = (encoder3, doc) => {
  writeVarUint(encoder3, messageYjsSyncStep1);
  const sv = encodeStateVector(doc);
  writeVarUint8Array(encoder3, sv);
};
var writeSyncStep2 = (encoder3, doc, encodedStateVector) => {
  writeVarUint(encoder3, messageYjsSyncStep2);
  writeVarUint8Array(encoder3, encodeStateAsUpdate(doc, encodedStateVector));
};
var readSyncStep1 = (decoder, encoder3, doc) => writeSyncStep2(encoder3, doc, readVarUint8Array(decoder));
var readSyncStep2 = (decoder, doc, transactionOrigin, errorHandler) => {
  try {
    applyUpdate(doc, readVarUint8Array(decoder), transactionOrigin);
  } catch (error) {
    if (errorHandler != null) errorHandler(
      /** @type {Error} */
      error
    );
    console.error("Caught error while handling a Yjs update", error);
  }
};
var writeUpdate = (encoder3, update) => {
  writeVarUint(encoder3, messageYjsUpdate);
  writeVarUint8Array(encoder3, update);
};
var readUpdate = readSyncStep2;
var readSyncMessage = (decoder, encoder3, doc, transactionOrigin, errorHandler) => {
  const messageType = readVarUint(decoder);
  switch (messageType) {
    case messageYjsSyncStep1:
      readSyncStep1(decoder, encoder3, doc);
      break;
    case messageYjsSyncStep2:
      readSyncStep2(decoder, doc, transactionOrigin, errorHandler);
      break;
    case messageYjsUpdate:
      readUpdate(decoder, doc, transactionOrigin, errorHandler);
      break;
    default:
      throw new Error("Unknown message type");
  }
  return messageType;
};

// node_modules/y-protocols/awareness.js
init_encoding();
init_decoding();
init_time();
init_math();
init_observable();
init_function();
var outdatedTimeout = 3e4;
var Awareness = class extends Observable {
  /**
   * @param {Y.Doc} doc
   */
  constructor(doc) {
    super();
    this.doc = doc;
    this.clientID = doc.clientID;
    this.states = /* @__PURE__ */ new Map();
    this.meta = /* @__PURE__ */ new Map();
    this._checkInterval = /** @type {any} */
    setInterval(() => {
      const now = getUnixTime();
      if (this.getLocalState() !== null && outdatedTimeout / 2 <= now - /** @type {{lastUpdated:number}} */
      this.meta.get(this.clientID).lastUpdated) {
        this.setLocalState(this.getLocalState());
      }
      const remove = [];
      this.meta.forEach((meta, clientid) => {
        if (clientid !== this.clientID && outdatedTimeout <= now - meta.lastUpdated && this.states.has(clientid)) {
          remove.push(clientid);
        }
      });
      if (remove.length > 0) {
        removeAwarenessStates(this, remove, "timeout");
      }
    }, floor(outdatedTimeout / 10));
    doc.on("destroy", () => {
      this.destroy();
    });
    this.setLocalState({});
  }
  destroy() {
    this.emit("destroy", [this]);
    this.setLocalState(null);
    super.destroy();
    clearInterval(this._checkInterval);
  }
  /**
   * @return {Object<string,any>|null}
   */
  getLocalState() {
    return this.states.get(this.clientID) || null;
  }
  /**
   * @param {Object<string,any>|null} state
   */
  setLocalState(state) {
    const clientID = this.clientID;
    const currLocalMeta = this.meta.get(clientID);
    const clock = currLocalMeta === void 0 ? 0 : currLocalMeta.clock + 1;
    const prevState = this.states.get(clientID);
    if (state === null) {
      this.states.delete(clientID);
    } else {
      this.states.set(clientID, state);
    }
    this.meta.set(clientID, {
      clock,
      lastUpdated: getUnixTime()
    });
    const added = [];
    const updated = [];
    const filteredUpdated = [];
    const removed = [];
    if (state === null) {
      removed.push(clientID);
    } else if (prevState == null) {
      if (state != null) {
        added.push(clientID);
      }
    } else {
      updated.push(clientID);
      if (!equalityDeep(prevState, state)) {
        filteredUpdated.push(clientID);
      }
    }
    if (added.length > 0 || filteredUpdated.length > 0 || removed.length > 0) {
      this.emit("change", [{ added, updated: filteredUpdated, removed }, "local"]);
    }
    this.emit("update", [{ added, updated, removed }, "local"]);
  }
  /**
   * @param {string} field
   * @param {any} value
   */
  setLocalStateField(field, value2) {
    const state = this.getLocalState();
    if (state !== null) {
      this.setLocalState({
        ...state,
        [field]: value2
      });
    }
  }
  /**
   * @return {Map<number,Object<string,any>>}
   */
  getStates() {
    return this.states;
  }
};
var removeAwarenessStates = (awareness, clients, origin) => {
  const removed = [];
  for (let i = 0; i < clients.length; i++) {
    const clientID = clients[i];
    if (awareness.states.has(clientID)) {
      awareness.states.delete(clientID);
      if (clientID === awareness.clientID) {
        const curMeta = (
          /** @type {MetaClientState} */
          awareness.meta.get(clientID)
        );
        awareness.meta.set(clientID, {
          clock: curMeta.clock + 1,
          lastUpdated: getUnixTime()
        });
      }
      removed.push(clientID);
    }
  }
  if (removed.length > 0) {
    awareness.emit("change", [{ added: [], updated: [], removed }, origin]);
    awareness.emit("update", [{ added: [], updated: [], removed }, origin]);
  }
};
var encodeAwarenessUpdate = (awareness, clients, states = awareness.states) => {
  const len = clients.length;
  const encoder3 = createEncoder();
  writeVarUint(encoder3, len);
  for (let i = 0; i < len; i++) {
    const clientID = clients[i];
    const state = states.get(clientID) || null;
    const clock = (
      /** @type {MetaClientState} */
      awareness.meta.get(clientID).clock
    );
    writeVarUint(encoder3, clientID);
    writeVarUint(encoder3, clock);
    writeVarString(encoder3, JSON.stringify(state));
  }
  return toUint8Array(encoder3);
};
var applyAwarenessUpdate = (awareness, update, origin) => {
  const decoder = createDecoder(update);
  const timestamp = getUnixTime();
  const added = [];
  const updated = [];
  const filteredUpdated = [];
  const removed = [];
  const len = readVarUint(decoder);
  for (let i = 0; i < len; i++) {
    const clientID = readVarUint(decoder);
    let clock = readVarUint(decoder);
    const state = JSON.parse(readVarString(decoder));
    const clientMeta = awareness.meta.get(clientID);
    const prevState = awareness.states.get(clientID);
    const currClock = clientMeta === void 0 ? 0 : clientMeta.clock;
    if (currClock < clock || currClock === clock && state === null && awareness.states.has(clientID)) {
      if (state === null) {
        if (clientID === awareness.clientID && awareness.getLocalState() != null) {
          clock++;
        } else {
          awareness.states.delete(clientID);
        }
      } else {
        awareness.states.set(clientID, state);
      }
      awareness.meta.set(clientID, {
        clock,
        lastUpdated: timestamp
      });
      if (clientMeta === void 0 && state !== null) {
        added.push(clientID);
      } else if (clientMeta !== void 0 && state === null) {
        removed.push(clientID);
      } else if (state !== null) {
        if (!equalityDeep(state, prevState)) {
          filteredUpdated.push(clientID);
        }
        updated.push(clientID);
      }
    }
  }
  if (added.length > 0 || filteredUpdated.length > 0 || removed.length > 0) {
    awareness.emit("change", [{
      added,
      updated: filteredUpdated,
      removed
    }, origin]);
  }
  if (added.length > 0 || updated.length > 0 || removed.length > 0) {
    awareness.emit("update", [{
      added,
      updated,
      removed
    }, origin]);
  }
};

// packages/relay/src/secure.ts
import crypto4 from "node:crypto";
var MAGIC = Buffer.from("room-secure-v1");
var LABEL = Buffer.from("room-relay-v2\0relay\0");
var INFO_C2S = Buffer.from("room-relay-v2 c2s");
var INFO_S2C = Buffer.from("room-relay-v2 s2c");
var SecureSession = class {
  constructor(key, room, role) {
    this.key = key;
    this.room = room;
    this.role = role;
  }
  key;
  room;
  role;
  cn;
  sn;
  tx;
  rx;
  sent = 0n;
  received = 0n;
  get ready() {
    return !!this.tx;
  }
  clientHello(nonce = crypto4.randomBytes(16)) {
    if (this.role !== "client" || this.cn || nonce.length !== 16) throw new Error("invalid client hello");
    this.cn = Buffer.from(nonce);
    return Buffer.concat([MAGIC, this.cn]);
  }
  relayHello(frame, nonce = crypto4.randomBytes(16)) {
    if (this.role !== "relay" || this.cn || frame.length !== MAGIC.length + 16 || nonce.length !== 16 || !Buffer.from(frame.subarray(0, MAGIC.length)).equals(MAGIC)) throw new Error("invalid relay hello");
    this.cn = Buffer.from(frame.subarray(MAGIC.length));
    this.sn = Buffer.from(nonce);
    const proof = this.proof();
    this.derive();
    return Buffer.concat([MAGIC, this.sn, proof]);
  }
  acceptRelayHello(frame) {
    if (this.role !== "client" || !this.cn || this.sn || frame.length !== MAGIC.length + 48 || !Buffer.from(frame.subarray(0, MAGIC.length)).equals(MAGIC)) throw new Error("invalid relay proof");
    this.sn = Buffer.from(frame.subarray(MAGIC.length, MAGIC.length + 16));
    if (!crypto4.timingSafeEqual(Buffer.from(frame.subarray(MAGIC.length + 16)), this.proof())) throw new Error("invalid relay proof");
    this.derive();
  }
  proof() {
    return crypto4.createHmac("sha256", this.key).update(LABEL).update(this.cn).update(this.sn).update(Buffer.from([0])).update(this.room).digest();
  }
  derive() {
    const salt = Buffer.concat([this.cn, this.sn]);
    const c2s = Buffer.from(crypto4.hkdfSync("sha256", this.key, salt, INFO_C2S, 32));
    const s2c = Buffer.from(crypto4.hkdfSync("sha256", this.key, salt, INFO_S2C, 32));
    this.tx = this.role === "client" ? c2s : s2c;
    this.rx = this.role === "client" ? s2c : c2s;
  }
  iv(counter) {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(counter, 4);
    return iv;
  }
  encrypt(data) {
    if (!this.tx) throw new Error("handshake incomplete");
    const cipher = crypto4.createCipheriv("aes-256-gcm", this.tx, this.iv(this.sent++));
    return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  }
  decrypt(data) {
    if (!this.rx || data.length < 16) throw new Error("invalid encrypted frame");
    const frame = Buffer.from(data);
    const decipher = crypto4.createDecipheriv("aes-256-gcm", this.rx, this.iv(this.received));
    decipher.setAuthTag(frame.subarray(frame.length - 16));
    const plain = Buffer.concat([decipher.update(frame.subarray(0, -16)), decipher.final()]);
    this.received++;
    return plain;
  }
};

// packages/relay/src/limits.ts
var RELAY_MAX_ROOMS = 8;
var RELAY_MAX_CONNECTIONS = 200;
var RELAY_MAX_CONNECTIONS_PER_ROOM = 100;
function capacity(value2, fallback) {
  const result = value2 ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new RangeError("relay limits must be positive safe integers");
  return result;
}
var RelayAdmission = class {
  constructor(docs, options = {}) {
    this.docs = docs;
    this.maxRooms = capacity(options.maxRooms, RELAY_MAX_ROOMS);
    this.maxConnections = capacity(options.maxConnections, RELAY_MAX_CONNECTIONS);
    this.maxConnectionsPerRoom = capacity(options.maxConnectionsPerRoom, RELAY_MAX_CONNECTIONS_PER_ROOM);
  }
  docs;
  total = 0;
  rooms = /* @__PURE__ */ new Map();
  maxRooms;
  maxConnections;
  maxConnectionsPerRoom;
  refusal(name) {
    if (this.total >= this.maxConnections) return "relay connection limit reached";
    if ((this.rooms.get(name) ?? 0) >= this.maxConnectionsPerRoom) return "relay room connection limit reached";
    if (!this.docs.has(name) && !this.rooms.has(name)) {
      let count = this.docs.size;
      for (const pending of this.rooms.keys()) if (!this.docs.has(pending)) count++;
      if (count >= this.maxRooms) return "relay room limit reached";
    }
    return void 0;
  }
  /** Caller checks refusal first; reservation and upgrade are synchronous on the same event loop. */
  reserve(name) {
    this.total++;
    this.rooms.set(name, (this.rooms.get(name) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const left = this.rooms.get(name) - 1;
      if (left) this.rooms.set(name, left);
      else this.rooms.delete(name);
    };
  }
};

// packages/relay/src/awareness.ts
init_decoding();
var DEFAULTS = {
  maxMessageBytes: 64 * 1024,
  maxStateBytes: 16 * 1024,
  maxMessagesPerMinute: 6e3,
  maxIdsPerConnection: 16,
  maxIdsPerRoom: 4096
};
function awarenessLimits(options = {}) {
  return {
    maxMessageBytes: capacity(options.maxMessageBytes, DEFAULTS.maxMessageBytes),
    maxStateBytes: capacity(options.maxStateBytes, DEFAULTS.maxStateBytes),
    maxMessagesPerMinute: capacity(options.maxMessagesPerMinute, DEFAULTS.maxMessagesPerMinute),
    maxIdsPerConnection: capacity(options.maxIdsPerConnection, DEFAULTS.maxIdsPerConnection),
    maxIdsPerRoom: capacity(options.maxIdsPerRoom, DEFAULTS.maxIdsPerRoom),
    now: options.now ?? Date.now
  };
}
var TOMBSTONE_MS = 6e4;
var RelayAwarenessBudget = class {
  constructor(awareness, options = {}) {
    this.awareness = awareness;
    const resolved = awarenessLimits(options);
    this.limits = resolved;
    this.now = resolved.now;
  }
  awareness;
  limits;
  now;
  prune() {
    const states = this.awareness.getStates(), now = this.now();
    for (const [id2, record] of this.awareness.meta) {
      if (!states.has(id2) && now - record.lastUpdated >= TOMBSTONE_MS) this.awareness.meta.delete(id2);
    }
  }
  connection(close) {
    const added = /* @__PURE__ */ new Set();
    let window2 = this.now(), messages = 0, cut = false;
    const refuse = (reason) => {
      if (!cut) {
        cut = true;
        close(reason);
      }
      return false;
    };
    return (frame) => {
      if (cut) return false;
      if (this.now() - window2 >= 6e4) {
        window2 = this.now();
        messages = 0;
      }
      if (frame.byteLength > this.limits.maxMessageBytes || ++messages > this.limits.maxMessagesPerMinute) return refuse("presence budget exceeded");
      this.prune();
      const adding = /* @__PURE__ */ new Set(), fresh = /* @__PURE__ */ new Set();
      try {
        const outer = createDecoder(frame);
        readVarUint(outer);
        const inner = createDecoder(readVarUint8Array(outer));
        const count = readVarUint(inner), states = this.awareness.getStates();
        for (let i = 0; i < count; i++) {
          const id2 = readVarUint(inner), clock = readVarUint(inner), raw = readVarString(inner);
          if (Buffer.byteLength(raw) > this.limits.maxStateBytes) throw Error("presence state too large");
          const state = JSON.parse(raw), known = this.awareness.meta.get(id2);
          if (known && clock <= known.clock) continue;
          if (!known) fresh.add(id2);
          if (!added.has(id2) && (state === null ? !known : !states.has(id2))) adding.add(id2);
        }
        if (added.size + adding.size > this.limits.maxIdsPerConnection) throw Error("presence ID budget exceeded");
      } catch {
        return refuse("invalid or excessive presence");
      }
      if (this.awareness.meta.size + fresh.size > this.limits.maxIdsPerRoom) return false;
      for (const id2 of adding) added.add(id2);
      return true;
    };
  }
};

// packages/relay/src/index.ts
var MSG_SYNC = 0;
var MSG_AWARENESS = 1;
var RELAY_STATE_REQUESTS_PER_MINUTE = 10;
var RELAY_STATE_QUEUE_BYTES = 1024 * 1024;
function stateRequestLimiter(now = Date.now) {
  let started = now(), count = 0;
  return (buf, queued2) => {
    try {
      const dec = createDecoder(buf);
      const kind = readVarUint(dec);
      if (kind !== 3 && (kind !== MSG_SYNC || readVarUint(dec) !== messageYjsSyncStep1)) return true;
    } catch {
      return true;
    }
    if (now() - started >= 6e4) {
      started = now();
      count = 0;
    }
    return ++count <= RELAY_STATE_REQUESTS_PER_MINUTE && queued2 <= RELAY_STATE_QUEUE_BYTES;
  };
}
function relayDocs() {
  return /* @__PURE__ */ new Map();
}
var RELAY_SOCKET_QUEUE_BYTES = 68 * 1024 * 1024;
var RELAY_TOTAL_QUEUE_BYTES = 256 * 1024 * 1024;
var socketBudgets = /* @__PURE__ */ new WeakMap();
var sessions = /* @__PURE__ */ new WeakMap();
function boundRelayBootstrapInput(conn) {
  const receiver = conn._receiver;
  const maximum = receiver?._maxPayload;
  if (!receiver || typeof maximum !== "number" || !Number.isFinite(maximum) || maximum < 0) throw new Error("unsupported websocket receiver payload limit; update/restart Room");
  return {
    remaining: (bytes) => {
      receiver._maxPayload = Math.max(1, Math.min(maximum || Infinity, bytes));
    },
    restore: () => {
      receiver._maxPayload = maximum;
    }
  };
}
var bootstrapInputs = /* @__PURE__ */ new WeakMap();
var handshakeCleanup = /* @__PURE__ */ new WeakMap();
var failedSockets = /* @__PURE__ */ new WeakSet();
var queued = /* @__PURE__ */ new Map();
var totalQueued = 0;
var stateReservation = 0;
function dropSocket(conn) {
  totalQueued -= queued.get(conn) ?? 0;
  queued.delete(conn);
}
function full(conn) {
  conn.close(1013, "relay output queue full");
  setTimeout(() => {
    if (conn.readyState !== conn.CLOSED) conn.terminate();
  }, 1e3).unref?.();
}
function capacityFor(bytes, except) {
  if (totalQueued + stateReservation + bytes > RELAY_TOTAL_QUEUE_BYTES) {
    for (const [slow, amount] of [...queued].sort((a, b) => b[1] - a[1])) {
      if (totalQueued + stateReservation + bytes <= RELAY_TOTAL_QUEUE_BYTES) break;
      if (slow === except || amount === 0) continue;
      slow.close(1013, "relay output queue full");
      slow.terminate();
      dropSocket(slow);
    }
  }
  return totalQueued + stateReservation + bytes <= RELAY_TOTAL_QUEUE_BYTES;
}
function send(conn, buf) {
  if (conn.readyState !== conn.OPEN) return;
  const session = sessions.get(conn);
  if (!session?.ready) return;
  const bytes = buf.byteLength + 16;
  const own = queued.get(conn) ?? 0;
  if (own > 0 && own + bytes > (socketBudgets.get(conn) ?? RELAY_SOCKET_QUEUE_BYTES)) {
    full(conn);
    return;
  }
  if (!capacityFor(bytes, conn)) {
    full(conn);
    return;
  }
  try {
    const frame = session.encrypt(buf);
    queued.set(conn, own + bytes);
    totalQueued += bytes;
    conn.send(frame, (error) => {
      if (queued.has(conn)) {
        queued.set(conn, Math.max(0, (queued.get(conn) ?? 0) - bytes));
        totalQueued -= bytes;
      }
      if (error) full(conn);
    });
  } catch {
    dropSocket(conn);
    try {
      conn.close();
    } catch {
    }
  }
}
function getDoc(docs, name, opts) {
  let d = docs.get(name);
  if (d) return d;
  const memory = opts.commonDir ? new RoomMemory(opts.commonDir, decodeURIComponent(name), opts.log) : void 0;
  const doc = memory?.doc ?? new Doc({ gc: true });
  if (doc.getMap("meta").get("schemaVersion") !== 2) doc.getMap("meta").set("schemaVersion", 2);
  if (opts.commonDir) catchUpLocal(opts.commonDir, decodeURIComponent(name), doc, opts.log);
  const awareness = new Awareness(doc);
  awareness.setLocalState(null);
  const meter = new DocSizeMeter(() => encodeStateAsUpdate(doc).byteLength, opts.docCap?.meter);
  d = { doc, awareness, presence: new RelayAwarenessBudget(awareness, opts.awareness), conns: /* @__PURE__ */ new Map(), memory, cap: { maxBytes: opts.docCap?.maxBytes ?? ROOM_DOC_MAX_BYTES, meter, logged: 0 } };
  doc.on("update", (update, origin) => {
    if (origin === HUB_ORIGIN) meter.size(update.byteLength);
    const enc = createEncoder();
    writeVarUint(enc, MSG_SYNC);
    writeUpdate(enc, update);
    const buf = toUint8Array(enc);
    for (const c of d.conns.keys()) send(c, buf);
  });
  awareness.on("update", ({ added, updated, removed }, origin) => {
    const changed = [...added, ...updated, ...removed];
    if (origin && d.conns.has(origin)) {
      const ids = d.conns.get(origin);
      for (const id2 of added) ids.add(id2);
      for (const id2 of removed) ids.delete(id2);
    }
    const enc = createEncoder();
    writeVarUint(enc, MSG_AWARENESS);
    writeVarUint8Array(enc, encodeAwarenessUpdate(awareness, changed));
    const buf = toUint8Array(enc);
    for (const c of d.conns.keys()) send(c, buf);
  });
  opts.loaded?.(decodeURIComponent(name), doc);
  docs.set(name, d);
  if (opts.seed && name === encodeURIComponent(opts.seed.room)) applyUpdate(doc, opts.seed.update);
  if (opts.hub) startRoomHub(d, decodeURIComponent(name), opts.hub, opts.commonDir, opts.log ?? (() => {
  }), !!opts.daemon);
  return d;
}
function startRoomHub(d, room, rt, commonDir, log2, strict = false) {
  const roomDoc = d.room = new RoomDoc(d.doc);
  d.hubReady = startHub({
    doc: roomDoc,
    mono: rt.mono,
    wall: rt.wall,
    log: (line) => log2(`local room ${room}: ${line}`),
    store: rt.store,
    leases: relayLeaseFile(commonDir, room),
    requireLeaseLoad: strict,
    holderDead: rt.holderDead,
    authority: () => rt.lock.held(),
    full: () => !!d.memory?.status.capacity || d.cap.meter.size() > d.cap.maxBytes
  }).then((hub) => {
    if (d.closed) {
      hub.stop();
      return;
    }
    hub.onPush((conn, push) => send(conn, encodeFrame(push)));
    d.hub = hub;
  }).catch((e) => {
    d.hubError = e;
    log2(`local room ${room}: the hub could not start: ${e instanceof Error ? e.message : e}`);
  });
}
var hubBudget = new HubRequestBudget();
function hubReply(d, conn, raw, hubOn, readOnly = false) {
  const retryMs = hubBudget.take(conn);
  if (retryMs) return { v: 1, re: "", ok: false, reason: "rate-limited", text: "hub requests too frequent", retryMs };
  if (raw.byteLength > MAX_HUB_FRAME_BYTES) return { v: 1, re: "", ok: false, reason: "too-large", text: "hub request exceeds the frame limit" };
  let frame;
  try {
    frame = decodeFrame(raw);
  } catch {
    frame = void 0;
  }
  const re = hubReplyId(frame);
  if (!hubOn) return { v: 1, re, ok: false, reason: "not-authority", text: "not the authority; reconnect" };
  if (readOnly) return { v: 1, re, ok: false, reason: "read-only", text: "this connection is read-only" };
  if (!d.hub) return { v: 1, re, ok: false, reason: "starting", text: "the hub is starting", retryMs: STARTING_RETRY_MS };
  return d.hub.handle(conn, frame, { local: true }, raw.byteLength);
}
function relayRoomName(target) {
  return encodeURIComponent(decodeURIComponent((target ?? "/").slice(1).split("?")[0]));
}
function attach(docs, conn, req, opts) {
  const name = relayRoomName(req.url);
  const room = decodeURIComponent(name);
  const session = new SecureSession(opts.readOnly ? localViewKey(opts.key, room) : opts.key, room, "relay");
  sessions.set(conn, session);
  const timer = setTimeout(() => conn.close(1008, "secure handshake timeout"), 5e3);
  handshakeCleanup.set(conn, () => {
    clearTimeout(timer);
    conn.off("message", handshake);
    dropSocket(conn);
    sessions.delete(conn);
    bootstrapInputs.delete(conn);
  });
  timer.unref?.();
  let hello = false;
  const handshake = (raw, binary) => {
    try {
      if (!binary) throw new Error("binary secure frames required");
      if (!hello) {
        hello = true;
        const reply = session.relayHello(raw);
        if (!capacityFor(reply.length, conn)) {
          full(conn);
          return;
        }
        queued.set(conn, reply.length);
        totalQueued += reply.length;
        conn.send(reply, (error) => {
          if (queued.has(conn)) {
            queued.set(conn, Math.max(0, (queued.get(conn) ?? 0) - reply.length));
            totalQueued -= reply.length;
          }
          if (error) full(conn);
        });
        return;
      }
      if (safeUrl(req.url).searchParams.get("negotiate") === "1" && raw.byteLength > BOOTSTRAP_MAX_BYTES + 16) {
        clearTimeout(timer);
        conn.close(4406, "compatibility frame exceeds limit");
        return;
      }
      const first = session.decrypt(raw);
      if (opts.accepting && !opts.accepting()) {
        conn.close(1013, "local daemon draining; retry");
        return;
      }
      clearTimeout(timer);
      handshakeCleanup.delete(conn);
      conn.off("message", handshake);
      if (safeUrl(req.url).searchParams.get("negotiate") === "1") attachNegotiating(docs, conn, name, req, opts, first);
      else {
        if (!relayGeneration(conn, req, getDoc(docs, name, opts))) return;
        if (opts.daemon && !opts.readOnly) {
          conn.close(4406, "daemon lifecycle negotiation required; update Room");
          return;
        }
        const legacy = selectContract(LEGACY_COMPAT, CURRENT_COMPAT, { activeSchema: 2, readOnly: opts.readOnly });
        if (!legacy.ok) {
          conn.close(4406, "legacy contract retired; update this client");
          return;
        }
        attachReady(docs, conn, name, opts, first, req);
        conn.emit("message", first, true);
      }
    } catch {
      clearTimeout(timer);
      conn.close(1008, "invalid secure frame");
    }
  };
  conn.on("message", handshake);
  conn.on("close", () => {
    handshakeCleanup.get(conn)?.();
    handshakeCleanup.delete(conn);
    clearTimeout(timer);
    dropSocket(conn);
    sessions.delete(conn);
    bootstrapInputs.delete(conn);
  });
}
function attachNegotiating(docs, conn, name, req, opts, first) {
  let phase = "hello";
  let hello;
  let selection;
  let selectedDoc;
  let timer, expiresAt = 0, bytes = 0;
  const cleanup = () => {
    clearTimeout(timer);
    conn.off("message", receive);
    handshakeCleanup.delete(conn);
  };
  const refuse = (reason) => {
    cleanup();
    phase = "done";
    conn.close(4406, reason.slice(0, 120));
  };
  const deadline = (ms) => {
    expiresAt = Date.now() + ms;
    clearTimeout(timer);
    timer = setTimeout(() => refuse("compatibility handshake timed out; reconnect Room"), ms);
    timer.unref?.();
  };
  const current = () => (!opts.accepting || opts.accepting()) && conn.readyState === conn.OPEN && !!selectedDoc && !selectedDoc.closed && (!opts.hub || opts.hub.lock.held());
  const receivePlain = async (plain) => {
    if (opts.accepting && !opts.accepting()) {
      cleanup();
      phase = "done";
      conn.close(1013, "local daemon draining; retry");
      return;
    }
    if (Date.now() >= expiresAt) {
      refuse("compatibility handshake timed out; reconnect Room");
      return;
    }
    bytes += plain.byteLength;
    if (bytes > BOOTSTRAP_MAX_BYTES || plain[0] !== MSG_HUB) {
      refuse("compatibility hello/ack required before sync");
      return;
    }
    bootstrapInputs.get(conn).remaining(BOOTSTRAP_MAX_BYTES - bytes + 16);
    let frame;
    try {
      const decoder = createDecoder(plain);
      readVarUint(decoder);
      frame = parseBootstrapFrame(decodeFrame(decoder));
      if (hasContent(decoder)) throw new Error("trailing bootstrap bytes");
    } catch {
      refuse("invalid compatibility frame; update this client");
      return;
    }
    if (phase === "hello") {
      if (!("op" in frame) || frame.op !== "compat-hello") {
        refuse("compatibility hello required");
        return;
      }
      hello = frame;
      phase = "selecting";
      const selected = selectContract(frame.offer, opts.compat ?? CURRENT_COMPAT, { activeSchema: 2, readOnly: opts.readOnly, ...!opts.readOnly && opts.daemon ? { requiredCapabilities: { "room.daemon": [1] } } : {} });
      if (!selected.ok) {
        send(conn, encodeFrame({ v: 1, re: frame.id, ok: false, error: selected.error }));
        refuse(compatibilityDetail(selected.error));
        return;
      }
      selectedDoc = getDoc(docs, name, opts);
      await selectedDoc.hubReady;
      if (conn.readyState !== conn.OPEN) return;
      if (opts.accepting && !opts.accepting()) {
        cleanup();
        phase = "done";
        conn.close(1013, "local daemon draining; retry");
        return;
      }
      if (Date.now() >= expiresAt) {
        refuse("compatibility handshake timed out; reconnect Room");
        return;
      }
      if (opts.hub && !selectedDoc.hub) {
        cleanup();
        phase = "done";
        conn.close(1013, "relay hub unavailable; retry");
        return;
      }
      if (phase !== "selecting" || !current()) {
        refuse("relay authority changed; reconnect Room");
        return;
      }
      if (!relayGeneration(conn, req, selectedDoc)) {
        cleanup();
        phase = "done";
        return;
      }
      selection = {
        v: 1,
        re: frame.id,
        ok: true,
        selectionId: crypto5.randomBytes(16).toString("hex"),
        selection: selected.selection,
        compat: opts.compat ?? CURRENT_COMPAT,
        generation: docGeneration(selectedDoc.doc) ?? "0",
        policyRevision: 1,
        incarnation: selectedDoc.hub?.incarnation ?? 0,
        ttlMs: LEASE_TTL_MS,
        renewMs: LEASE_RENEW_MS,
        requiredCapabilities: !opts.readOnly && opts.daemon ? { "room.daemon": [1] } : {}
      };
      const encoded = encodeFrame(selection);
      if (encoded.byteLength > BOOTSTRAP_MAX_BYTES) {
        refuse("relay compatibility selection exceeds limit");
        return;
      }
      phase = "ack";
      deadline(BOOTSTRAP_ACK_TIMEOUT_MS);
      send(conn, encoded);
      return;
    }
    if (phase !== "ack" || !("op" in frame) || frame.op !== "compat-ack" || frame.selectionId !== selection?.selectionId) {
      refuse("unexpected compatibility frame; reconnect Room");
      return;
    }
    if (!current() || (docGeneration(selectedDoc.doc) ?? "0") !== selection.generation || (selectedDoc.hub?.incarnation ?? 0) !== selection.incarnation) {
      refuse("relay authority changed; reconnect Room");
      return;
    }
    if (!relayGeneration(conn, req, selectedDoc)) {
      cleanup();
      phase = "done";
      return;
    }
    if (!opts.readOnly && selectedDoc.hub) {
      const registered = selectedDoc.hub.handle(conn, legacyHello(frame.id, hello.offer.release ?? "Room", hello.sessionId), { local: true });
      if (!registered.ok) {
        cleanup();
        phase = "done";
        conn.close(1013, "relay hub session unavailable; reconnect Room");
        return;
      }
    }
    phase = "done";
    cleanup();
    bootstrapInputs.get(conn).restore();
    bootstrapInputs.delete(conn);
    send(conn, encodeFrame({ v: 1, re: frame.id, ok: true }));
    conn.emit("room-compatible");
    attachReady(docs, conn, name, opts, void 0, req, true);
  };
  const receive = (raw, binary) => {
    if (phase === "done" || conn.readyState !== conn.OPEN) return;
    try {
      if (!binary) throw new Error("binary secure frames required");
      const length2 = raw instanceof ArrayBuffer ? raw.byteLength : Array.isArray(raw) ? raw.reduce((sum, part) => sum + part.byteLength, 0) : raw.byteLength;
      if (length2 > BOOTSTRAP_MAX_BYTES + 16) {
        refuse("compatibility frame exceeds limit");
        return;
      }
      const plain = sessions.get(conn).decrypt(raw instanceof ArrayBuffer ? new Uint8Array(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw);
      void receivePlain(plain).catch(() => refuse("relay compatibility unavailable; reconnect Room"));
    } catch {
      refuse("invalid encrypted compatibility frame");
    }
  };
  handshakeCleanup.set(conn, cleanup);
  conn.on("message", receive);
  conn.once("close", cleanup);
  deadline(BOOTSTRAP_HELLO_TIMEOUT_MS);
  void receivePlain(first).catch(() => refuse("relay compatibility unavailable; reconnect Room"));
}
function relayGeneration(conn, req, d) {
  const decision = generationGate(safeUrl(req.url).searchParams.get(GENERATION_PARAM), docGeneration(d.doc));
  if (decision === "accept") return true;
  conn.close(decision === "stale" ? STALE_REPLICA_CODE : 4403, decision === "stale" ? STALE_REPLICA_REASON : COMPACTED_UPDATE_REASON);
  return false;
}
function attachReady(docs, conn, name, opts, first, req, negotiated = false) {
  if (opts.accepting && !opts.accepting()) {
    conn.close(1013, "local daemon draining; retry");
    return;
  }
  const d = getDoc(docs, name, opts);
  if (!relayGeneration(conn, req, d)) return;
  d.conns.set(conn, /* @__PURE__ */ new Set());
  opts.attached?.(conn, !!opts.readOnly);
  if (opts.socketQueueBytes) socketBudgets.set(conn, opts.socketQueueBytes);
  const allowState = stateRequestLimiter();
  const allowPresence = d.presence.connection((reason) => conn.close(4429, reason));
  conn.binaryType = "arraybuffer";
  conn.on("message", (raw) => {
    if (failedSockets.has(conn) || conn.readyState !== conn.OPEN || opts.accepting && !opts.accepting()) return;
    let buf;
    try {
      buf = raw === first ? first : sessions.get(conn).decrypt(raw instanceof ArrayBuffer ? new Uint8Array(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw);
    } catch {
      conn.close(1008, "invalid secure frame");
      return;
    }
    if (negotiated && buf[0] === MSG_HUB) {
      try {
        const frame = decodeFrame(buf);
        if (frame.op === "compat-hello" || frame.op === "compat-ack") {
          conn.close(4406, "selection is immutable; reconnect Room");
          return;
        }
      } catch {
      }
    }
    if (!allowState(buf, conn.bufferedAmount)) {
      conn.close(1013, "too many state requests");
      return;
    }
    const { cap } = d;
    const over = opts.readOnly ? void 0 : sizeCapRefusal(buf, (bytes) => d.memory?.status.capacity ? cap.maxBytes + 1 : cap.meter.size(bytes), cap.maxBytes, { allowNonGrowing: true });
    if (over !== void 0) {
      const now = Date.now();
      if (cap.logged < now - 6e4) {
        cap.logged = now;
        opts.log?.(`local room ${decodeURIComponent(name)}: refusing writes: the document is ${(over / 1048576).toFixed(1)} MB (cap ${(cap.maxBytes / 1048576).toFixed(0)} MB)`);
      }
      conn.close(DOC_SIZE_CAP_CODE, sizeCapReason(cap.maxBytes));
      return;
    }
    try {
      const dec = createDecoder(buf);
      const enc2 = createEncoder();
      switch (readVarUint(dec)) {
        case MSG_SYNC:
          if (opts.readOnly && peekVarUint(dec) !== messageYjsSyncStep1) break;
          const step1 = peekVarUint(dec) === messageYjsSyncStep1;
          if (step1 && !capacityFor(RELAY_SOCKET_QUEUE_BYTES, conn)) {
            full(conn);
            return;
          }
          if (step1) stateReservation += RELAY_SOCKET_QUEUE_BYTES;
          writeVarUint(enc2, MSG_SYNC);
          try {
            readSyncMessage(dec, enc2, d.doc, conn);
          } finally {
            if (step1) stateReservation -= RELAY_SOCKET_QUEUE_BYTES;
          }
          if (length(enc2) > 1) send(conn, toUint8Array(enc2));
          break;
        case MSG_AWARENESS:
          if (opts.readOnly) break;
          if (!allowPresence(buf)) break;
          applyAwarenessUpdate(d.awareness, readVarUint8Array(dec), conn);
          break;
        case MSG_HUB:
          send(conn, encodeFrame(hubReply(d, conn, buf, !!opts.hub, opts.readOnly)));
          break;
      }
    } catch {
    }
  });
  const bye = () => {
    if (!d.conns.has(conn)) return;
    const ids = d.conns.get(conn);
    d.conns.delete(conn);
    dropSocket(conn);
    d.hub?.closed(conn);
    if (ids?.size) removeAwarenessStates(d.awareness, Array.from(ids), null);
    if (!d.conns.size && !d.closed) d.memory?.flush();
  };
  conn.on("close", bye);
  conn.on("error", bye);
  const enc = createEncoder();
  writeVarUint(enc, MSG_SYNC);
  writeSyncStep1(enc, d.doc);
  send(conn, toUint8Array(enc));
  const states = d.awareness.getStates();
  if (states.size) {
    const aenc = createEncoder();
    writeVarUint(aenc, MSG_AWARENESS);
    writeVarUint8Array(aenc, encodeAwarenessUpdate(d.awareness, Array.from(states.keys())));
    send(conn, toUint8Array(aenc));
  }
}
function relayConnectionHandler(docs, opts) {
  opts = { ...opts, awareness: awarenessLimits(opts.awareness) };
  const admission = opts.admissionState ?? new RelayAdmission(docs, opts.admission);
  let pending = 0;
  return (conn, req) => {
    let release2;
    conn.on("error", (error) => {
      if (failedSockets.has(conn)) return;
      failedSockets.add(conn);
      release2?.();
      try {
        opts.log?.(`relay websocket: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
      }
      handshakeCleanup.get(conn)?.();
      handshakeCleanup.delete(conn);
      sessions.delete(conn);
      bootstrapInputs.delete(conn);
      dropSocket(conn);
      try {
        conn.terminate();
      } catch {
      }
    });
    try {
      const target = safeUrl(req.url);
      if (target.searchParams.has("negotiate") && target.searchParams.get("negotiate") !== "1") {
        conn.close(4406, "unsupported bootstrap; update this client");
        return;
      }
      if (target.searchParams.get("negotiate") === "1") {
        try {
          const bound = boundRelayBootstrapInput(conn);
          bound.remaining(BOOTSTRAP_MAX_BYTES + 16);
          bootstrapInputs.set(conn, bound);
        } catch (error) {
          opts.log?.(`relay bootstrap: ${error instanceof Error ? error.message : String(error)}`);
          conn.close(1011, "relay bootstrap unavailable; update/restart Room");
          return;
        }
        if (pending >= BOOTSTRAP_MAX_PENDING_PER_PRINCIPAL) {
          conn.close(1013, "relay negotiation limit reached");
          return;
        }
        pending++;
        let released = false;
        const done = () => {
          if (!released) {
            released = true;
            pending--;
          }
        };
        conn.once("close", done);
        conn.once("room-compatible", done);
      }
      const name = relayRoomName(req.url), reason = admission.refusal(name);
      if (reason) {
        conn.close(1013, reason);
        return;
      }
      release2 = admission.reserve(name);
      conn.once("close", release2);
      attach(docs, conn, req, { ...opts, readOnly: !!req.ticketView });
    } catch (e) {
      opts.log?.(`relay connection: ${e instanceof Error ? e.message : e}`);
      conn.close(1008, "Bad Request");
    }
  };
}
var LOCAL_FILE = path9.join("room", "relay.json");
function relayFile(commonDir) {
  return path9.join(commonDir, LOCAL_FILE);
}
function deterministicPort(commonDir) {
  let real = commonDir;
  try {
    real = fs8.realpathSync.native(commonDir);
  } catch {
  }
  const h = crypto5.createHash("sha1").update("schema-2\0").update(real).digest();
  return 4e4 + h.readUInt32BE(0) % 2e4;
}
function cloneId(commonDir) {
  let real = commonDir;
  try {
    real = fs8.realpathSync.native(commonDir);
  } catch {
  }
  return crypto5.createHash("sha256").update(real).digest("hex");
}
function compatibilityDetail(error) {
  const changes = error.requiredChanges.map((change) => `${change.action} ${change.side} ${change.contract}${change.capability ? ` ${change.capability}` : ""}${change.range ? ` to ${change.range.min}-${change.range.max}` : change.versions ? ` to ${change.versions.join(",")}` : ""}`);
  return `${error.text} (${error.side}; ${error.code})${changes.length ? `; ${changes.join("; ")}` : ""}`;
}
var LOOPBACK = /* @__PURE__ */ new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function isLoopback(addr) {
  return !!addr && LOOPBACK.has(addr);
}
function startRelay(port, opts = {}) {
  return new Promise((resolve, reject) => {
    parseAdvertisement(CURRENT_COMPAT);
    if (opts.hub && !opts.commonDir) throw new Error("a relay hub needs the clone's common dir");
    let draining = false;
    const writers = /* @__PURE__ */ new Set(), viewers = /* @__PURE__ */ new Set();
    const docOptions = {
      loaded: opts.daemon?.loaded,
      daemon: !!opts.daemon,
      compat: opts.daemon ? { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, "room.daemon": [1] } } : CURRENT_COMPAT,
      accepting: () => !draining,
      attached: (conn, readOnly) => {
        const group = readOnly ? viewers : writers;
        group.add(conn);
        if (!readOnly) opts.daemon?.writersChanged(writers.size);
        const remove = () => {
          if (group.delete(conn) && !readOnly) opts.daemon?.writersChanged(writers.size);
        };
        conn.once("close", remove);
        conn.once("error", remove);
      },
      commonDir: opts.commonDir,
      log: opts.log,
      seed: opts.seed,
      socketQueueBytes: opts.socketQueueBytes,
      docCap: opts.docCap,
      admission: opts.admission,
      awareness: awarenessLimits(opts.awareness),
      ...opts.hub ? { hub: { lock: opts.hub.lock, store: incarnationFile2(opts.commonDir), mono: opts.hub.mono ?? (() => performance.now()), wall: opts.hub.wall ?? Date.now, holderDead: holderDeadCheck() } } : {}
    };
    const requestedTicketTtl = opts.ticketTtlMs ?? 6e4;
    const ticketTtl = Number.isFinite(requestedTicketTtl) ? Math.max(1, Math.min(6e4, requestedTicketTtl)) : 6e4;
    const tickets = /* @__PURE__ */ new Map();
    const ticketRate = /* @__PURE__ */ new Map();
    const viewNonces = /* @__PURE__ */ new Map();
    let verifier;
    const boundPort = () => server.address()?.port ?? port;
    const proofOk = (req) => !!opts.key && (verifier ??= new ProofVerifier(opts.key, boundPort())).verify(req.headers.authorization, req.method ?? "GET", req.url ?? "/");
    const obsolete = (req, url) => /^Bearer /i.test(req.headers.authorization ?? "") || url.searchParams.has("key");
    const viewOk = (value2, room, now) => {
      if (!opts.key || typeof value2.ts !== "number" || !Number.isSafeInteger(value2.ts) || typeof value2.nonce !== "string" || !/^[a-f0-9]{32}$/.test(value2.nonce)) return false;
      if (Math.abs(now - value2.ts) > PROOF_WINDOW_MS) return false;
      for (const [nonce, expiry] of viewNonces) if (expiry <= now) viewNonces.delete(nonce);
      if (viewNonces.has(value2.nonce) || viewNonces.size >= 1e4) return false;
      const expected = viewTicketProof(localViewKey(opts.key, room), room, value2.ts, value2.nonce);
      if (!sameProof(value2.proof, expected)) return false;
      viewNonces.set(value2.nonce, now + PROOF_WINDOW_MS);
      return true;
    };
    const server = http2.createServer(async (req, res) => {
      try {
        res.setHeader("Referrer-Policy", "no-referrer");
        const url = safeUrl(req.url);
        if (obsolete(req, url)) {
          res.writeHead(400);
          res.end("use Authorization: Room-Proof or a view proof");
          return;
        }
        if (url.pathname === "/ws-ticket" && req.method === "OPTIONS") {
          res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type" });
          res.end();
          return;
        }
        if (req.method === "POST" && url.pathname === "/ws-ticket") {
          res.setHeader("Access-Control-Allow-Origin", "*");
          if (!isLoopback(req.socket.remoteAddress)) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
          }
          const ip = req.socket.remoteAddress ?? "?", now = Date.now(), prior = ticketRate.get(ip);
          const budget = prior && prior.until > now ? prior : { count: 0, until: now + 6e4 };
          ticketRate.set(ip, budget);
          if (++budget.count > 60) {
            res.writeHead(429);
            res.end("rate limited");
            return;
          }
          let body = "";
          req.on("data", (part) => {
            body += part;
            if (body.length > 4096) req.destroy();
          });
          req.on("end", () => {
            let value2;
            try {
              value2 = JSON.parse(body);
            } catch {
              res.writeHead(400);
              res.end("bad request");
              return;
            }
            if (!value2 || typeof value2 !== "object" || Array.isArray(value2)) {
              res.writeHead(400);
              res.end("bad request");
              return;
            }
            if ("key" in value2) {
              res.writeHead(400);
              res.end("use a view proof");
              return;
            }
            const room = value2.room;
            if (value2.schema !== 2 || typeof room !== "string" || !room.startsWith("local/")) {
              res.writeHead(400);
              res.end("schema 2 local room required");
              return;
            }
            if (!proofOk(req) && !viewOk(value2, room, now)) {
              res.writeHead(403);
              res.end("Forbidden");
              return;
            }
            for (const [key, t] of tickets) if (t.expires <= now) tickets.delete(key);
            if (tickets.size >= 1e4) {
              res.writeHead(503);
              res.end("too many pending tickets");
              return;
            }
            const ticket = crypto5.randomBytes(16).toString("hex");
            tickets.set(ticket, { room, expires: now + ticketTtl });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ticket, expiresIn: Math.ceil(ticketTtl / 1e3) }));
          });
          return;
        }
        if (url.pathname === "/health") {
          const nonce = req.headers["x-room-nonce"];
          res.writeHead(200, { "content-type": "application/json" });
          const health = { ok: true, local: true, schema: 2, hub: 1, pid: process.pid, discovery: 1, runtime: opts.daemon ? "daemon" : "session-relay", ...opts.daemon?.health() ?? {}, ...opts.daemon ? { writers: writers.size, viewers: viewers.size, pending: wss.clients.size - writers.size - viewers.size, storage: { io: [...docs.values()].some((d) => d.memory?.status.io), capacity: [...docs.values()].some((d) => d.memory?.status.capacity || d.cap.meter.size() > d.cap.maxBytes) } } : {}, compat: docOptions.compat, ...opts.commonDir ? { clone: cloneId(opts.commonDir) } : {} };
          const proof = opts.key && typeof nonce === "string" && /^[a-f0-9]{32}$/.test(nonce) ? { proof: relayProof(opts.key, nonce, boundPort()), ...opts.daemon ? { metadataProof: relayMetadataProof(opts.key, nonce, boundPort(), health) } : {} } : {};
          res.end(JSON.stringify({ ...health, ...proof }));
          return;
        }
        if (req.method === "POST" && url.pathname === "/daemon/stop" && opts.daemon?.stop) {
          if (!proofOk(req) || !isLoopback(req.socket.remoteAddress)) {
            res.writeHead(403);
            res.end();
            return;
          }
          if (writers.size || draining) {
            res.writeHead(409);
            res.end(draining ? "local daemon is already draining; inspect status and retry" : "local daemon has active writers; quiesce clients before stopping");
            return;
          }
          try {
            await opts.daemon.stop(Number(url.searchParams.get("pid")), url.searchParams.get("nonce") ?? "", () => {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ saved: true }));
            });
          } catch (error) {
            if (!res.writableEnded) {
              res.writeHead(409);
              res.end(error instanceof Error ? error.message : String(error));
            }
          }
          return;
        }
        if (url.pathname === "/daemon/status" && opts.daemon) {
          if (!proofOk(req) || !isLoopback(req.socket.remoteAddress)) {
            res.writeHead(403);
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...opts.daemon.health(true), writers: writers.size, viewers: viewers.size, pending: wss.clients.size - writers.size - viewers.size, rooms: [...docs].map(([name, d]) => ({ room: decodeURIComponent(name), storage: { ...d.memory?.status, liveCapacity: d.cap.meter.size() > d.cap.maxBytes } })) }));
          return;
        }
        if (req.method === "DELETE" && url.pathname === "/memory") {
          if (!proofOk(req) || !isLoopback(req.socket.remoteAddress)) {
            res.writeHead(403);
            res.end();
            return;
          }
          try {
            const room = url.searchParams.get("room") ?? "";
            const d = docs.get(encodeURIComponent(room));
            if (d?.memory) d.memory.forget();
            else if (opts.commonDir) fs8.rmSync(memoryFile(opts.commonDir, room), { force: true });
            if (opts.commonDir) forgetLegacyLocal(opts.commonDir, room);
            res.writeHead(204);
            res.end();
          } catch {
            res.writeHead(500);
            res.end("could not forget local memory");
          }
          return;
        }
        if (url.pathname === "/") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end("Room opens the browser view from the file link printed by your agent.\n");
          return;
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found\n");
      } catch (e) {
        opts.log?.(`relay http: ${e instanceof Error ? e.message : e}`);
        if (!res.writableEnded) {
          res.writeHead(e instanceof HttpFailure ? e.status : 500);
          res.end(e instanceof HttpFailure ? e.message : "Internal Server Error");
        }
      }
    });
    const wss = new import_websocket_server.default({ noServer: true });
    wss.on("headers", (headers) => headers.push("Referrer-Policy: no-referrer"));
    const docs = relayDocs();
    const admission = docOptions.admissionState = new RelayAdmission(docs, opts.admission);
    wss.on("connection", relayConnectionHandler(docs, { ...docOptions, key: opts.key ?? "" }));
    const ticker = setInterval(() => {
      for (const [name, d] of docs) {
        d.presence.prune();
        try {
          d.hub?.tick();
        } catch (error) {
          opts.log?.(`hub maintenance ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (opts.commonDir && d.memory) try {
          catchUpLocal(opts.commonDir, decodeURIComponent(name), d.doc, opts.log);
        } catch (error) {
          opts.log?.(`local migration: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }, 1e3);
    ticker.unref?.();
    server.on("upgrade", (req, socket, head) => {
      socket.on("error", () => {
      });
      const refuse = (code, why) => {
        socket.write(`HTTP/1.1 ${code} ${why}\r
Referrer-Policy: no-referrer\r
Connection: close\r
\r
`);
        socket.destroy();
      };
      try {
        const url = safeUrl(req.url);
        if (draining) return refuse(503, "local daemon draining; retry");
        if (!isLoopback(req.socket.remoteAddress)) return refuse(403, "Forbidden");
        if (obsolete(req, url)) return refuse(400, "use Authorization: Room-Proof or a browser ticket");
        if (url.searchParams.has("negotiate") && url.searchParams.get("negotiate") !== "1") return refuse(426, "unsupported bootstrap; update this client");
        if (url.searchParams.get("schema") !== "2") return refuse(426, "update Room to 0.17 or later: this local room uses schema 2");
        try {
          decodeURIComponent((req.url ?? "/").split("?")[0]);
        } catch {
          return refuse(400, "Bad Request");
        }
        if (opts.key) {
          const issued = url.searchParams.get("ticket");
          const ticket = issued ? tickets.get(issued) : void 0;
          if (issued) tickets.delete(issued);
          const room = decodeURIComponent(url.pathname.slice(1));
          const ticketOk = !!ticket && ticket.expires > Date.now() && ticket.room === room;
          if (issued && !ticketOk) return refuse(403, "websocket ticket invalid or expired");
          if (!ticketOk && !proofOk(req)) return refuse(403, "Forbidden: local room proof missing or wrong");
          if (ticketOk) req.ticketView = true;
        }
        const capacityReason = admission.refusal(relayRoomName(req.url));
        if (capacityReason) return refuse(503, capacityReason);
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } catch (e) {
        opts.log?.(`relay upgrade: ${e instanceof Error ? e.message : e}`);
        refuse(e instanceof HttpFailure ? e.status : 500, e instanceof HttpFailure ? e.message : "Internal Server Error");
      }
    });
    const signals = ["SIGTERM", "SIGINT"];
    let closing;
    const onSignal = () => {
      if (opts.daemon) {
        opts.daemon.onSignal();
        return;
      }
      ;
      close().catch((error) => opts.log?.(`local relay: room state could not be saved on stop: ${error instanceof Error ? error.message : String(error)}`));
    };
    const close = (saved, generation) => closing ??= (async () => {
      if (opts.daemon) {
        for (const d of docs.values()) await d.hubReady;
        await Promise.all([...docs.values()].flatMap((d) => d.hub ? [d.hub.flushLeases()] : []));
      }
      await finalSave(() => [...docs.values()].flatMap((d) => d.memory ? [d.memory] : []), opts.finalSaveRetryMs, generation);
      saved?.();
      await teardown();
    })().catch((error) => {
      closing = void 0;
      throw error;
    });
    const teardown = async () => {
      for (const signal of signals) process.off(signal, onSignal);
      clearInterval(ticker);
      for (const d of docs.values()) {
        d.closed = true;
        d.hub?.stop();
        d.memory?.detach();
      }
      for (const c of wss.clients) c.terminate();
      await new Promise((done) => {
        wss.close();
        server.close(() => {
          for (const d of docs.values()) {
            d.awareness.destroy();
            d.doc.destroy();
          }
          docs.clear();
          opts.hub?.lock.release();
          done();
        });
      });
    };
    server.once("error", (e) => {
      clearInterval(ticker);
      reject(e);
    });
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const bound = typeof addr === "object" && addr ? addr.port : port;
      for (const signal of signals) process.on(signal, onSignal);
      resolve({
        port: bound,
        get connections() {
          return { writers: writers.size, viewers: viewers.size, pending: wss.clients.size - writers.size - viewers.size };
        },
        canCompact: () => [...docs.values()].every((d) => !d.memory || d.memory.canCompact()),
        history: () => [...docs].map(([name, d]) => ({ room: decodeURIComponent(name), deleted: historyOf(d.doc).deleted })),
        setDraining(value2) {
          draining = value2;
        },
        async abortUnpublished() {
          if (writers.size || viewers.size) throw new Error("cannot discard a published relay replica");
          draining = true;
          await teardown();
        },
        async initialize(room) {
          const d = getDoc(docs, encodeURIComponent(room), docOptions);
          await d.hubReady;
          if (d.hubError) throw d.hubError;
          if (opts.hub && !d.hub) throw new Error("local daemon hub could not initialize; repair private authority files");
        },
        close,
        hubRoom(room) {
          const d = docs.get(encodeURIComponent(room));
          return d?.room ? { doc: d.room, ...d.hub ? { hub: d.hub } : {} } : void 0;
        }
      });
    });
  });
}

// packages/relay/src/daemon.ts
var release = true ? "0.17.42" : "development";
var LOCAL_DAEMON_IDLE_MS = 5 * 6e4;
function discovery(commonDir) {
  const file = relayFile(commonDir);
  let raw;
  try {
    if (fs9.statSync(file).size > 8192) throw new Error("discovery exceeds size limit");
    verifyPrivatePath(file);
    raw = fs9.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return void 0;
    throw e;
  }
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("invalid local relay discovery JSON; preserve and repair room/relay.json before restarting Room");
  }
  if (!v || v.schema !== 2 || !Number.isInteger(v.port) || v.port < 1 || v.port > 65535 || !Number.isInteger(v.pid) || v.pid < 1 || typeof v.key !== "string" || !v.key || v.key.length > 256 || typeof v.room !== "string" || !Number.isFinite(v.startedAt) || v.discovery !== void 0 && v.discovery !== 1) throw new Error("invalid or unsupported local relay discovery; preserve it and repair before restarting Room");
  if (v.nonce !== void 0 && (typeof v.nonce !== "string" || !/^[0-9a-f-]{36}$/.test(v.nonce))) throw new Error("invalid daemon identity nonce in discovery");
  if (v.compat !== void 0) parseAdvertisement(v.compat);
  if (v.runtime !== void 0 && v.runtime !== "daemon" && v.runtime !== "session-relay") throw new Error("unsupported local runtime in discovery; update Room or repair the record");
  if (v.lead !== void 0 && v.lead !== true && (!v.lead || typeof v.lead !== "object" || !Number.isInteger(v.lead.pid) || v.lead.pid < 1 || typeof v.lead.startTime !== "string" || !v.lead.startTime || typeof v.lead.executable !== "string" || !v.lead.executable)) throw new Error("invalid discovery process identity; preserve and repair the record");
  return v;
}
var WriterIdleClock = class {
  constructor(now, idleMs = LOCAL_DAEMON_IDLE_MS) {
    this.now = now;
    this.idleMs = idleMs;
    this.emptySince = now();
  }
  now;
  idleMs;
  emptySince;
  writers = 0;
  changed(count) {
    if (count === 0 && this.writers !== 0) this.emptySince = this.now();
    this.writers = count;
  }
  expired() {
    return this.writers === 0 && this.now() - this.emptySince >= this.idleMs;
  }
};
async function startLocalDaemon(opts) {
  const commonDir = fs9.realpathSync.native(opts.commonDir);
  const log2 = opts.log ?? (() => {
  });
  const phase = (name) => log2(`startup pid ${process.pid}: ${name}`);
  phase("state check");
  await primePrivateState(commonDir);
  privateStateDirectory(path10.join(commonDir, "room"));
  phase("state verified");
  phase("lease acquisition");
  const lock = AuthorityLock.take(commonDir);
  if (!lock) {
    phase("authority held by another contender");
    return void 0;
  }
  phase("authority acquired");
  let relay;
  try {
    const previous = discovery(commonDir);
    const key = previous?.key ?? crypto6.randomBytes(32).toString("hex");
    const own = probeOwnProcess();
    if (!own?.startTime || !own.executable) throw new Error("cannot establish daemon process birth identity");
    const identity = { pid: process.pid, startTime: own.startTime, executable: own.executable };
    const clock = new WriterIdleClock(opts.now ?? Date.now, opts.idleMs);
    const minDeleted = compactMinDeleted(process.env.ROOM_COMPACT_MIN_DELETED);
    const now = opts.now ?? Date.now;
    let nextHistoryCheck = now() + 6e4, compactionBlocked = false;
    const startedAt = Date.now();
    const nonce = crypto6.randomUUID();
    let ready = false;
    let stopRequested = false;
    let compactionGeneration;
    let draining = false, stopping, failure;
    let nextRetry = 0, retryMs = opts.retryMs ?? 1e3;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    let timer;
    const close = (requested = true, saved) => {
      if (requested) stopRequested = true;
      if (stopping) return stopping;
      draining = true;
      relay.setDraining(true);
      stopping = relay.close(saved, compactionGeneration).then(() => {
        if (timer) clearInterval(timer);
        resolveClosed();
      }).catch((error) => {
        draining = false;
        relay.setDraining(false);
        stopping = void 0;
        failure = (error instanceof Error ? error.message : String(error)).slice(0, 256);
        log2(`local daemon save blocked: ${failure}`);
        nextRetry = Date.now() + retryMs;
        retryMs = Math.min(6e4, retryMs * 2);
        throw error;
      });
      return stopping;
    };
    const health = (authenticated = false) => ({ ready, nonce, release, uptimeMs: Date.now() - startedAt, idleMs: clock.idleMs, draining, ...failure ? { stopFailure: authenticated ? failure : failure.match(/\b(?:ENOSPC|EACCES|EIO|EPERM)\b/)?.[0] ?? "save-blocked" } : {} });
    const open = (port2) => startRelay(port2, {
      commonDir,
      key,
      hub: { lock },
      log: log2,
      finalSaveRetryMs: opts.finalSaveRetryMs,
      daemon: { loaded: (room, doc) => {
        if (!Number.isFinite(minDeleted)) return;
        const deleted = historyOf(doc).deleted;
        if (deleted >= minDeleted) {
          compactionBlocked = true;
          log2(`local daemon compaction disabled for this process: ${room} loaded with ${deleted} deleted structs`);
        }
      }, health, onSignal: () => {
        void close().catch(() => {
        });
      }, writersChanged: (count) => clock.changed(count), stop: async (pid, expectedNonce, saved) => {
        if (pid !== process.pid || expectedNonce !== nonce) throw new Error("local daemon identity changed; reread discovery before stopping");
        if (draining) throw new Error("local daemon is already draining; inspect status and retry");
        await close(false, saved);
      } }
    });
    const port = previous?.port ?? deterministicPort(commonDir);
    phase("listen");
    relay = await openPreferred(port, open, async () => {
      const occupant = await relayIdentity(port, key);
      return occupant?.health.local === true && occupant.health.clone === cloneId(commonDir);
    });
    phase("listening");
    relay.setDraining(true);
    phase("lease recovery");
    await relay.initialize(opts.room);
    phase("leases recovered");
    const info = { schema: 2, discovery: 1, runtime: "daemon", nonce, compat: { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, "room.daemon": [1] } }, port: relay.port, pid: process.pid, room: opts.room, key, startedAt: Date.now(), lead: identity };
    phase("discovery publication");
    writeAtomic(relayFile(commonDir), info);
    verifyPrivatePath(relayFile(commonDir), true);
    ready = true;
    relay.setDraining(false);
    phase("ready");
    timer = setInterval(() => {
      if (Number.isFinite(minDeleted) && !draining && !stopRequested && !compactionBlocked && now() >= nextHistoryCheck) {
        nextHistoryCheck = now() + 6e4;
        const over = relay.history().find((room) => room.deleted >= minDeleted);
        if (over && !relay.canCompact()) {
          compactionBlocked = true;
          log2("local daemon compaction disabled for this process: snapshot would shed content");
        } else if (over) {
          log2(`local daemon restarting for compaction: ${over.room} has ${over.deleted} deleted structs (threshold ${minDeleted})`);
          compactionGeneration = crypto6.randomUUID();
          stopRequested = true;
        }
      }
      if (!draining && (stopRequested || clock.expired()) && Date.now() >= nextRetry) void close(false).catch(() => {
      });
    }, opts.idleCheckMs ?? 1e3);
    return { info, relay, closed, close };
  } catch (error) {
    if (relay) {
      await relay.abortUnpublished();
    } else lock.release();
    throw error;
  }
}
async function openPreferred(port, open, ownerAnswers) {
  try {
    return await open(port);
  } catch (error) {
    const code = error.code;
    if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
    if (await ownerAnswers()) throw new Error(`local Room owner still answers on port ${port}; drain it before starting the daemon`);
    return open(0);
  }
}
async function stopLocalDaemon(commonDir, timeoutMs = 15e3, expectedNonce) {
  const canonical = fs9.realpathSync.native(commonDir);
  const info = discovery(canonical);
  if (expectedNonce !== void 0 && info?.nonce !== expectedNonce) return "different daemon instance";
  if (!info || info.runtime !== "daemon" || !info.nonce || !info.lead || info.lead === true || info.lead.pid !== info.pid) throw new Error("no verifiable daemon identity in discovery; preserve state and inspect before stopping");
  const health = await relayHealth(info.port, info.key);
  if (!health || health.clone !== cloneId(canonical) || health.runtime !== "daemon" || health.pid !== info.pid || health.nonce !== info.nonce) throw new Error("local daemon identity could not be authenticated; refusing stop");
  const verifyUntil = Date.now() + Math.min(5e3, timeoutMs);
  let alive = liveness(info.lead);
  while (alive === "unknown" && Date.now() < verifyUntil) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = liveness(info.lead);
  }
  if (alive !== "alive") throw new Error("local daemon birth identity is not verified alive; refusing stop");
  const target = `/daemon/stop?pid=${info.pid}&nonce=${encodeURIComponent(info.nonce)}`;
  const response = await fetch(`http://127.0.0.1:${info.port}${target}`, { method: "POST", headers: { Authorization: localProofHeader(info.key, "POST", target, info.port) }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`local daemon stop refused: ${(await response.text()).slice(0, 2048)}`);
  const result = await response.json();
  if (result.saved !== true) throw new Error("local daemon did not confirm final save");
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (liveness(info.lead) === "dead") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("daemon saved but process exit could not be verified; keep old clients stopped and inspect its identity");
}

// packages/relay/src/daemon-bin.ts
var args2 = process.argv.slice(2);
var value = (flag) => {
  const index = args2.indexOf(flag);
  if (index < 0 || !args2[index + 1]) throw new Error(`missing ${flag}`);
  return args2[index + 1];
};
var log = () => {
};
try {
  const commonDir = fs10.realpathSync.native(value("--common-dir"));
  if (!path11.isAbsolute(commonDir)) throw new Error("daemon common directory must be absolute");
  if (args2[0] === "stop") {
    await stopLocalDaemon(commonDir);
    process.stdout.write("Daemon saved and process exit verified.\n");
  } else {
    if (args2[0] && !args2[0].startsWith("--") || !args2.includes("--startup-report")) throw new Error("usage: room-daemon.mjs stop --common-dir <absolute git common directory> (Room starts the daemon itself on join)");
    await primePrivateState(commonDir);
    privateStateDirectory(path11.join(commonDir, "room"));
    const file = path11.join(commonDir, "room", "daemon.log");
    let created = false;
    try {
      const fd = fs10.openSync(file, "wx", 384);
      fs10.closeSync(fd);
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    verifyPrivatePath(file, created);
    for (const retained of [`${file}.1`, `${file}.2`]) if (fs10.existsSync(retained)) verifyPrivatePath(retained);
    log = (line) => {
      try {
        const record = `${(/* @__PURE__ */ new Date()).toISOString()} ${line.slice(0, 2048).replace(/[\r\n]/g, " ")}
`;
        if (fs10.existsSync(file)) verifyPrivatePath(file);
        if (fs10.existsSync(file) && fs10.statSync(file).size + Buffer.byteLength(record) > 1024 * 1024) {
          if (fs10.existsSync(`${file}.1`)) verifyPrivatePath(`${file}.1`);
          if (fs10.existsSync(`${file}.2`)) verifyPrivatePath(`${file}.2`);
          fs10.rmSync(`${file}.2`, { force: true });
          if (fs10.existsSync(`${file}.1`)) fs10.renameSync(`${file}.1`, `${file}.2`);
          fs10.renameSync(file, `${file}.1`);
        }
        const created2 = !fs10.existsSync(file);
        fs10.appendFileSync(file, record, { mode: 384 });
        verifyPrivatePath(file, created2);
      } catch {
      }
    };
    log(`startup pid ${process.pid}: state verified`);
    const daemon = await startLocalDaemon({ commonDir, room: value("--room"), log });
    if (daemon) await daemon.closed;
  }
} catch (error) {
  const cause = error instanceof Error ? error.message : String(error);
  log(`daemon failed: ${cause}`);
  process.stderr.write(`Room daemon: ${cause}
`);
  const report = args2.indexOf("--startup-report");
  if (report >= 0 && args2[report + 1]) {
    try {
      fs10.writeFileSync(args2[report + 1], cause.slice(0, 2048), { flag: "wx", mode: 384 });
    } catch {
    }
  }
  process.exitCode = 1;
}
