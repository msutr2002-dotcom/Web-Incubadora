import { LineAssembler, type ConnectOptions, type Link, type LinkEvents, type LinkStatus } from './link';

export interface BleGattService {
  getCharacteristic(uuid: string): Promise<BleCharacteristic>;
}
export interface BleCharacteristic {
  startNotifications(): Promise<BleCharacteristic>;
  stopNotifications(): Promise<BleCharacteristic>;
  addEventListener(type: 'characteristicvaluechanged', cb: (ev: unknown) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', cb: (ev: unknown) => void): void;
  writeValueWithoutResponse?(data: BufferSource): Promise<void>;
  writeValue(data: BufferSource): Promise<void>;
}
export interface BleDevice extends EventTarget {
  id: string;
  name?: string | null;
  gatt?: {
    connected: boolean;
    connect(): Promise<{ getPrimaryService(uuid: string): Promise<BleGattService> }>;
    disconnect(): void;
  };
}
interface BleNavigator {
  bluetooth?: {
    requestDevice(options: unknown): Promise<BleDevice>;
  };
}
export interface BluetoothApi {
  requestDevice(options: unknown): Promise<BleDevice>;
}

export function getBluetooth(): BluetoothApi | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as unknown as BleNavigator;
  return nav.bluetooth ?? null;
}

export function isWebBluetoothSupported(): boolean {
  return getBluetooth() !== null;
}

export const NORDIC_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NORDIC_UART_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const NORDIC_UART_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

export const HM10_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
export const HM10_CHAR = '0000ffe1-0000-1000-8000-00805f9b34fb';

export const SERVICE_PRESETS: {
  id: string;
  label: string;
  service: string;
  rx: string;
  tx: string;
  combined: boolean;
}[] = [
  {
    id: 'nus',
    label: 'Nordic UART (ESP32 recomendado)',
    service: NORDIC_UART_SERVICE,
    rx: NORDIC_UART_RX,
    tx: NORDIC_UART_TX,
    combined: false,
  },
  {
    id: 'hm10',
    label: 'HM-10 / JDY-08 (transparente)',
    service: HM10_SERVICE,
    rx: HM10_CHAR,
    tx: HM10_CHAR,
    combined: true,
  },
];

export type BleStatus = LinkStatus;
export type BleEvents = LinkEvents;

export class BleLink implements Link {
  readonly transport = 'ble' as const;

  private device: BleDevice | null = null;
  private rx: BleCharacteristic | null = null;
  private readonly lines = new LineAssembler();
  private notifyHandler: ((ev: unknown) => void) | null = null;
  private disconnectedHandler: (() => void) | null = null;
  private status: LinkStatus = 'idle';

  constructor(private events: LinkEvents) {}

  isConnected(): boolean {
    return this.status === 'connected';
  }

  private setStatus(status: LinkStatus, detail?: string): void {
    this.status = status;
    this.events.onStatus(status, detail);
  }

  private async probe(serviceUuid: string, rxUuid: string, txUuid: string): Promise<void> {
    const device = this.device;
    if (!device?.gatt) throw new Error('GATT no disponible');
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(serviceUuid);
    const tx = await service.getCharacteristic(txUuid);
    const rx = rxUuid === txUuid ? tx : await service.getCharacteristic(rxUuid);

    this.notifyHandler = (ev: unknown) => {
      const value = (ev as { target: { value: DataView | null } }).target?.value;
      if (value) this.lines.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), this.events.onLine);
    };
    tx.addEventListener('characteristicvaluechanged', this.notifyHandler as never);
    await tx.startNotifications();
    this.rx = rx;
  }

  async connect(options: ConnectOptions = {}): Promise<void> {
    const bt = getBluetooth();
    if (!bt) throw new Error('Este navegador no soporta Web Bluetooth. Usa Chrome u Opera.');

    const presets = SERVICE_PRESETS.filter((p) => (options.presets ?? []).includes(p.id));
    if (presets.length === 0) throw new Error('Selecciona al menos un perfil de servicio.');

    this.setStatus('connecting');
    this.disconnect(true);

    try {
      const device = await bt.requestDevice({
        acceptAllDevices: true,
        optionalServices: presets.map((p) => p.service),
      });
      this.device = device;
      this.events.onDevice?.(device.name ?? null, device.id);

      let lastError: unknown = null;
      for (const preset of presets) {
        try {
          await this.probe(preset.service, preset.rx, preset.tx);
          this.disconnectedHandler = () => {
            this.setStatus('disconnecting');
            this.cleanup();
            this.setStatus('idle', 'El dispositivo se desconectó.');
          };
          device.addEventListener('gattserverdisconnected', this.disconnectedHandler as never);
          this.setStatus('connected');
          return;
        } catch (err) {
          lastError = err;
          this.teardownGatt();
        }
      }
      throw lastError instanceof Error ? lastError : new Error('No se encontró un servicio UART compatible.');
    } catch (err) {
      this.cleanup();
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = /cancel|chooser|User cancelled/i.test(message);
      const detail = cancelled ? 'Conexión cancelada.' : message;
      this.setStatus(cancelled ? 'idle' : 'error', detail);
      throw new Error(detail);
    }
  }

  private teardownGatt(): void {
    if (this.device?.gatt?.connected) {
      try {
        this.device.gatt.disconnect();
      } catch {
        /* ya cerrado */
      }
    }
    this.rx = null;
    this.lines.reset();
  }

  private cleanup(): void {
    if (this.device && this.disconnectedHandler) {
      this.device.removeEventListener('gattserverdisconnected', this.disconnectedHandler as never);
    }
    this.notifyHandler = null;
    this.disconnectedHandler = null;
    this.teardownGatt();
    this.device = null;
  }

  disconnect(silent = false): void {
    if (!silent) this.setStatus('disconnecting');
    this.cleanup();
    if (!silent) this.setStatus('idle');
  }

  async send(text: string): Promise<void> {
    if (!this.rx) throw new Error('No hay ningún comando de escritura disponible.');
    const payload = new TextEncoder().encode(text.endsWith('\n') ? text : `${text}\n`);
    if (this.rx.writeValueWithoutResponse) await this.rx.writeValueWithoutResponse(payload);
    else await this.rx.writeValue(payload);
  }

  getDeviceName(): string | null {
    return this.device?.name ?? null;
  }
}
