// noVNC ships plain JavaScript, so declare the slice of RFB the live desktop
// viewer uses. Upstream API: https://github.com/novnc/noVNC/blob/master/docs/API.md
// The package's only export is RFB itself, so there is no subpath to import.
declare module "@novnc/novnc" {
  interface RfbOptions {
    credentials?: { password?: string; username?: string; target?: string };
    shared?: boolean;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    qualityLevel: number;
    compressLevel: number;
    disconnect(): void;
  }
}
