import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import { api, type ApiResponse } from "./api";
import { getSessionToken, setSessionToken, clearSessionToken } from "./session";
import type { Actions } from "../../server/src/actions";
import gtqLogo from "./assets/coins/gtq.jpg";
import usdtLogo from "./assets/coins/usdt.png";
import usdcLogo from "./assets/coins/usdc.png";
import solLogo from "./assets/coins/sol.png";
import ethLogo from "./assets/coins/eth.png";
import bnbLogo from "./assets/coins/bnb.png";
import polLogo from "./assets/coins/pol.png";
import avaxLogo from "./assets/coins/avax.png";
import trxLogo from "./assets/coins/trx.png";

const FIELDS = actionFields<typeof Actions>();

// Current session token for authenticated actions ("" when signed out).
const tok = () => getSessionToken() ?? "";

type Network = ApiResponse<typeof api, "getNetworks">["networks"][number];
type Tx = ApiResponse<typeof api, "listTransactions">["transactions"][number];
type CustUser = ApiResponse<typeof api, "listUsers">["users"][number];
type LedgerEntry = ApiResponse<typeof api, "listLedgerEntries">["entries"][number];

const GTQ_MINT = "GTqK16bpGTqhYhXQzfHCxySJW4EswwtNw6THJ8VAMcXd";

function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
function assetsForNetwork(net: Network | undefined): string[] {
  if (!net) return [];
  if (net.id === "solana") return ["GTQ", "SOL", "USDT", "USDC"];
  if (net.id === "robinhood") return ["ETH"];
  if (net.id === "tron") return ["TRX", "USDT", "USDC"];
  return [net.native, "USDT", "USDC"];
}
function ledgerOf(user: CustUser | null, network: string, asset: string): string | null {
  if (!user) return null;
  return user.ledger.find((l) => l.network === network && l.asset === asset)?.balance ?? "0";
}

// --- Coin logos + one-row-per-coin aggregation (NC Wallet style) ---
// Home shows ONE row per coin: USDT and USDC appear once with their TOTAL
// balance summed across every network. The network is chosen only inside
// the coin detail, when sending or receiving.
const COIN_LOGOS: Record<string, string> = {
  GTQ: gtqLogo, USDT: usdtLogo, USDC: usdcLogo, SOL: solLogo, ETH: ethLogo,
  BNB: bnbLogo, POL: polLogo, AVAX: avaxLogo, TRX: trxLogo,
};
const COIN_NAMES: Record<string, string> = {
  GTQ: "Quetzal", USDT: "Tether", USDC: "USD Coin", SOL: "Solana",
  ETH: "Ethereum", BNB: "BNB", POL: "Polygon", AVAX: "Avalanche", TRX: "Tron",
};
const AGG_ORDER = ["GTQ", "USDT", "USDC", "SOL", "ETH", "BNB", "POL", "AVAX", "TRX"];

function CoinLogo({ asset, size = 40 }: { asset: string; size?: number }) {
  const src = COIN_LOGOS[asset];
  if (src) {
    return <img src={src} alt={`Logo de ${asset}`} width={size} height={size} className="shrink-0 rounded-full" style={{ width: size, height: size }} />;
  }
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center justify-center rounded-full bg-[var(--surface2)] text-xs font-bold text-[var(--dim)]" style={{ width: size, height: size }}>
      {asset.slice(0, 4)}
    </span>
  );
}

function fmtTotal(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

type AggCoin = {
  asset: string;
  total: number;
  totalUsd: number | null;
  usdPrice: number | null;
  isGtq: boolean;
  networks: { network: string; networkName: string; balance: string }[];
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch { /* clipboard unavailable */ }
      }}
      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--accent-text)]"
    >
      {copied ? "¡Copiado!" : "Copiar"}
    </button>
  );
}

function QrImage({ payload }: { payload: string }) {
  // QR generated locally in the browser with the bundled `qrcode` library:
  // the address/payload never leaves the device (no external QR service).
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl(null);
    setFailed(false);
    QRCode.toDataURL(payload, { width: 260, margin: 2 })
      .then((u) => { if (active) setUrl(u); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [payload]);
  if (failed) {
    return <p className="break-all px-2 py-4 text-center text-xs text-[var(--dim)]">{payload}</p>;
  }
  if (!url) return <p className="py-8 text-center text-sm text-[var(--dim)]">Generando QR…</p>;
  return (
    <img src={url} alt="Código QR de pago" className="mx-auto h-[240px] w-[240px] rounded-xl bg-white p-1" />
  );
}

type DetectedBarcode = { rawValue?: string };
type BarcodeDetectorInstance = { detect: (source: HTMLVideoElement) => Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance;

function QrScanner({ onResult, onClose }: { onResult: (value: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const BD = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (!BD) {
      setError("Este navegador no incluye lector de códigos QR (BarcodeDetector). Escribe o pega la dirección de destino manualmente.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Este dispositivo no permite acceso a la cámara desde la app. Escribe o pega la dirección de destino manualmente.");
      return;
    }
    const detector = new BD({ formats: ["qr_code"] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        const video = videoRef.current;
        if (video) {
          video.srcObject = s;
          void video.play().catch(() => { /* preview only */ });
        }
        timer = setInterval(() => {
          const v = videoRef.current;
          if (!v || stopped) return;
          detector.detect(v)
            .then((codes) => {
              const value = codes[0]?.rawValue;
              if (value && !stopped) { stopped = true; onResult(value); }
            })
            .catch(() => { /* frame not ready yet */ });
        }, 350);
      })
      .catch(() => setError("No se pudo abrir la cámara. Revisa el permiso de cámara o escribe la dirección manualmente."));
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);
  return (
    <div className="space-y-3 rounded-2xl border border-[var(--gold)] bg-[var(--surface)] p-4">
      <p className="text-sm font-semibold">Escanea el código QR de destino</p>
      {error ? (
        <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>
      ) : (
        <>
          <video ref={videoRef} className="aspect-square w-full rounded-xl bg-black object-cover" playsInline muted aria-label="Vista de la cámara para escanear el QR" />
          <p className="text-center text-xs text-[var(--dim)]">Apunta la cámara al QR.</p>
        </>
      )}
      <button type="button" className={`${btnGhost} w-full`} onClick={onClose}>Cancelar escaneo</button>
    </div>
  );
}

// Parses a scanned QR value into send-form fields: a Solana Pay link
// (solana:<address>?amount=..&spl-token=..) or a plain address.
function parseScannedQr(raw: string): { address: string; amount?: string; isGtq?: boolean } | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.toLowerCase().startsWith("solana:")) {
    const rest = value.slice("solana:".length);
    const [address, query] = rest.split("?");
    if (!address) return null;
    const params = new URLSearchParams(query ?? "");
    const amount = params.get("amount") ?? undefined;
    const token = params.get("spl-token");
    return { address, amount: amount ?? undefined, isGtq: token === GTQ_MINT };
  }
  return { address: value };
}

const inputCls =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";
const labelCls = "block text-sm font-medium text-[var(--dim)] mb-1";
const btnPrimary =
  "w-full rounded-xl bg-[var(--accent)] px-4 py-3 font-display text-base font-bold text-black disabled:opacity-50";
const btnGhost =
  "rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-medium text-[var(--text)]";
const segWrap = "flex gap-1 rounded-xl bg-[var(--surface2)] p-1";
function segCls(active: boolean): string {
  return `flex-1 rounded-lg px-3 py-2 text-sm ${active ? "bg-[var(--accent)] font-bold text-black" : "font-medium text-[var(--dim)]"}`;
}

// ---------------------------------------------------------------------------
// App settings: only the GTQ service fee. There is NO seed phrase and NO
// vault in this wallet — users' wallets are Crossmint Smart Wallets created
// with the operator's API key alone (see the Crossmint panel).
// ---------------------------------------------------------------------------

function SettingsPanel({ feeGtq }: { feeGtq: string }) {
  const queryClient = useQueryClient();
  const [newFee, setNewFee] = useState(feeGtq);
  const [error, setError] = useState("");
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => { setNewFee(feeGtq); }, [feeGtq]);

  const update = useMutation({
    mutationFn: async () => api.updateAppSettings({ feeGtq: newFee, sessionToken: tok() }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["settings"] }); setSavedMsg("Ajustes guardados."); },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo guardar."),
  });

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="text-sm font-semibold">Cómo funciona esta wallet</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          No hay frase semilla: cada usuario recibe una Smart Wallet de Crossmint (Solana) creada solo con la
          API key del operador y ligada a su correo. Los saldos viven en el libro de la app.
        </p>
      </div>

      <form onSubmit={(ev) => { ev.preventDefault(); setError(""); setSavedMsg(""); update.mutate(); }} className="space-y-4">
        <div>
          <label htmlFor="u-fee" className={labelCls}>Comisión fija de envío y transferencia entre usuarios (en GTQ)</label>
          <input id="u-fee" {...FIELDS.updateAppSettings.feeGtq} inputMode="decimal" className={inputCls} value={newFee} onChange={(e) => setNewFee(e.target.value)} />
          <p className="mt-1 text-xs text-[var(--dim)]">El swap cobra 0.1% fijo, en GTQ. Toda comisión se paga en GTQ.</p>
        </div>
        {savedMsg && <p className="text-sm text-[var(--accent-text)]">{savedMsg}</p>}
        {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
        <button type="submit" className={btnPrimary} disabled={update.isPending}>{update.isPending ? "Guardando…" : "Guardar ajustes"}</button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function CreateUserForm() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [cmNote, setCmNote] = useState("");
  const create = useMutation({
    mutationFn: async () => api.createUser({ name, email, password }),
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setName(""); setEmail(""); setPassword("");
      if (d.crossmintError) {
        setCmNote(`Usuario registrado, pero su wallet no se creó: ${d.crossmintError} El operador puede crearla después.`);
      } else if (d.user.crossmintAddress) {
        setCmNote(`Wallet creada y ligada a su correo: ${d.user.crossmintAddress}`);
      } else {
        setCmNote("Usuario registrado.");
      }
    },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo crear el usuario."),
  });
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setError(""); setCmNote("");
    if (!name.trim()) { setError("Escribe el nombre del usuario."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Escribe un correo electrónico válido: será el acceso del usuario y quedará ligado para siempre a su wallet."); return; }
    if (password.length < 8) { setError("La contraseña debe tener al menos 8 caracteres."); return; }
    create.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-sm font-semibold">Registrar usuario con correo electrónico</p>
      <p className="text-xs text-[var(--dim)]">
        <strong className="text-[var(--text)]">El correo queda ligado a su wallet para siempre</strong>: no se puede cambiar ni reusar.
        Al registrarlo se crea automáticamente su wallet de Solana, ligada al mismo correo. La contraseña se guarda cifrada con hash: nunca se guarda en texto claro.
      </p>
      <div>
        <label htmlFor="nu-name" className={labelCls}>Nombre del usuario</label>
        <input id="nu-name" {...FIELDS.createUser.name} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Juan Pérez" />
      </div>
      <div>
        <label htmlFor="nu-email" className={labelCls}>Correo electrónico (permanente)</label>
        <input id="nu-email" {...FIELDS.createUser.email} type="email" autoComplete="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="usuario@correo.com" />
      </div>
      <div>
        <label htmlFor="nu-pass" className={labelCls}>Contraseña (mínimo 8 caracteres)</label>
        <input id="nu-pass" {...FIELDS.createUser.password} type="password" autoComplete="new-password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
      </div>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      {cmNote && <p className="text-sm text-[var(--accent-text)]" role="status">{cmNote}</p>}
      <button type="submit" className={btnPrimary} disabled={create.isPending}>
        {create.isPending ? "Registrando…" : "Registrar usuario"}
      </button>
    </form>
  );
}

