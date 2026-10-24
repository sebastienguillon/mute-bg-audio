// Accepts the controller's control port in the engine iframe. Page scripts share the parent
// window with the controller and see the engine's HELLO, so a CONNECT is only accepted with a
// token the background verifies (one it issued to a content script of the same tab).

/** Asks the background whether `token` was issued for this tab (consumes it). */
export type TokenVerifier = (token: string) => Promise<boolean>;

export class ConnectGate {
  private readonly verify: TokenVerifier;
  private readonly onAccept: (port: MessagePort) => void;
  private accepted = false;

  constructor(verify: TokenVerifier, onAccept: (port: MessagePort) => void) {
    this.verify = verify;
    this.onAccept = onAccept;
  }

  /** A CONNECT carrying `token` and `port`: accepted once verified; later ones are refused. */
  offer(token: unknown, port: MessagePort): void {
    if (this.accepted || typeof token !== 'string' || token === '') {
      port.close();
      return;
    }
    void this.verify(token)
      .catch(() => false)
      .then((ok) => {
        if (!ok || this.accepted) {
          port.close();
          return;
        }
        this.accepted = true;
        this.onAccept(port);
      });
  }
}
