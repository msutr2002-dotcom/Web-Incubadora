import { LineAssembler, type ConnectOptions, type Link, type LinkEvents, type LinkStatus } from './link';

interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  addEventListener(type: 'disconnect', listener: () => void): void;
  removeEventListener(type: 'disconnect', listener: () => void): void;
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
}

interface SerialApi {
  requestPort(): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

function getSerial(): SerialApi | null {
  const nav = navigator as unknown as { serial?: SerialApi };
  return nav.serial ?? null;
}

export function isWebSerialSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  return getSerial() !== null;
}

function portLabel(port: SerialPortLike, baudRate: number): string {
  const info = port.getInfo?.();
  if (info?.usbVendorId !== undefined) {
    const hex = (n: number) => n.toString(16).padStart(4, '0');
    return `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId ?? 0)}`;
  }
  return `Puerto serie @ ${baudRate}`;
}

export class SerialLink implements Link {
  readonly transport = 'serial' as const;

  private port: SerialPortLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private reading = false;
  private status: LinkStatus = 'idle';
  private readonly lines = new LineAssembler();
  private onPortDisconnect: (() => void) | null = null;

  constructor(private events: LinkEvents) {}

  isConnected(): boolean {
    return this.status === 'connected';
  }

  private setStatus(status: LinkStatus, detail?: string): void {
    this.status = status;
    this.events.onStatus(status, detail);
  }

  private release(): void {
    const port = this.port;
    const writer = this.writer;
    const reader = this.reader;
    this.port = null;
    this.writer = null;
    this.reader = null;
    this.lines.reset();

    if (port && this.onPortDisconnect) {
      port.removeEventListener('disconnect', this.onPortDisconnect);
      this.onPortDisconnect = null;
    }
    void (async () => {
      try {
        await reader?.cancel();
      } catch {
        /* ya cerrado */
      }
      try {
        writer?.releaseLock();
      } catch {
        /* ya liberado */
      }
      // Espera a que el lector suelte el stream antes de cerrar el puerto.
      const deadline = Date.now() + 400;
      while (port?.readable?.locked && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      try {
        await port?.close();
      } catch {
        /* ya cerrado */
      }
    })();
  }

  private handleUnexpectedClose(): void {
    if (!this.reading) return;
    this.reading = false;
    this.setStatus('disconnecting');
    this.release();
    this.setStatus('idle', 'El puerto serie se desconectó.');
  }

  private async readLoop(port: SerialPortLike): Promise<void> {
    const stream = port.readable;
    if (!stream) return;
    const reader = stream.getReader();
    this.reader = reader;

    try {
      while (this.reading) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) this.lines.push(value, (l) => this.events.onLine(l));
      }
      if (this.reading) {
        this.lines.flush((l) => this.events.onLine(l));
        this.handleUnexpectedClose();
      }
    } catch {
      this.handleUnexpectedClose();
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ya liberado */
      }
      if (this.reader === reader) this.reader = null;
    }
  }

  async connect(options: ConnectOptions = {}): Promise<void> {
    const baudRate = options.baudRate ?? 115200;
    const serial = getSerial();
    if (!serial) throw new Error('Este navegador no soporta Web Serial. Usa Chrome u Opera en escritorio.');

    this.setStatus('connecting');
    this.disconnect(true);

    let port: SerialPortLike | null = null;
    try {
      port = await serial.requestPort();
      await port.open({ baudRate });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const cancelled = /No port selected|user cancelled|cancel/i.test(raw);
      const detail = cancelled ? 'Conexión cancelada.' : raw;
      this.setStatus(cancelled ? 'idle' : 'error', detail);
      throw new Error(detail);
    }

    this.port = port;
    this.onPortDisconnect = () => this.handleUnexpectedClose();
    port.addEventListener('disconnect', this.onPortDisconnect);

    try {
      if (!port.writable) throw new Error('El puerto no permite escritura.');
      this.writer = port.writable.getWriter();
      this.reading = true;
      void this.readLoop(port);
      this.events.onDevice?.(portLabel(port, baudRate), `serial-${baudRate}`);
      this.setStatus('connected');
    } catch (err) {
      this.release();
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus('error', message);
      throw new Error(message);
    }
  }

  disconnect(silent = false): void {
    if (!silent && !this.port) return;
    if (!silent) this.setStatus('disconnecting');
    this.reading = false;
    this.release();
    if (!silent) this.setStatus('idle');
  }

  async send(text: string): Promise<void> {
    if (!this.writer) throw new Error('No hay un puerto serie abierto.');
    const payload = new TextEncoder().encode(text.endsWith('\n') ? text : `${text}\n`);
    await this.writer.write(payload);
  }
}