function AuthScreen({ onAuth }: { onAuth: (token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register" | "recovery" | "reset">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");

  const login = useMutation({
    mutationFn: async () => api.login({ email, password }),
    onSuccess: (d) => { setSessionToken(d.sessionToken); setPassword(""); onAuth(d.sessionToken); },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo iniciar sesión."),
  });
  const register = useMutation({
    mutationFn: async () => api.createUser({ name, email, password }),
    onSuccess: (d) => {
      setSessionToken(d.sessionToken);
      setPassword(""); setConfirm("");
      onAuth(d.sessionToken);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo crear la cuenta."),
  });
  const requestCode = useMutation({
    mutationFn: async () => api.requestPasswordRecovery({ email }),
    onSuccess: () => {
      setMsg("Si el correo está registrado, te enviamos un código de 6 dígitos. Vence en 30 minutos. Revisa tu bandeja de entrada.");
      setMode("reset");
    },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo enviar el código."),
  });
  const reset = useMutation({
    mutationFn: async () => api.resetPassword({ email, code, newPassword: password }),
    onSuccess: () => {
      setMsg("Contraseña actualizada. Ya puedes iniciar sesión con tu contraseña nueva.");
      setPassword(""); setConfirm(""); setCode("");
      setMode("login");
    },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo actualizar la contraseña."),
  });

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const go = (m: typeof mode) => { setMode(m); setError(""); setMsg(""); };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setError(""); setMsg("");
    if (mode === "register" && !name.trim()) { setError("Escribe tu nombre."); return; }
    if (!emailOk) { setError("Escribe un correo electrónico válido."); return; }
    if (mode === "login") {
      if (!password) { setError("Escribe tu contraseña."); return; }
      login.mutate();
    } else if (mode === "register") {
      if (password.length < 8) { setError("La contraseña debe tener al menos 8 caracteres."); return; }
      if (password !== confirm) { setError("Las contraseñas no coinciden."); return; }
      register.mutate();
    } else if (mode === "recovery") {
      requestCode.mutate();
    } else {
      if (!/^\d{6}$/.test(code.trim())) { setError("Escribe el código de 6 dígitos que te enviamos por correo."); return; }
      if (password.length < 8) { setError("La contraseña nueva debe tener al menos 8 caracteres."); return; }
      if (password !== confirm) { setError("Las contraseñas no coinciden."); return; }
      reset.mutate();
    }
  };
  const pending = login.isPending || register.isPending || requestCode.isPending || reset.isPending;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <main className="mx-auto w-full max-w-md px-4 pb-16 pt-10">
        <p className="text-center font-display text-2xl font-extrabold">
          Quetzal <span className="text-[var(--accent-text)]">Wallet</span>
        </p>
        <p className="mt-1 text-center text-sm text-[var(--dim)]">
          {mode === "login" ? "Inicia sesión para abrir tu wallet."
            : mode === "register" ? "Crea tu cuenta con tu correo. Tu wallet queda ligada a ese correo para siempre."
            : mode === "recovery" ? "Te enviaremos un código de recuperación al correo de tu cuenta."
            : "Escribe el código que te enviamos y tu contraseña nueva."}
        </p>
        <form onSubmit={submit} className="mt-6 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          {mode === "register" && (
            <div>
              <label htmlFor="au-name" className={labelCls}>Nombre</label>
              <input id="au-name" {...FIELDS.createUser.name} autoComplete="name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" />
            </div>
          )}
          <div>
            <label htmlFor="au-email" className={labelCls}>Correo electrónico</label>
            <input id="au-email" {...FIELDS.login.email} type="email" autoComplete="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="usuario@correo.com" />
          </div>
          {(mode === "login" || mode === "register") && (
            <div>
              <label htmlFor="au-pass" className={labelCls}>Contraseña</label>
              <input id="au-pass" {...FIELDS.login.password} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
          )}
          {mode === "reset" && (
            <>
              <div>
                <label htmlFor="au-code" className={labelCls}>Código de recuperación (6 dígitos)</label>
                <input id="au-code" {...FIELDS.resetPassword.code} inputMode="numeric" autoComplete="one-time-code" className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
              </div>
              <div>
                <label htmlFor="au-newpass" className={labelCls}>Contraseña nueva</label>
                <input id="au-newpass" {...FIELDS.resetPassword.newPassword} type="password" autoComplete="new-password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
            </>
          )}
          {(mode === "register" || mode === "reset") && (
            <div>
              <label htmlFor="au-confirm" className={labelCls}>Confirmar contraseña</label>
              <input id="au-confirm" type="password" autoComplete="new-password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" />
            </div>
          )}
          {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
          {msg && <p className="text-sm text-[var(--accent-text)]" role="status">{msg}</p>}
          <button type="submit" className={btnPrimary} disabled={pending}>
            {pending ? "Espera…"
              : mode === "login" ? "Iniciar sesión"
              : mode === "register" ? "Crear mi cuenta"
              : mode === "recovery" ? "Enviar correo de recuperación"
              : "Guardar contraseña nueva"}
          </button>
        </form>
        <div className="mt-4 space-y-2 text-center text-sm">
          {mode === "login" && (
            <>
              <button type="button" className="block w-full font-medium text-[var(--accent-text)]" onClick={() => go("recovery")}>Olvidé mi contraseña</button>
              <button type="button" className="block w-full text-[var(--dim)]" onClick={() => go("register")}>¿No tienes cuenta? Crear cuenta</button>
            </>
          )}
          {mode === "register" && (
            <button type="button" className="block w-full text-[var(--dim)]" onClick={() => go("login")}>¿Ya tienes cuenta? Iniciar sesión</button>
          )}
          {(mode === "recovery" || mode === "reset") && (
            <>
              {mode === "reset" && (
                <button type="button" className="block w-full font-medium text-[var(--accent-text)]" onClick={() => { setError(""); setMsg(""); requestCode.mutate(); }}>Enviar otro código</button>
              )}
              <button type="button" className="block w-full text-[var(--dim)]" onClick={() => go("login")}>Volver a iniciar sesión</button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const change = useMutation({
    mutationFn: async () => api.changePassword({ sessionToken: tok(), currentPassword: current, newPassword: next }),
    onSuccess: () => { setCurrent(""); setNext(""); setConfirm(""); setMsg("Contraseña actualizada. Tus otras sesiones se cerraron."); },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo cambiar la contraseña."),
  });
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setError(""); setMsg("");
    if (!current) { setError("Escribe tu contraseña actual."); return; }
    if (next.length < 8) { setError("La contraseña nueva debe tener al menos 8 caracteres."); return; }
    if (next !== confirm) { setError("Las contraseñas no coinciden."); return; }
    change.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-sm font-semibold">Cambiar contraseña</p>
      <div>
        <label htmlFor="cp-current" className={labelCls}>Contraseña actual</label>
        <input id="cp-current" {...FIELDS.changePassword.currentPassword} type="password" autoComplete="current-password" className={inputCls} value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div>
        <label htmlFor="cp-next" className={labelCls}>Contraseña nueva</label>
        <input id="cp-next" {...FIELDS.changePassword.newPassword} type="password" autoComplete="new-password" className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <div>
        <label htmlFor="cp-confirm" className={labelCls}>Confirmar contraseña nueva</label>
        <input id="cp-confirm" type="password" autoComplete="new-password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      {msg && <p className="text-sm text-[var(--accent-text)]" role="status">{msg}</p>}
      <button type="submit" className={btnPrimary} disabled={change.isPending}>{change.isPending ? "Guardando…" : "Cambiar contraseña"}</button>
    </form>
  );
}

function CreditDepositForm({ user, networks }: { user: CustUser; networks: Network[] }) {
  const queryClient = useQueryClient();
  const [network, setNetwork] = useState("solana");
  const net = networks.find((n) => n.id === network);
  const [asset, setAsset] = useState("GTQ");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const credit = useMutation({
    mutationFn: async () => api.creditDeposit({ sessionToken: tok(), userId: user.id, network, asset, amount, note }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      setAmount(""); setMsg("Depósito acreditado a la cuenta de " + user.name + ".");
    },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo acreditar."),
  });
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setError(""); setMsg("");
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) { setError("Escribe una cantidad válida."); return; }
    credit.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-sm font-semibold">Agregar saldo manualmente a {user.name}</p>
      <p className="text-xs text-[var(--dim)]">Cuenta para el límite mensual de depósitos (10,000 GTQ sin KYC · 1,000,000 GTQ con KYC).</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="cd-net" className={labelCls}>Red</label>
          <select id="cd-net" className={inputCls} value={network} onChange={(e) => { setNetwork(e.target.value); setAsset(assetsForNetwork(networks.find((n) => n.id === e.target.value))[0] ?? "GTQ"); }}>
            {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="cd-asset" className={labelCls}>Moneda</label>
          <select id="cd-asset" className={inputCls} value={asset} onChange={(e) => setAsset(e.target.value)}>
            {assetsForNetwork(net).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="cd-amount" className={labelCls}>Cantidad</label>
        <input id="cd-amount" {...FIELDS.creditDeposit.amount} inputMode="decimal" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
      </div>
      <div>
        <label htmlFor="cd-note" className={labelCls}>Nota (opcional)</label>
        <input id="cd-note" {...FIELDS.creditDeposit.note} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      {msg && <p className="text-sm text-[var(--accent-text)]">{msg}</p>}
      <button type="submit" className={btnPrimary} disabled={credit.isPending}>{credit.isPending ? "Acreditando…" : "Acreditar depósito"}</button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Send / Swap per user (ledger)
// ---------------------------------------------------------------------------

function SendForm({ user, networks, fee, onDone, initialNetwork = "solana", initialAsset = "GTQ" }: {
  user: CustUser; networks: Network[]; fee: string; onDone: () => void;
  initialNetwork?: string; initialAsset?: string;
}) {
  const queryClient = useQueryClient();
  const [network, setNetwork] = useState(initialNetwork);
  const net = networks.find((n) => n.id === network);
  const [asset, setAsset] = useState(initialAsset);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [review, setReview] = useState(false);
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: () => api.listContacts({ sessionToken: tok() }) });
  const chainQ = useQuery({ queryKey: ["userBalances", user.id], queryFn: () => api.getUserBalances({ userId: user.id, sessionToken: tok() }) });

  const balance = ledgerOf(user, network, asset);
  const gtqBalance = ledgerOf(user, "solana", "GTQ");
  const nativeSym = net?.native ?? "";
  const nativeRow = chainQ.data?.assets.find((a) => a.network === network && a.asset === nativeSym);
  const gasUsd = nativeRow && nativeRow.usdPrice != null ? Number(nativeRow.balance) * nativeRow.usdPrice : null;

  const handleScan = (raw: string) => {
    setScanning(false);
    const parsed = parseScannedQr(raw);
    if (!parsed) { setError("El QR escaneado no contiene una dirección válida."); return; }
    setTo(parsed.address);
    if (parsed.isGtq) { setNetwork("solana"); setAsset("GTQ"); }
    if (parsed.amount) setAmount(parsed.amount);
    setError("");
  };

  const record = useMutation({
    mutationFn: async () => {
      const payload = network === "solana"
        ? `solana:${to}?amount=${amount}${asset === "GTQ" ? `&spl-token=${GTQ_MINT}` : ""}&label=Quetzal%20Wallet`
        : `${asset} en ${net?.name ?? network} → ${to}: ${amount}`;
      return api.recordUserTransaction({
        sessionToken: tok(),
        userId: user.id, kind: "send", network, fromAsset: asset, toAsset: null,
        amount, toAddress: to, note, payload, receiveAmount: "",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["ledger", user.id] });
      onDone();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo registrar el envío."),
  });

  const startReview = () => {
    setError("");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { setError("Escribe una cantidad válida."); return; }
    if (to.trim().length < 8) { setError("Escribe la dirección de destino completa."); return; }
    if (balance != null && amt > Number(balance)) { setError(`Saldo insuficiente: ${user.name} tiene ${balance} ${asset} en ${net?.name}.`); return; }
    if (gtqBalance != null && Number(fee) > Number(gtqBalance) && asset !== "GTQ") {
      setError(`Necesita ${fee} GTQ para la comisión y tiene ${gtqBalance} GTQ en su cuenta.`);
      return;
    }
    setReview(true);
  };

  if (review) {
    return (
      <div className="space-y-4">
        <h3 className="font-display text-lg font-bold">Revisa y firma el envío de {user.name}</h3>
        <dl className="space-y-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
          <div className="flex justify-between"><dt className="text-[var(--dim)]">Usuario</dt><dd className="font-semibold">{user.name}</dd></div>
          <div className="flex justify-between"><dt className="text-[var(--dim)]">Cantidad</dt><dd className="tnum font-semibold">{amount} {asset}</dd></div>
          <div className="flex justify-between"><dt className="text-[var(--dim)]">Red</dt><dd>{net?.name}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-[var(--dim)]">Destino</dt><dd className="break-all text-right">{to}</dd></div>
          <div className="flex justify-between"><dt className="text-[var(--dim)]">Comisión (en GTQ)</dt><dd className="tnum font-semibold text-[var(--gold)]">{fee} GTQ</dd></div>
          {note && <div className="flex justify-between gap-4"><dt className="text-[var(--dim)]">Nota</dt><dd className="text-right">{note}</dd></div>}
        </dl>
        <p className="text-xs text-[var(--dim)]">Se descuenta de la cuenta de {user.name} (cantidad + comisión en GTQ).</p>
        {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
        <button type="button" className={btnPrimary} disabled={record.isPending} onClick={() => record.mutate()}>
          {record.isPending ? "Firmando…" : "Firmar y confirmar envío"}
        </button>
        <button type="button" className={`${btnGhost} w-full`} onClick={() => setReview(false)}>Volver a editar</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {scanning && <QrScanner onResult={handleScan} onClose={() => setScanning(false)} />}
      <div>
        <label htmlFor="send-net" className={labelCls}>Red</label>
        <select id="send-net" className={inputCls} value={network} onChange={(e) => { setNetwork(e.target.value); setAsset(assetsForNetwork(networks.find((n) => n.id === e.target.value))[0] ?? "GTQ"); }}>
          {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="send-asset" className={labelCls}>Moneda</label>
        <select id="send-asset" className={inputCls} value={asset} onChange={(e) => setAsset(e.target.value)}>
          {assetsForNetwork(net).map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        {balance != null && <p className="mt-1 text-xs text-[var(--dim)]">Saldo disponible: <span className="tnum">{balance} {asset}</span></p>}
      </div>
      <div>
        <label htmlFor="send-amount" className={labelCls}>Cantidad</label>
        <input id="send-amount" {...FIELDS.recordUserTransaction.amount} inputMode="decimal" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
      </div>
      <div>
        <label htmlFor="send-to" className={labelCls}>Dirección de destino</label>
        <input id="send-to" {...FIELDS.recordUserTransaction.toAddress} className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} placeholder="Dirección del destinatario" />
        <button type="button" className={`${btnGhost} mt-2 w-full`} onClick={() => setScanning(true)}>
          Escanear QR de destino
        </button>
        {(contacts.data?.contacts ?? []).filter((c) => c.network === network).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {(contacts.data?.contacts ?? []).filter((c) => c.network === network).map((c) => (
              <button key={c.id} type="button" className={btnGhost} onClick={() => setTo(c.address)}>
                {c.name} · {shortAddr(c.address)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div>
        <label htmlFor="send-note" className={labelCls}>Nota (opcional)</label>
        <input id="send-note" {...FIELDS.recordUserTransaction.note} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <p className="text-sm text-[var(--dim)]">Comisión de servicio: <span className="tnum font-semibold text-[var(--gold)]">{fee} GTQ</span></p>
      {gasUsd != null && nativeRow ? (
        <p className="text-sm text-[var(--dim)]">
          Gas: <span className="tnum">{nativeRow.balance} {nativeSym}</span> ≈ {fmtUsd(gasUsd)}
          {gasUsd < 0.5
            ? <span className="text-[var(--danger)]"> · se requieren al menos $0.50 USD en {nativeSym} para el gas.</span>
            : <span className="text-[var(--accent-text)]"> · gas OK (mín. $0.50).</span>}
        </p>
      ) : (
        <p className="text-sm text-[var(--dim)]">Gas: se requieren al menos $0.50 USD en {nativeSym || "la moneda nativa"} en su dirección.</p>
      )}
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      <button type="button" className={btnPrimary} onClick={startReview}>Revisar y firmar</button>
    </div>
  );
}

function SwapForm({ user, networks, onDone, initialNetwork = "solana", initialAsset = "" }: {
  user: CustUser; networks: Network[]; onDone: () => void;
  initialNetwork?: string; initialAsset?: string;
}) {
  const queryClient = useQueryClient();
  const [network, setNetwork] = useState(initialNetwork);
  const net = networks.find((n) => n.id === network);
  const options = assetsForNetwork(net);
  const [from, setFrom] = useState(initialAsset && options.includes(initialAsset) ? initialAsset : "GTQ");
  const [toAsset, setToAsset] = useState(from === "USDC" ? "GTQ" : "USDC");
  const [amount, setAmount] = useState("");
  const [receive, setReceive] = useState("");
  const [review, setReview] = useState(false);
  const [error, setError] = useState("");
  const pricesQ = useQuery({ queryKey: ["userBalances", user.id], queryFn: () => api.getUserBalances({ userId: user.id, sessionToken: tok() }) });
  const priceOf = (sym: string) => pricesQ.data?.assets.find((b) => b.asset === sym && b.usdPrice != null)?.usdPrice ?? null;
  const fromPrice = priceOf(from);
  const toPrice = priceOf(toAsset);
  const autoReceive = fromPrice != null && toPrice != null && Number(amount) > 0
    ? (Number(amount) * fromPrice / toPrice).toFixed(6)
    : null;
  const receiveValue = autoReceive ?? receive;
  // Swap fee: fixed 0.1% of the swapped amount, charged in GTQ. When a leg is
  // GTQ the fee comes straight from that leg; otherwise the USD value of the
  // 0.1% is used as GTQ-equivalent units (GTQ has no public market price).
  const amtNum = Number(amount) || 0;
  const feeEstimate = from === "GTQ"
    ? amtNum * 0.001
    : toAsset === "GTQ" && Number(receiveValue) > 0
      ? Number(receiveValue) * 0.001
      : fromPrice != null
        ? amtNum * 0.001 * fromPrice
        : null;
  const feeLabel = feeEstimate != null
    ? `${feeEstimate.toLocaleString("en-US", { maximumFractionDigits: 6 })} GTQ`
    : "0.1% del monto, en GTQ";
  const nativeRowS = pricesQ.data?.assets.find((a) => a.network === network && a.asset === (net?.native ?? ""));
  const gasUsdS = nativeRowS && nativeRowS.usdPrice != null ? Number(nativeRowS.balance) * nativeRowS.usdPrice : null;

  const record = useMutation({
    mutationFn: async () =>
      api.recordUserTransaction({
      sessionToken: tok(),
        userId: user.id, kind: "swap", network, fromAsset: from, toAsset: toAsset,
        amount, toAddress: null, note: `Recibe ≈ ${receiveValue} ${toAsset}`,
        payload: `swap:${network}:${amount} ${from} -> ${receiveValue} ${toAsset}`,
        receiveAmount: receiveValue,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["ledger", user.id] });
      onDone();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo registrar el swap."),
  });

  const startReview = () => {
    setError("");
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) { setError("Escribe una cantidad válida."); return; }
    if (from === toAsset) { setError("Elige dos monedas distintas."); return; }
    if (!receiveValue || Number(receiveValue) <= 0) { setError("Escribe cuánto va a recibir."); return; }
    const bal = ledgerOf(user, network, from);
    if (bal != null && Number(amount) > Number(bal)) { setError(`Saldo insuficiente: tiene ${bal} ${from}.`); return; }
    setReview(true);
  };

  if (review) {
    return (
      <div className="space-y-4">
        <h3 className="font-display text-lg font-bold">Revisa y firma el swap de {user.name}</h3>
        <dl className="space-y-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
          <div className="flex justify-between"><dt className="text-[var(--dim)]">Entrega</dt><dd className="tnum font-semibold">{amount} {from}</dd></div>
          <div className="flex justify-between"><dt className="text-[var(--dim)]">Recibe ≈</dt><dd className="tnum font-semibold">{receiveValue} {toAsset}</dd></div>
          <div className="flex justify-between"><dt className="text-[var(--dim)]">Red</dt><dd>{net?.name}</dd></div>
          <div className="flex justify-between"><dt className="text-[var(--dim)]">Comisión de swap (0.1% fijo, en GTQ)</dt><dd className="tnum font-semibold text-[var(--gold)]">{feeLabel}</dd></div>
        </dl>
        <p className="text-xs text-[var(--dim)]">Se liquida en la cuenta de {user.name}.</p>
        {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
        <button type="button" className={btnPrimary} disabled={record.isPending} onClick={() => record.mutate()}>
          {record.isPending ? "Firmando…" : "Firmar y confirmar swap"}
        </button>
        <button type="button" className={`${btnGhost} w-full`} onClick={() => setReview(false)}>Volver a editar</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="swap-net" className={labelCls}>Red</label>
        <select id="swap-net" className={inputCls} value={network} onChange={(e) => {
          setNetwork(e.target.value);
          const opts = assetsForNetwork(networks.find((n) => n.id === e.target.value));
          setFrom(opts[0] ?? "GTQ"); setToAsset(opts[1] ?? "USDC");
        }}>
          {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="swap-from" className={labelCls}>Entrega</label>
          <select id="swap-from" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)}>
            {options.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="swap-to" className={labelCls}>Recibe</label>
          <select id="swap-to" className={inputCls} value={toAsset} onChange={(e) => setToAsset(e.target.value)}>
            {options.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="swap-amount" className={labelCls}>Cantidad a cambiar</label>
        <input id="swap-amount" {...FIELDS.recordUserTransaction.amount} inputMode="decimal" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        <p className="mt-1 text-xs text-[var(--dim)]">Saldo: <span className="tnum">{ledgerOf(user, network, from) ?? "0"} {from}</span></p>
      </div>
      <div>
        <label htmlFor="swap-receive" className={labelCls}>Cantidad que recibe</label>
        <input id="swap-receive" {...FIELDS.recordUserTransaction.receiveAmount} inputMode="decimal" className={inputCls} value={receiveValue}
          onChange={(e) => setReceive(e.target.value)} readOnly={autoReceive != null} placeholder="0.00" />
        <p className="mt-1 text-xs text-[var(--dim)]">
          {autoReceive != null ? "Estimado con precios de mercado en USD." : "Sin precio público de GTQ: escribe la cantidad acordada."}
        </p>
      </div>
      <p className="text-sm text-[var(--dim)]">Comisión de swap: <span className="font-semibold text-[var(--gold)]">0.1% fijo del monto, cobrado en GTQ</span>{feeEstimate != null && amtNum > 0 ? <> ≈ <span className="tnum font-semibold text-[var(--gold)]">{feeLabel}</span></> : null}</p>
      {gasUsdS != null && gasUsdS < 0.5 && (
        <p className="text-sm text-[var(--danger)]">Gas insuficiente: se requieren al menos $0.50 USD en {net?.native} en su dirección para operar en {net?.name} (ahora ≈ {fmtUsd(gasUsdS)}).</p>
      )}
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      <button type="button" className={btnPrimary} onClick={startReview}>Revisar y firmar</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Receive + GTQ QR charge (per user)
// ---------------------------------------------------------------------------

function ReceivePanel({ user, networks, initialNetwork = "solana" }: {
  user: CustUser; networks: Network[]; initialNetwork?: string;
}) {
  const [network, setNetwork] = useState(initialNetwork);
  const isCrossmint = network === "solana" && !!user.crossmintAddress;
  const address = isCrossmint
    ? user.crossmintAddress
    : user.addresses.find((a) => a.network === network)?.address ?? "";
  const net = networks.find((n) => n.id === network);
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="recv-net" className={labelCls}>Red para recibir</label>
        <select id="recv-net" className={inputCls} value={network} onChange={(e) => setNetwork(e.target.value)}>
          {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
        </select>
      </div>
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <QrImage payload={address} />
        <p className="mt-3 break-all text-center text-sm text-[var(--text)]">{address}</p>
        <p className="mt-1 text-center text-xs text-[var(--dim)]">
          Red {net?.name}{isCrossmint ? " · Wallet de Crossmint ligada a tu correo" : ""} — verifica la red antes de enviar fondos.
        </p>
        <div className="mt-3 flex justify-center">
          <CopyButton text={address} label="Copiar dirección de recepción del usuario" />
        </div>
      </div>
    </div>
  );
}

function GtqChargePanel({ user }: { user: CustUser }) {
  const solana = user.crossmintAddress || user.addresses.find((a) => a.network === "solana")?.address || "";
  const [amount, setAmount] = useState("");
  const [concept, setConcept] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState("");
  const generate = () => {
    setError("");
    if (!solana) { setError("Este usuario no tiene dirección de Solana."); return; }
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) { setError("Escribe la cantidad en GTQ."); return; }
    const payload = `solana:${solana}?amount=${amount}&spl-token=${GTQ_MINT}&label=${encodeURIComponent("Quetzal Wallet")}${concept ? `&message=${encodeURIComponent(concept)}` : ""}`;
    setShown(payload);
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--dim)]">Cobro con QR <strong className="text-[var(--text)]">solo en GTQ</strong>, sobre Solana.</p>
      <div>
        <label htmlFor="qr-amount" className={labelCls}>Cantidad en GTQ</label>
        <input id="qr-amount" inputMode="decimal" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
      </div>
      <div>
        <label htmlFor="qr-concept" className={labelCls}>Concepto (opcional)</label>
        <input id="qr-concept" className={inputCls} value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="Pago de…" />
      </div>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      <button type="button" className={btnPrimary} onClick={generate}>Generar QR de cobro en GTQ</button>
      {shown && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <QrImage payload={shown} />
          <p className="mt-3 text-center font-display text-lg font-bold"><span className="tnum">{amount} GTQ</span></p>
          <p className="break-all text-center text-xs text-[var(--dim)]">{shown}</p>
          <div className="mt-3 flex justify-center">
            <CopyButton text={shown} label="Copiar enlace de pago GTQ" />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Coin detail: ONE coin, total balance, per-network breakdown. The network
// is picked HERE — only for sending or receiving (NC Wallet style).
// ---------------------------------------------------------------------------

function CoinDetail({ user, coin, onBack, onSend, onReceive, onSwap }: {
  user: CustUser;
  coin: AggCoin;
  onBack: () => void;
  onSend: (network: string, asset: string) => void;
  onReceive: (network: string) => void;
  onSwap: (network: string, asset: string) => void;
}) {
  const multi = coin.networks.length > 1;
  const onlyNet = coin.networks[0]?.network ?? "solana";
  return (
    <div className="space-y-4">
      <button type="button" className={btnGhost} onClick={onBack}>← Volver a saldos</button>
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-center">
        <div className="flex justify-center"><CoinLogo asset={coin.asset} size={56} /></div>
        <p className="mt-2 font-display text-lg font-bold">{coin.asset} <span className="text-sm font-medium text-[var(--dim)]">· {COIN_NAMES[coin.asset] ?? ""}</span></p>
        <p className="tnum mt-1 font-display text-3xl font-extrabold">{fmtTotal(coin.total)} {coin.asset}</p>
        <p className="tnum mt-0.5 text-sm text-[var(--dim)]">
          {coin.totalUsd != null ? `≈ ${fmtUsd(coin.totalUsd)} en total` : coin.isGtq ? "Token principal · Solana" : "Sin precio público"}
        </p>
        {multi && <p className="mt-1 text-xs text-[var(--dim)]">Saldo total en {coin.networks.length} redes. Elige la red solo al enviar o recibir.</p>}
        {!multi && (
          <div className="mt-4 grid grid-cols-3 gap-2">
            <button type="button" className="rounded-xl bg-[var(--accent)] px-3 py-2.5 font-display text-sm font-bold text-black" onClick={() => onSend(onlyNet, coin.asset)}>Enviar</button>
            <button type="button" className={btnGhost} onClick={() => onReceive(onlyNet)}>Recibir</button>
            <button type="button" className={btnGhost} onClick={() => onSwap(onlyNet, coin.asset)}>Swap</button>
          </div>
        )}
      </div>
      {multi && (
        <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <p className="border-b border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Saldo por red</p>
          <ul>
            {coin.networks.map((n) => {
              const addr = n.network === "solana" && user.crossmintAddress
                ? user.crossmintAddress
                : user.addresses.find((a) => a.network === n.network)?.address ?? "";
              return (
                <li key={n.network} className="border-b border-[var(--border)] px-4 py-3 last:border-b-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{n.networkName}</p>
                      <p className="truncate text-xs text-[var(--dim)]">{shortAddr(addr)}</p>
                    </div>
                    <p className="tnum shrink-0 font-semibold">{n.balance} {coin.asset}</p>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <button type="button" aria-label={`Enviar ${coin.asset} por ${n.networkName}`} className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-bold text-black" onClick={() => onSend(n.network, coin.asset)}>Enviar</button>
                    <button type="button" aria-label={`Recibir ${coin.asset} por ${n.networkName}`} className={btnGhost} onClick={() => onReceive(n.network)}>Recibir</button>
                    <button type="button" aria-label={`Swap de ${coin.asset} en ${n.networkName}`} className={btnGhost} onClick={() => onSwap(n.network, coin.asset)}>Swap</button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal transfer
// ---------------------------------------------------------------------------

function InternalTransferForm({ fromUser, fee, onDone }: {
  fromUser: CustUser; fee: string; onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const recipientsQ = useQuery({ queryKey: ["recipients"], queryFn: () => api.listTransferRecipients({ sessionToken: tok() }) });
  const others = (recipientsQ.data?.recipients ?? []).filter((u) => u.id !== fromUser.id);
  const networksQ = useQuery({ queryKey: ["networks"], queryFn: () => api.getNetworks({}) });
  const networks = networksQ.data?.networks ?? [];
  const [toUserId, setToUserId] = useState(0);
  useEffect(() => { if (!toUserId && others[0]) setToUserId(others[0].id); }, [others, toUserId]);
  const [network, setNetwork] = useState("solana");
  const net = networks.find((n) => n.id === network);
  const [asset, setAsset] = useState("GTQ");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const balance = ledgerOf(fromUser, network, asset);

  const transfer = useMutation({
    mutationFn: async () => api.internalTransfer({
      sessionToken: tok(), fromUserId: fromUser.id, toUserId, network, asset, amount, note,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      onDone();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo hacer la transferencia."),
  });

  if (recipientsQ.isPending) {
    return <p className="text-sm text-[var(--dim)]">Cargando usuarios…</p>;
  }
  if (others.length === 0) {
    return <p className="text-sm text-[var(--dim)]">Todavía no hay otros usuarios registrados a quienes transferir.</p>;
  }
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setError("");
    if (!toUserId) { setError("Elige el usuario destino."); return; }
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) { setError("Escribe una cantidad válida."); return; }
    if (balance != null && Number(amount) > Number(balance)) { setError(`Saldo insuficiente: ${fromUser.name} tiene ${balance} ${asset}.`); return; }
    transfer.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-[var(--dim)]">
        Instantánea, solo entre cuentas de la app. Comisión al remitente: <span className="tnum font-semibold text-[var(--gold)]">{fee} GTQ</span>.
      </p>
      <div>
        <label htmlFor="it-to" className={labelCls}>Usuario destino</label>
        <select id="it-to" className={inputCls} value={toUserId} onChange={(e) => setToUserId(Number(e.target.value))}>
          {others.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="it-net" className={labelCls}>Red</label>
          <select id="it-net" className={inputCls} value={network} onChange={(e) => { setNetwork(e.target.value); setAsset(assetsForNetwork(networks.find((n) => n.id === e.target.value))[0] ?? "GTQ"); }}>
            {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="it-asset" className={labelCls}>Moneda</label>
          <select id="it-asset" className={inputCls} value={asset} onChange={(e) => setAsset(e.target.value)}>
            {assetsForNetwork(net).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="it-amount" className={labelCls}>Cantidad</label>
        <input id="it-amount" {...FIELDS.internalTransfer.amount} inputMode="decimal" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
        {balance != null && <p className="mt-1 text-xs text-[var(--dim)]">Saldo de {fromUser.name}: <span className="tnum">{balance} {asset}</span></p>}
      </div>
      <div>
        <label htmlFor="it-note" className={labelCls}>Nota (opcional)</label>
        <input id="it-note" {...FIELDS.internalTransfer.note} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      <button type="submit" className={btnPrimary} disabled={transfer.isPending}>
        {transfer.isPending ? "Transfiriendo…" : "Transferir al instante"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Activity + contacts
// ---------------------------------------------------------------------------

function ContactsPanel({ networks }: { networks: Network[] }) {
  const queryClient = useQueryClient();
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: () => api.listContacts({ sessionToken: tok() }) });
  const [name, setName] = useState("");
  const [network, setNetwork] = useState("solana");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const add = useMutation({
    mutationFn: async () => api.addContact({ sessionToken: tok(), name, network, address }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["contacts"] }); setName(""); setAddress(""); },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo guardar el contacto."),
  });
  const del = useMutation({
    mutationFn: async (id: number) => api.deleteContact({ id, sessionToken: tok() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["contacts"] }),
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo borrar el contacto."),
  });
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setError("");
    if (!name.trim()) { setError("Escribe el nombre del contacto."); return; }
    if (address.trim().length < 8) { setError("Escribe la dirección completa del contacto."); return; }
    add.mutate();
  };
  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {(contacts.data?.contacts ?? []).map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{c.name}</p>
              <p className="truncate text-xs text-[var(--dim)]">{networks.find((n) => n.id === c.network)?.name ?? c.network} · {shortAddr(c.address)}</p>
            </div>
            <button type="button" aria-label={`Borrar contacto ${c.name}`} className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--danger)]" onClick={() => del.mutate(c.id)}>
              Borrar
            </button>
          </li>
        ))}
        {(contacts.data?.contacts ?? []).length === 0 && (
          <li className="text-sm text-[var(--dim)]">Todavía no tienes contactos guardados.</li>
        )}
      </ul>
      <form onSubmit={submit} className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="text-sm font-semibold">Agregar contacto</p>
        <div>
          <label htmlFor="ct-name" className={labelCls}>Nombre</label>
          <input id="ct-name" {...FIELDS.addContact.name} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="ct-net" className={labelCls}>Red</label>
          <select id="ct-net" className={inputCls} value={network} onChange={(e) => setNetwork(e.target.value)}>
            {networks.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="ct-addr" className={labelCls}>Dirección</label>
          <input id="ct-addr" {...FIELDS.addContact.address} className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
        <button type="submit" className={btnPrimary} disabled={add.isPending}>{add.isPending ? "Guardando…" : "Guardar contacto"}</button>
      </form>
    </div>
  );
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "send": return "Envío";
    case "swap": return "Swap";
    case "internal": return "Transferencia entre usuarios";
    case "deposit": return "Depósito";
    case "internal_in": return "Recibido de un usuario";
    case "internal_out": return "Enviado a un usuario";
    case "fee": return "Comisión";
    default: return kind;
  }
}

function TxList({ txs, networks, users }: { txs: Tx[]; networks: Network[]; users: { id: number; name: string }[] }) {
  if (txs.length === 0) {
    return <p className="text-sm text-[var(--dim)]">Todavía no hay operaciones.</p>;
  }
  const nameOf = (id: number | null) => (id == null ? null : users.find((u) => u.id === id)?.name ?? `Usuario #${id}`);
  return (
    <ul className="space-y-2">
      {txs.map((t) => (
        <li key={t.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2.5 font-medium">
              <CoinLogo asset={t.fromAsset} size={28} />
              <span>
                {kindLabel(t.kind)} · <span className="tnum">{t.amount} {t.fromAsset}</span>
                {t.toAsset && t.kind === "swap" ? <span className="text-[var(--dim)]"> → {t.toAsset}</span> : null}
              </span>
            </p>
            <span className="shrink-0 rounded-full bg-[var(--surface2)] px-2 py-0.5 text-xs text-[var(--accent-text)]">{t.status}</span>
          </div>
          <p className="mt-1 text-xs text-[var(--dim)]">
            {networks.find((n) => n.id === t.network)?.name ?? t.network}
            {nameOf(t.userId) ? ` · ${nameOf(t.userId)}` : ""}
            {nameOf(t.relatedUserId) ? ` → ${nameOf(t.relatedUserId)}` : ""}
            {t.toAddress ? ` · a ${shortAddr(t.toAddress)}` : ""}
            {" · "}comisión <span className="tnum text-[var(--gold)]">{t.feeGtq} GTQ</span>
            {" · "}{new Date(t.createdAt).toLocaleString()}
          </p>
          {t.note && <p className="mt-1 text-xs text-[var(--dim)]">{t.note}</p>}
        </li>
      ))}
    </ul>
  );
}

function LedgerList({ entries, networks, users }: { entries: LedgerEntry[]; networks: Network[]; users: { id: number; name: string }[] }) {
  if (entries.length === 0) return <p className="text-sm text-[var(--dim)]">Este usuario todavía no tiene movimientos en su libro.</p>;
  const nameOf = (id: number | null) => (id == null ? null : users.find((u) => u.id === id)?.name ?? `Usuario #${id}`);
  return (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li key={e.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
          <CoinLogo asset={e.asset} size={28} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{kindLabel(e.kind)} · {networks.find((n) => n.id === e.network)?.name ?? e.network}</p>
            <p className="truncate text-xs text-[var(--dim)]">
              {new Date(e.createdAt).toLocaleString()}
              {nameOf(e.relatedUserId) ? ` · con ${nameOf(e.relatedUserId)}` : ""}
              {e.note ? ` · ${e.note}` : ""}
            </p>
          </div>
          <p className={`tnum shrink-0 text-sm font-semibold ${Number(e.amount) < 0 ? "text-[var(--danger)]" : "text-[var(--accent-text)]"}`}>
            {Number(e.amount) > 0 ? "+" : ""}{e.amount} {e.asset}
          </p>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Profile: email, phone, KYC, monthly limits, verified-badge authority
// ---------------------------------------------------------------------------

const KYC_AUTHORITY = "gt.guatemala.com@gmail.com";

function KycBadge({ status }: { status: string }) {
  if (status === "verified") {
    return <span className="rounded-full bg-[var(--gold)] px-2.5 py-0.5 text-xs font-bold text-black">Verificado KYC</span>;
  }
  if (status === "requested") {
    return <span className="rounded-full border border-[var(--gold)] px-2.5 py-0.5 text-xs font-semibold text-[var(--gold)]">KYC solicitado</span>;
  }
  return <span className="rounded-full border border-[var(--border)] px-2.5 py-0.5 text-xs text-[var(--dim)]">Sin KYC</span>;
}

function LimitBar({ label, used, limit }: { label: string; used: string; limit: number }) {
  const pct = Math.min(100, (Number(used) || 0) / limit * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-[var(--dim)]">{label}</span>
        <span className="tnum"><strong>{Number(used).toLocaleString("en-US", { maximumFractionDigits: 2 })}</strong> / {limit.toLocaleString("en-US")} GTQ</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface2)]">
        <div className={`h-full rounded-full ${pct >= 100 ? "bg-[var(--danger)]" : "bg-[var(--gold)]"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ProfilePanel({ user, users }: { user: CustUser; users: CustUser[] }) {
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState(user.phone);
  const [phoneMsg, setPhoneMsg] = useState("");
  const [error, setError] = useState("");
  const [authorityEmail, setAuthorityEmail] = useState("");
  const [authMsg, setAuthMsg] = useState("");
  const usageQ = useQuery({ queryKey: ["usage", user.id], queryFn: () => api.getMonthlyUsage({ userId: user.id, sessionToken: tok() }) });

  useEffect(() => { setPhone(user.phone); }, [user.id, user.phone]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["users"] });
    queryClient.invalidateQueries({ queryKey: ["usage"] });
  };
  const savePhone = useMutation({
    mutationFn: async () => api.updateUserProfile({ userId: user.id, phone, sessionToken: tok() }),
    onSuccess: () => { invalidateAll(); setPhoneMsg("Teléfono guardado en el perfil."); },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo guardar el teléfono."),
  });
  const reqKyc = useMutation({
    mutationFn: async () => api.requestKyc({ userId: user.id, sessionToken: tok() }),
    onSuccess: () => invalidateAll(),
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo registrar la solicitud de KYC."),
  });
  const grant = useMutation({
    mutationFn: async (targetId: number) => api.setKycVerified({ userId: targetId, authorityEmail, sessionToken: tok() }),
    onSuccess: () => { invalidateAll(); setAuthMsg("Insignia de verificado otorgada."); },
    onError: (e) => setAuthMsg(e instanceof Error ? e.message : "No se pudo otorgar la insignia."),
  });

  const mailto = `mailto:${KYC_AUTHORITY}?subject=${encodeURIComponent("Solicitud de KYC — Quetzal Wallet")}&body=${encodeURIComponent(`Hola, solicito la verificación KYC de mi cuenta de Quetzal Wallet.\n\nNombre: ${user.name}\nCorreo de mi cuenta: ${user.email}\nTeléfono: ${phone || user.phone || ""}\n\nAdjunto mis documentos de identidad.`)}`;
  const usage = usageQ.data;
  const limit = usage?.limitGtq ?? (user.kycStatus === "verified" ? 1000000 : 10000);
  const pending = users.filter((u) => u.kycStatus === "requested");

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display text-base font-bold">{user.name}</h3>
          <KycBadge status={user.kycStatus} />
        </div>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--dim)]">Correo electrónico</dt>
            <dd className="break-all text-right font-medium">{user.email}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--dim)]">Cuenta</dt>
            <dd>#{user.accountIndex} · ligada a este correo para siempre</dd>
          </div>
        </dl>
        <form className="mt-4 space-y-2" onSubmit={(ev) => { ev.preventDefault(); setError(""); setPhoneMsg(""); savePhone.mutate(); }}>
          <label htmlFor="pf-phone" className={labelCls}>Número de teléfono</label>
          <div className="flex gap-2">
            <input id="pf-phone" {...FIELDS.updateUserProfile.phone} type="tel" autoComplete="tel" className={inputCls} value={phone}
              onChange={(e) => setPhone(e.target.value)} placeholder="+502 5555 5555" />
            <button type="submit" className="shrink-0 rounded-xl bg-[var(--accent)] px-4 py-2 font-display text-sm font-bold text-black" disabled={savePhone.isPending}>
              {savePhone.isPending ? "Guardando…" : "Guardar"}
            </button>
          </div>
          {phoneMsg && <p className="text-sm text-[var(--accent-text)]">{phoneMsg}</p>}
        </form>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="text-sm font-semibold">Verificación KYC</h3>
        {user.kycStatus === "verified" ? (
          <p className="mt-1 text-sm text-[var(--dim)]">
            Esta cuenta tiene la <strong className="text-[var(--gold)]">insignia de verificado</strong>, otorgada por {KYC_AUTHORITY}.
            Su límite mensual es de <strong className="text-[var(--text)]">1,000,000 GTQ</strong> en depósitos y en retiros.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Límite sin KYC: <strong className="text-[var(--text)]">10,000 GTQ/mes</strong>. Con KYC: <strong className="text-[var(--text)]">1,000,000 GTQ/mes</strong>, en depósitos y retiros.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <a href={mailto} className="rounded-xl bg-[var(--accent)] px-4 py-3 text-center font-display text-base font-bold text-black">
                Solicitar KYC por correo
              </a>
              <button type="button" className={btnGhost} disabled={reqKyc.isPending || user.kycStatus === "requested"} onClick={() => { setError(""); reqKyc.mutate(); }}>
                {user.kycStatus === "requested" ? "KYC solicitado — en espera" : reqKyc.isPending ? "Registrando…" : "Ya lo solicité por correo"}
              </button>
            </div>
          </>
        )}
        <div className="mt-4 space-y-3">
          <h4 className="text-sm font-semibold">Uso de límites este mes</h4>
          {usageQ.isPending ? (
            <p className="text-sm text-[var(--dim)]">Calculando uso del mes…</p>
          ) : usage ? (
            <>
              <LimitBar label="Depósitos del mes" used={usage.depositsGtq} limit={limit} />
              <LimitBar label="Retiros (envíos) del mes" used={usage.withdrawalsGtq} limit={limit} />
              <p className="text-xs text-[var(--dim)]">Las demás monedas cuentan por su valor en USD. El servidor rechaza lo que pase el límite.</p>
            </>
          ) : (
            <p className="text-sm text-[var(--dim)]">No se pudo calcular el uso del mes.</p>
          )}
        </div>
      </div>

      {users.length > 0 && (
      <div className="rounded-2xl border border-[var(--gold)] bg-[var(--surface)] p-4">
        <h3 className="text-sm font-semibold">Autoridad KYC — dar insignia de verificado</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Solo <strong className="text-[var(--text)]">{KYC_AUTHORITY}</strong> puede otorgarla. Otro correo es rechazado.
        </p>
        <div className="mt-3">
          <label htmlFor="kyc-auth-email" className={labelCls}>Correo de la autoridad KYC</label>
          <input id="kyc-auth-email" {...FIELDS.setKycVerified.authorityEmail} type="email" autoComplete="email" className={inputCls}
            value={authorityEmail} onChange={(e) => setAuthorityEmail(e.target.value)} placeholder={KYC_AUTHORITY} />
        </div>
        {pending.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--dim)]">Ningún usuario tiene el KYC en estado «solicitado» ahora mismo.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {pending.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 rounded-xl bg-[var(--surface2)] px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{u.name}</p>
                  <p className="truncate text-xs text-[var(--dim)]">{u.email} · solicitó KYC</p>
                </div>
                <button type="button" className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-bold text-black"
                  disabled={grant.isPending || !authorityEmail.trim()}
                  onClick={() => { setAuthMsg(""); grant.mutate(u.id); }}>
                  Dar insignia de verificado
                </button>
              </li>
            ))}
          </ul>
        )}
        {authMsg && <p className="mt-2 text-sm text-[var(--accent-text)]" role="status">{authMsg}</p>}
      </div>
      )}
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

type Tab = "home" | "enviar" | "recibir" | "historial" | "perfil";

const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "enviar", label: "Enviar" },
  { id: "recibir", label: "Recibir" },
  { id: "historial", label: "Historial" },
  { id: "perfil", label: "Perfil" },
];

const TAB_ICONS: Record<Tab, ReactNode> = {
  home: (<><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></>),
  enviar: (<><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>),
  recibir: (<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>),
  historial: (<><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></>),
  perfil: (<><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>),
};

export function App() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("home");
  const [homeView, setHomeView] = useState<"saldos" | "agregar" | "detalle">("saldos");
  const [detailAsset, setDetailAsset] = useState<string | null>(null);
  const [flowNetwork, setFlowNetwork] = useState("solana");
  const [flowAsset, setFlowAsset] = useState("GTQ");
  const [flowKey, setFlowKey] = useState(0);
  const [lastAutoSync, setLastAutoSync] = useState("");
  const [histView, setHistView] = useState<"ops" | "libro">("ops");
  const [perfilView, setPerfilView] = useState<"menu" | "perfil" | "usuarios" | "ajustes" | "contactos" | "password">("menu");
  const [sendMode, setSendMode] = useState<"enviar" | "swap" | "transferir">("enviar");
  const [receiveMode, setReceiveMode] = useState<"recibir" | "qr">("recibir");
  const [justDone, setJustDone] = useState(false);
  const [token, setToken] = useState<string | null>(() => getSessionToken());
  const [syncMsg, setSyncMsg] = useState("");
  const [expandedUser, setExpandedUser] = useState<number | null>(null);

  const networksQ = useQuery({ queryKey: ["networks"], queryFn: () => api.getNetworks({}) });
  const settingsQ = useQuery({ queryKey: ["settings"], queryFn: () => api.getAppSettings({}) });
  const sessionQ = useQuery({
    queryKey: ["session", token],
    queryFn: () => api.getSessionUser({ sessionToken: token ?? "" }),
    enabled: token != null,
  });
  const sessionUser = sessionQ.data?.user ?? null;
  const isOperator = sessionUser?.accountIndex === 0;
  const usersQ = useQuery({
    queryKey: ["users"],
    queryFn: () => api.listUsers({ sessionToken: tok() }),
    enabled: isOperator,
  });
  const recipientsQ = useQuery({
    queryKey: ["recipients"],
    queryFn: () => api.listTransferRecipients({ sessionToken: tok() }),
    enabled: sessionUser != null,
  });
  const txQ = useQuery({
    queryKey: ["transactions"],
    queryFn: () => api.listTransactions({ limit: 50, sessionToken: tok() }),
    enabled: sessionUser != null,
    refetchInterval: 30000,
  });

  // An expired or revoked token ends the session locally too.
  useEffect(() => {
    if (token && sessionQ.data && !sessionQ.data.user) {
      clearSessionToken();
      setToken(null);
    }
  }, [token, sessionQ.data]);

  const logout = useMutation({
    mutationFn: async () => api.logout({ sessionToken: token ?? "" }),
    onSettled: () => { clearSessionToken(); setToken(null); queryClient.clear(); },
  });

  const networks = useMemo(() => networksQ.data?.networks ?? [], [networksQ.data]);
  const users = useMemo(() => usersQ.data?.users ?? [], [usersQ.data]);
  const fee = settingsQ.data?.feeGtq ?? "1";
  const selected = sessionUser;
  const directory = isOperator ? users : (recipientsQ.data?.recipients ?? []);

  const balancesQ = useQuery({
    queryKey: ["userBalances", selected?.id],
    queryFn: () => api.getUserBalances({ userId: selected!.id, sessionToken: tok() }),
    enabled: selected != null,
    refetchInterval: 30000,
  });
  const ledgerQ = useQuery({
    queryKey: ["ledger", selected?.id],
    queryFn: () => api.listLedgerEntries({ userId: selected!.id, limit: 50, sessionToken: tok() }),
    enabled: selected != null,
    refetchInterval: 30000,
  });

  const sync = useMutation({
    mutationFn: async () => api.syncUserDeposits({ userId: selected!.id, sessionToken: tok() }),
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["ledger", selected?.id] });
      balancesQ.refetch();
      setSyncMsg(d.credited.length === 0
        ? "Sin depósitos nuevos en cadena para este usuario."
        : "Depósitos acreditados: " + d.credited.map((c) => `${c.amount} ${c.asset} (${c.network})`).join(", "));
    },
    onError: (e) => setSyncMsg(e instanceof Error ? e.message : "No se pudo sincronizar."),
  });

  // Automatic deposit sync, NC Wallet style: runs when the app opens, when
  // the active user changes, and every 60 s while the app is open. The user
  // never has to press a sync button for deposits to appear.
  const autoSync = useMutation({
    mutationFn: async () => api.syncAllDeposits({}),
    onSuccess: (d) => {
      setLastAutoSync(d.fetchedAt);
      if (d.credited.length > 0) {
        queryClient.invalidateQueries({ queryKey: ["users"] });
        queryClient.invalidateQueries({ queryKey: ["transactions"] });
        queryClient.invalidateQueries({ queryKey: ["ledger"] });
        const mine = d.credited.filter((c) => c.userId === selected?.id);
        if (mine.length > 0) {
          setSyncMsg("Depósito acreditado automáticamente: " + mine.map((c) => `${c.amount} ${c.asset} (${c.network})`).join(", "));
        }
      }
    },
  });
  const autoSyncMutate = autoSync.mutate;
  useEffect(() => {
    if (!selected) return;
    autoSyncMutate();
    const t = setInterval(() => autoSyncMutate(), 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const assets = balancesQ.data?.assets ?? [];
  // One row per coin: balances summed across ALL networks (USDT total,
  // USDC total, …). Networks only appear inside the coin detail.
  const aggregated = useMemo<AggCoin[]>(() => {
    const map = new Map<string, AggCoin>();
    for (const a of assets) {
      let agg = map.get(a.asset);
      if (!agg) {
        agg = { asset: a.asset, total: 0, totalUsd: null, usdPrice: a.usdPrice, isGtq: a.isGtq, networks: [] };
        map.set(a.asset, agg);
      }
      const bal = Number(a.balance) || 0;
      agg.total += bal;
      if (a.usdPrice != null) agg.totalUsd = (agg.totalUsd ?? 0) + bal * a.usdPrice;
      agg.networks.push({ network: a.network, networkName: a.networkName, balance: a.balance });
    }
    const netOrder = new Map(networks.map((n, i) => [n.id, i]));
    for (const agg of map.values()) {
      agg.networks.sort((x, y) => (netOrder.get(x.network) ?? 99) - (netOrder.get(y.network) ?? 99));
    }
    return [...map.values()].sort((x, y) => {
      const ix = AGG_ORDER.indexOf(x.asset);
      const iy = AGG_ORDER.indexOf(y.asset);
      return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy);
    });
  }, [assets, networks]);
  const totalUsdAll = aggregated.reduce<number | null>(
    (acc, a) => (a.totalUsd != null ? (acc ?? 0) + a.totalUsd : acc), null,
  );
  const detailCoin = detailAsset ? aggregated.find((a) => a.asset === detailAsset) ?? null : null;

  useEffect(() => { setDetailAsset(null); setHomeView("saldos"); }, [selected?.id]);
  useEffect(() => { if (tab !== "home") { setDetailAsset(null); setHomeView("saldos"); } }, [tab ]);

  const totalGtqLedger = (selected?.ledger ?? []).filter((l) => l.asset === "GTQ")
    .reduce((sum, l) => sum + (Number(l.balance) || 0), 0);
  const loading = networksQ.isPending || (token != null && sessionQ.isPending);

  // Session gate: without a valid session the only screen is access
  // (login / register / password recovery). There is no user switcher:
  // each person only ever sees and operates their own account.
  if (token == null) {
    return <AuthScreen onAuth={(t) => setToken(t)} />;
  }
  if (!selected) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-[var(--text)]">
        <p className="text-sm text-[var(--dim)]">Cargando tu wallet…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-28">
        {/* Compact header: solo el saldo total, sin tarjeta de explicación */}
        <header className="pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs text-[var(--dim)]">Quetzal Wallet</p>
              <p className="font-display text-3xl font-extrabold">
                <span className="tnum">{totalGtqLedger.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>{" "}
                <span className="text-[var(--accent-text)]">GTQ</span>
              </p>
              <p className="text-xs text-[var(--dim)]">Saldo total · Solana</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent)] font-display text-lg font-extrabold text-black">Q</span>
              <button type="button" className="text-xs font-medium text-[var(--dim)]" onClick={() => logout.mutate()}>Cerrar sesión</button>
            </div>
          </div>
          {(
            <div className="mt-2 flex items-center gap-2">
              <span className="rounded-lg bg-[var(--surface2)] px-2 py-1 text-xs text-[var(--dim)]">Mint {shortAddr(GTQ_MINT)}</span>
              <CopyButton text={GTQ_MINT} label="Copiar contrato de GTQ" />
            </div>
          )}
        </header>

        {/* Session identity: the signed-in user, no switcher */}
        {selected && (
          <div className="mt-3 flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm">
              <span className="font-semibold">{selected.name}</span>
              <span className="text-[var(--dim)]"> · {selected.email}</span>
            </p>
            <KycBadge status={selected.kycStatus} />
          </div>
        )}

        <section className="mt-4">
          {loading ? (
            <p className="py-10 text-center text-sm text-[var(--dim)]">Cargando tu wallet…</p>
          ) : tab === "home" ? (
            homeView === "agregar" ? (
              <div className="space-y-4">
                <button type="button" className={btnGhost} onClick={() => setHomeView("saldos")}>← Volver a saldos</button>
                <CreditDepositForm user={selected!} networks={networks} />
              </div>
            ) : homeView === "detalle" && detailCoin ? (
              <CoinDetail
                user={selected!}
                coin={detailCoin}
                onBack={() => { setHomeView("saldos"); setDetailAsset(null); }}
                onSend={(netId, ast) => { setFlowNetwork(netId); setFlowAsset(ast); setFlowKey((k) => k + 1); setSendMode("enviar"); setJustDone(false); setTab("enviar"); }}
                onReceive={(netId) => { setFlowNetwork(netId); setFlowKey((k) => k + 1); setReceiveMode("recibir"); setTab("recibir"); }}
                onSwap={(netId, ast) => { setFlowNetwork(netId); setFlowAsset(ast); setFlowKey((k) => k + 1); setSendMode("swap"); setJustDone(false); setTab("enviar"); }}
              />
            ) : (
            <div className="space-y-4">
              <div className="flex items-end justify-between gap-3 px-1">
                <div>
                  <p className="text-xs text-[var(--dim)]">Saldo total estimado</p>
                  <p className="tnum font-display text-3xl font-extrabold">{totalUsdAll != null ? fmtUsd(totalUsdAll) : "—"}</p>
                </div>
                <p className="text-right text-xs text-[var(--dim)]">
                  {autoSync.isPending || sync.isPending ? "Sincronizando depósitos…" : lastAutoSync ? <>Depósitos al día · {new Date(lastAutoSync).toLocaleTimeString()}</> : "Sincronización automática activa"}
                </p>
              </div>
              {syncMsg && <p className="text-sm text-[var(--accent-text)]" role="status">{syncMsg}</p>}
              {balancesQ.data?.errors.map((e) => (
                <p key={e.network} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--gold)]">{e.message}</p>
              ))}
              <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
                  <p className="text-sm font-semibold">Tus monedas</p>
                  {isOperator && (
                    <button type="button" className="text-sm font-medium text-[var(--accent-text)]" onClick={() => setHomeView("agregar")}>+ Agregar</button>
                  )}
                </div>
                {balancesQ.isPending ? (
                  <p className="px-4 py-6 text-sm text-[var(--dim)]">Leyendo saldos…</p>
                ) : (
                  <ul>
                    {aggregated.map((c) => {
                      const ledgerTotal = selected!.ledger.filter((l) => l.asset === c.asset)
                        .reduce((s, l) => s + (Number(l.balance) || 0), 0);
                      return (
                        <li key={c.asset} className="border-b border-[var(--border)] last:border-b-0">
                          <button type="button" aria-label={`Ver ${c.asset}: saldo total, redes y opciones de enviar o recibir`}
                            className="flex w-full items-center gap-3 px-4 py-3 text-left"
                            onClick={() => { setDetailAsset(c.asset); setHomeView("detalle"); }}>
                            <CoinLogo asset={c.asset} size={40} />
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium">{c.asset} <span className="text-sm font-normal text-[var(--dim)]">· {COIN_NAMES[c.asset] ?? ""}</span></span>
                              <span className="block text-xs text-[var(--dim)]">
                                {c.networks.length > 1 ? `En ${c.networks.length} redes` : c.networks[0]?.networkName ?? ""}
                                {ledgerTotal !== 0 ? ` · En tu cuenta: ${fmtTotal(ledgerTotal)}` : ""}
                              </span>
                            </span>
                            <span className="shrink-0 text-right">
                              <span className="tnum block font-semibold">{fmtTotal(c.total)}</span>
                              <span className="tnum block text-xs text-[var(--dim)]">{c.totalUsd != null ? fmtUsd(c.totalUsd) : "—"}</span>
                            </span>
                            <span aria-hidden="true" className="shrink-0 text-lg text-[var(--dim)]">›</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
            )
          ) : tab === "perfil" ? (
            <div className="space-y-4">
              {perfilView !== "menu" && (
                <button type="button" className={btnGhost} onClick={() => setPerfilView("menu")}>← Volver al perfil</button>
              )}
              {perfilView === "menu" ? (
                <>
                <ul className="space-y-2">
                  {([
                    ["perfil", "Mi perfil", "Correo, teléfono y KYC"],
                    ...(isOperator ? [
                      ["usuarios", "Usuarios", `${users.length} registrados · registrar nuevo`] as const,
                      ["ajustes", "Ajustes", "Comisión de servicio en GTQ"] as const,
                    ] : []),
                    ["password", "Cambiar contraseña", "Actualiza la contraseña de tu cuenta"],
                    ["contactos", "Contactos", "Direcciones guardadas"],
                  ] as const).map(([view, title, sub]) => (
                    <li key={view}>
                      <button type="button" onClick={() => setPerfilView(view)}
                        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 text-left">
                        <span>
                          <span className="block font-display text-base font-bold">{title}</span>
                          <span className="block text-xs text-[var(--dim)]">{sub}</span>
                        </span>
                        <span aria-hidden="true" className="text-lg text-[var(--dim)]">›</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={() => logout.mutate()}
                  className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5 text-left font-display text-base font-bold text-[var(--danger)]">
                  Cerrar sesión
                </button>
              </> ) : perfilView === "perfil" ? (
                <ProfilePanel user={selected!} users={users} />
              ) : perfilView === "password" ? (
                <ChangePasswordForm />
              ) : perfilView === "usuarios" ? (
                <div className="space-y-4">
                  <CreateUserForm />
                  <ul className="space-y-3">
                {users.map((u) => (
                  <li key={u.id} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-display font-bold">{u.name}</p>
                        <p className="text-xs text-[var(--dim)]">
                          {u.email ? <>{u.email} · </> : null}Cuenta #{u.accountIndex} · {u.addresses.length} direcciones · desde {new Date(u.createdAt).toLocaleDateString()}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <KycBadge status={u.kycStatus} />
                          {u.crossmintAddress ? (
                            <span className="rounded-full bg-[var(--gold)] px-2.5 py-0.5 text-xs font-bold text-black">Wallet Crossmint</span>
                          ) : null}
                          {u.phone ? <span className="text-xs text-[var(--dim)]">Tel. {u.phone}</span> : null}
                        </div>
                      </div>
                      <button type="button" className={btnGhost} aria-expanded={expandedUser === u.id}
                        onClick={() => setExpandedUser(expandedUser === u.id ? null : u.id)}>
                        {expandedUser === u.id ? "Ocultar" : "Direcciones"}
                      </button>
                    </div>
                    {u.ledger.length > 0 && (
                      <p className="mt-2 text-sm text-[var(--dim)]">
                        Saldos: {u.ledger.map((l) => `${l.balance} ${l.asset} (${l.network})`).join(" · ")}
                      </p>
                    )}
                    {expandedUser === u.id && (
                      <ul className="mt-3 space-y-2">
                        {u.crossmintAddress && (
                          <li className="rounded-xl border border-[var(--gold)] bg-[var(--surface2)] px-3 py-2">
                            <p className="text-xs font-semibold">Solana · Wallet de Crossmint <span className="font-normal text-[var(--dim)]">· ligada a {u.email}</span></p>
                            <p className="mt-0.5 break-all text-xs">{u.crossmintAddress}</p>
                            <div className="mt-1"><CopyButton text={u.crossmintAddress} label={`Copiar wallet de Crossmint de ${u.name}`} /></div>
                          </li>
                        )}
                        {u.addresses.filter((a) => !(a.network === "solana" && a.address === u.crossmintAddress)).map((a) => (
                          <li key={a.network} className="rounded-xl bg-[var(--surface2)] px-3 py-2">
                            <p className="text-xs font-semibold">{networks.find((n) => n.id === a.network)?.name ?? a.network}{a.derivationPath && a.derivationPath !== "crossmint" ? <span className="font-normal text-[var(--dim)]"> · {a.derivationPath}</span> : null}</p>
                            <p className="mt-0.5 break-all text-xs">{a.address}</p>
                            <div className="mt-1"><CopyButton text={a.address} label={`Copiar dirección ${a.network} de ${u.name}`} /></div>
                          </li>
                        ))}
                        <li>
                          <p className="px-1 text-xs text-[var(--dim)]">Ligadas para siempre al correo {u.email || "registrado"}.</p>
                        </li>
                      </ul>
                    )}
                  </li>
                ))}
                  </ul>
                </div>
              ) : perfilView === "ajustes" ? (
                <SettingsPanel feeGtq={fee} />
              ) : (
                <ContactsPanel networks={networks} />
              )}
            </div>
          ) : tab === "enviar" ? (
            <div className="space-y-4">
              <div className={segWrap} role="group" aria-label="Tipo de operación de envío">
                {([["enviar", "Enviar"], ["swap", "Swap"], ["transferir", "Entre usuarios"]] as const).map(([m, label]) => (
                  <button key={m} type="button" aria-pressed={sendMode === m} onClick={() => { setSendMode(m); setJustDone(false); }}
                    className={segCls(sendMode === m)}>
                    {label}
                  </button>
                ))}
              </div>
              {justDone ? (
                <div className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 text-center">
                  <p className="font-display text-lg font-bold">Operación firmada y registrada</p>
                  <p className="text-sm text-[var(--dim)]">Se liquidó en la cuenta de {selected!.name}.</p>
                  <button type="button" className={btnPrimary} onClick={() => { setJustDone(false); setTab("historial"); }}>Ver historial</button>
                </div>
              ) : sendMode === "enviar" ? (
                <SendForm key={`send-${flowKey}`} user={selected!} networks={networks} fee={fee} onDone={() => setJustDone(true)} initialNetwork={flowNetwork} initialAsset={flowAsset} />
              ) : sendMode === "swap" ? (
                <SwapForm key={`swap-${flowKey}`} user={selected!} networks={networks} onDone={() => setJustDone(true)} initialNetwork={flowNetwork} initialAsset={flowAsset} />
              ) : (
                <InternalTransferForm fromUser={selected!} fee={fee} onDone={() => setJustDone(true)} />
              )}
            </div>
          ) : tab === "recibir" ? (
            <div className="space-y-4">
              <div className={segWrap} role="group" aria-label="Recibir o cobrar con QR">
                {([["recibir", "Recibir"], ["qr", "Cobrar QR en GTQ"]] as const).map(([m, label]) => (
                  <button key={m} type="button" aria-pressed={receiveMode === m} onClick={() => setReceiveMode(m)}
                    className={segCls(receiveMode === m)}>
                    {label}
                  </button>
                ))}
              </div>
              {receiveMode === "recibir"
                ? <ReceivePanel key={`recv-${flowKey}`} user={selected!} networks={networks} initialNetwork={flowNetwork} />
                : <GtqChargePanel user={selected!} />}
            </div>
          ) : tab === "historial" ? (
            <div className="space-y-4">
              <div className={segWrap} role="group" aria-label="Tipo de historial">
                {([["ops", "Operaciones"], ["libro", "Libro"]] as const).map(([v, label]) => (
                  <button key={v} type="button" aria-pressed={histView === v} onClick={() => setHistView(v)} className={segCls(histView === v)}>
                    {label}
                  </button>
                ))}
              </div>
              {histView === "ops" ? (
                <TxList txs={txQ.data?.transactions ?? []} networks={networks} users={directory} />
              ) : (
                <LedgerList entries={ledgerQ.data?.entries ?? []} networks={networks} users={directory} />
              )}
            </div>
          ) : (
            <ProfilePanel user={selected!} users={users} />
          )}
        </section>
      </main>

      {/* Bottom menu: Home / Enviar / Recibir / Historial / Perfil */}
      {selected && (
        <nav aria-label="Menú principal" className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--border)] bg-[var(--surface)]">
          <div className="mx-auto grid max-w-2xl grid-cols-5 pb-[env(safe-area-inset-bottom)]">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tab === t.id}
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => { setTab(t.id); setJustDone(false); setHomeView("saldos"); setPerfilView("menu"); }}
                className={`flex flex-col items-center gap-1 px-1 pb-2 pt-2.5 text-xs font-semibold ${tab === t.id ? "text-[var(--gold)]" : "text-[var(--dim)]"}`}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {TAB_ICONS[t.id]}
                </svg>
                {t.label}
              </button>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
