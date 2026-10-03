export type LinkStatus = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';

export type Transport = 'ble' | 'serial';

export interface LinkEvents {
  onStatus: (status: LinkStatus, detail?: string) => void;
  onLine: (line: string) => void;
  onDevice?: (name: string | null, id: string) => void;
}

export interface ConnectOptions {
  presets?: string[];
  baudRate?: number;
}

export interface Link {
  readonly transport: Transport;
  connect(options: ConnectOptions): Promise<void>;
  disconnect(silent?: boolean): void;
  send(text: string): Promise<void>;
  isConnected(): boolean;
}

/** Acumula bytes de cualquier transporte y entrega líneas completas. */
export class LineAssembler {
  private buffer = '';
  private decoder = new TextDecoder('utf-8');

  push(chunk: Uint8Array, onLine: (line: string) => void): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    if (this.buffer.length > 8192) this.buffer = this.buffer.slice(-4096);
    let idx: number;
    while ((idx = this.buffer.search(/[\r\n]/)) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim()) onLine(line);
    }
  }

  /** Entrega la última línea si el flujo terminó sin salto de línea final. */
  flush(onLine: (line: string) => void): void {
    this.buffer += this.decoder.decode();
    const rest = this.buffer.trim();
    this.reset();
    if (rest) onLine(rest);
  }

  reset(): void {
    this.buffer = '';
    this.decoder = new TextDecoder('utf-8');
  }
}
