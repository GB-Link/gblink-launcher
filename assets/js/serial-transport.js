// WebSerial transport for the GBLink firmware's CDC-ACM command protocol — the
// Firefox (and any non-WebUSB) fallback. The firmware speaks the same command
// set over CDC as over the WebUSB vendor interface; CDC is a byte stream, so it
// uses a framed protocol:
//
//     | 0x47 0x42 | channel:1 | len:2 LE | payload[len] |
//        sync 'GB'    0=cmd, 1=data, 2=status
//
// Modeled on the proven gb-tetris-web/js/serial_ws.js read loop + framing.

const SYNC0 = 0x47;
const SYNC1 = 0x42;
const CH_CMD = 0x00;
const CH_DATA = 0x01;
const MAX_PAYLOAD = 64;

// Same VIDs the WebUSB chooser uses, minus the bootrom (no serial port in BOOTSEL).
export const SERIAL_FILTERS = [
    { usbVendorId: 0x2fe3 }, // GBLink unified firmware (Zephyr)
    { usbVendorId: 0xcafe }, // reconfigurable firmware (TinyUSB)
    { usbVendorId: 0x239a }, // Adafruit boards
];

export function webSerialAvailable() {
    return typeof navigator !== 'undefined' && Boolean(navigator.serial);
}

export class SerialTransport {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;

        this._dataQueue = [];
        this._dataWaiters = [];

        this._rxState = 'sync1';
        this._rxChannel = 0;
        this._rxLen = 0;
        this._rxBuf = null;
        this._rxPos = 0;
    }

    static requestPort() {
        return navigator.serial.requestPort({ filters: SERIAL_FILTERS });
    }

    async open(port) {
        this.port = port;
        await this.port.open({ baudRate: 115200 }); // CDC ignores the rate
        this.writer = this.port.writable.getWriter();
        this.reader = this.port.readable.getReader();
        this._runReadLoop();
    }

    getInfo() {
        try {
            return this.port?.getInfo?.() ?? {};
        } catch {
            return {};
        }
    }

    async _runReadLoop() {
        try {
            while (this.reader) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) for (let i = 0; i < value.length; i++) this._feedByte(value[i]);
            }
        } catch {
            // Reader was cancelled (close) or the device went away — stop quietly.
        }
    }

    _feedByte(b) {
        switch (this._rxState) {
            case 'sync1':
                if (b === SYNC0) this._rxState = 'sync2';
                break;
            case 'sync2':
                if (b === SYNC1) this._rxState = 'channel';
                else if (b === SYNC0) this._rxState = 'sync2';
                else this._rxState = 'sync1';
                break;
            case 'channel':
                this._rxChannel = b;
                this._rxState = 'lenLo';
                break;
            case 'lenLo':
                this._rxLen = b;
                this._rxState = 'lenHi';
                break;
            case 'lenHi':
                this._rxLen |= b << 8;
                if (this._rxLen > MAX_PAYLOAD) { this._rxState = 'sync1'; break; }
                this._rxPos = 0;
                this._rxBuf = new Uint8Array(this._rxLen);
                if (this._rxLen === 0) {
                    this._dispatchFrame();
                    this._rxState = 'sync1';
                } else {
                    this._rxState = 'payload';
                }
                break;
            case 'payload':
                this._rxBuf[this._rxPos++] = b;
                if (this._rxPos >= this._rxLen) {
                    this._dispatchFrame();
                    this._rxState = 'sync1';
                }
                break;
        }
    }

    _dispatchFrame() {
        if (this._rxChannel !== CH_DATA) return; // command replies come on the data channel
        const frame = this._rxBuf;
        const waiter = this._dataWaiters.shift();
        if (waiter) {
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.resolve(frame);
        } else {
            this._dataQueue.push(frame);
        }
    }

    async _writeFrame(channel, payload) {
        if (!this.writer) throw new Error('Serial not connected');
        const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
        if (p.length > MAX_PAYLOAD) throw new Error('Payload too large');
        const frame = new Uint8Array(5 + p.length);
        frame[0] = SYNC0;
        frame[1] = SYNC1;
        frame[2] = channel;
        frame[3] = p.length & 0xff;
        frame[4] = (p.length >> 8) & 0xff;
        frame.set(p, 5);
        await this.writer.write(frame);
    }

    // Fire-and-forget command (e.g. SetWebUsbLanding 0x44, RebootBootloader 0x43).
    async sendCommand(payload) {
        await this._writeFrame(CH_CMD, payload);
    }

    // Command that expects a single data-channel reply (e.g. GetFirmwareInfo 0x0F).
    async sendCommandAwaitReply(payload, timeoutMs = 800) {
        this._dataQueue.length = 0; // drop any stale frames
        const reply = this._awaitData(timeoutMs);
        await this._writeFrame(CH_CMD, payload);
        return reply;
    }

    _awaitData(timeoutMs) {
        if (this._dataQueue.length > 0) return Promise.resolve(this._dataQueue.shift());
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            this._dataWaiters.push(waiter);
            if (timeoutMs > 0) {
                waiter.timer = setTimeout(() => {
                    const idx = this._dataWaiters.indexOf(waiter);
                    if (idx !== -1) {
                        this._dataWaiters.splice(idx, 1);
                        reject(new Error('serial reply timeout'));
                    }
                }, timeoutMs);
            }
        });
    }

    async close() {
        try { await this.reader?.cancel(); } catch {}
        try { this.reader?.releaseLock(); } catch {}
        try { this.writer?.releaseLock(); } catch {}
        this.reader = null;
        this.writer = null;
        try { await this.port?.close(); } catch {}
        this.port = null;
    }
}
