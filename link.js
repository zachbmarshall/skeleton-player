// USB links to the Nano. Same protocol as skeleton/serial_link.py:
//   0xFF <angle>  set target    0xFE  handshake, Nano replies "OK"
//   0xFD <angle>  set rest angle for the failsafe
//
// Two transports:
//   CH340Link      WebUSB with a tiny CH340 driver. Works on Chrome for Android, where
//                  Web Serial does not reliably list CH340 clone Nanos.
//   WebSerialLink  Web Serial. For desktop Chrome (testing on the PC) and for boards
//                  Android Chrome does list.

export const SYNC = 0xff, HELLO = 0xfe, REST = 0xfd;
const BAUD = 115200;
const CH340_VID = 0x1a86;

// Other USB-serial chips Nanos ship with. Listed in the picker only so a board that
// isn't a CH340 shows up and we can say what it is, instead of "no compatible devices".
const OTHER_CHIPS = { 0x0403: "FTDI (genuine Nano)", 0x10c4: "CP210x", 0x2341: "Arduino native USB", 0x2a03: "Arduino native USB" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BaseLink {
  constructor() {
    this.rx = "";
    this.busy = false;
    this.onclose = null;
  }

  _gotData(bytes) {
    this.rx = (this.rx + new TextDecoder().decode(bytes)).slice(-64);
  }

  // Fire-and-forget write for the 50 Hz jaw loop: if the last frame is still in
  // flight, drop this one; the next tick sends a fresher angle anyway.
  send(bytes) {
    if (this.busy) return;
    this.busy = true;
    this.write(new Uint8Array(bytes))
      .catch((e) => console.warn("write failed", e))
      .finally(() => { this.busy = false; });
  }

  // The Nano resets when the port opens, so give it two seconds, then knock.
  async handshake(restAngle) {
    await sleep(2000);
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      this.rx = "";
      await this.write(new Uint8Array([HELLO]));
      for (let t = 0; t < 6 && !ok; t++) {
        await sleep(50);
        ok = this.rx.includes("OK");
      }
    }
    await this.write(new Uint8Array([REST, restAngle]));
    return ok;
  }
}

export class CH340Link extends BaseLink {
  static get supported() { return "usb" in navigator; }
  get label() { return "USB (CH340)"; }

  static async request() {
    const vids = [CH340_VID, ...Object.keys(OTHER_CHIPS).map(Number)];
    return navigator.usb.requestDevice({ filters: vids.map((vendorId) => ({ vendorId })) });
  }

  // A board this page was allowed before; no picker needed.
  static async known() {
    if (!this.supported) return null;
    const devs = await navigator.usb.getDevices();
    return devs.find((d) => d.vendorId === CH340_VID) || null;
  }

  async open(dev) {
    if (dev.vendorId !== CH340_VID) {
      const hex = (n) => n.toString(16).padStart(4, "0");
      const chip = OTHER_CHIPS[dev.vendorId] || "unknown chip";
      throw new Error(`this board uses a ${chip} USB chip (${hex(dev.vendorId)}:${hex(dev.productId)}), not a CH340. Try "Connect (Web Serial)" instead.`);
    }
    this.dev = dev;
    await dev.open();
    if (dev.configuration === null) await dev.selectConfiguration(1);
    const iface = dev.configuration.interfaces[0];
    await dev.claimInterface(iface.interfaceNumber);
    for (const ep of iface.alternate.endpoints) {
      if (ep.type !== "bulk") continue;
      if (ep.direction === "in") this.epIn = ep.endpointNumber;
      else this.epOut = ep.endpointNumber;
    }
    // Init sequence from usb-serial-for-android's CH34xSerialDriver.
    await this._in(0x5f, 0, 0);
    await this._out(0xa1, 0, 0);
    await this._baud(BAUD);
    await this._in(0x95, 0x2518, 0);
    await this._out(0x9a, 0x2518, 0xc3);          // LCR: enable RX + TX, 8N1
    await this._in(0x95, 0x0706, 0);
    await this._out(0xa1, 0x501f, 0xd90a);
    await this._baud(BAUD);
    await this._out(0xa4, ~(0x20 | 0x40) & 0xffff, 0);   // DTR + RTS on; DTR resets the Nano
    this.open_ = true;
    this._readLoop();
  }

  async _baud(baud) {
    let factor = Math.floor(1532620800 / baud);
    let divisor = 3;
    while (factor > 0xfff0 && divisor > 0) { factor >>= 3; divisor--; }
    factor = 0x10000 - factor;
    divisor |= 0x80;
    await this._out(0x9a, 0x1312, (factor & 0xff00) | divisor);
    await this._out(0x9a, 0x0f2c, factor & 0xff);
  }

  _out(request, value, index) {
    return this.dev.controlTransferOut({ requestType: "vendor", recipient: "device", request, value, index });
  }

  _in(request, value, index) {
    return this.dev.controlTransferIn({ requestType: "vendor", recipient: "device", request, value, index }, 2);
  }

  async _readLoop() {
    while (this.open_) {
      try {
        const r = await this.dev.transferIn(this.epIn, 64);
        if (r.data && r.data.byteLength) this._gotData(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
      } catch (e) {
        if (this.open_) this._lost(e);
        return;
      }
    }
  }

  write(bytes) {
    if (!this.open_) return Promise.reject(new Error("closed"));
    return this.dev.transferOut(this.epOut, bytes);
  }

  _lost(e) {
    this.open_ = false;
    console.warn("CH340 link lost", e);
    if (this.onclose) this.onclose();
  }

  async close() {
    this.open_ = false;
    try { await this.dev.close(); } catch (_) { /* already gone */ }
  }
}

export class WebSerialLink extends BaseLink {
  static get supported() { return "serial" in navigator; }
  get label() { return "Web Serial"; }

  static request() { return navigator.serial.requestPort(); }

  static async known() {
    if (!this.supported) return null;
    const ports = await navigator.serial.getPorts();
    return ports[0] || null;
  }

  async open(port) {
    this.port = port;
    await port.open({ baudRate: BAUD });
    this.writer = port.writable.getWriter();
    this.open_ = true;
    this._readLoop();
  }

  async _readLoop() {
    try {
      this.reader = this.port.readable.getReader();
      while (this.open_) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this._gotData(value);
      }
    } catch (e) {
      console.warn("serial read ended", e);
    }
    if (this.open_) {
      this.open_ = false;
      if (this.onclose) this.onclose();
    }
  }

  write(bytes) {
    if (!this.open_) return Promise.reject(new Error("closed"));
    return this.writer.write(bytes);
  }

  async close() {
    this.open_ = false;
    try { await this.reader?.cancel(); } catch (_) { /* ignore */ }
    try { this.writer?.releaseLock(); } catch (_) { /* ignore */ }
    try { await this.port.close(); } catch (_) { /* ignore */ }
  }
}
