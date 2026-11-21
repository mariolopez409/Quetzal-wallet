import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import { api, type ApiResponse } from "./api";
import type { Actions } from "../../server/src/actions";
import gtqLogo from "./assets/coins/gtq.svg";
import usdtLogo from "./assets/coins/usdt.png";
import usdcLogo from "./assets/coins/usdc.png";
import solLogo from "./assets/coins/sol.png";
import ethLogo from "./assets/coins/eth.png";
import bnbLogo from "./assets/coins/bnb.png";
import polLogo from "./assets/coins/pol.png";
import avaxLogo from "./assets/coins/avax.png";
import trxLogo from "./assets/coins/trx.png";

const FIELDS = actionFields<typeof Actions>();

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
// Custody setup (one encrypted master seed)
// ---------------------------------------------------------------------------

function CustodySetup() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"crear" | "importar">("crear");
  const [label, setLabel] = useState("Quetzal Custodial");
  const [fee, setFee] = useState("1");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mnemonicImport, setMnemonicImport] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [confirmedBackup, setConfirmedBackup] = useState(false);
  const [error, setError] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["custody"] });
    queryClient.invalidateQueries({ queryKey: ["users"] });
  };
  const setup = useMutation({
    mutationFn: async () => api.setupCustody({ label, feeGtq: fee, passphrase }),
    onSuccess: (data) => { setGenerated(data.mnemonic); },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo crear la bóveda."),
  });
  const imp = useMutation({
    mutationFn: async () => api.importCustody({ label, feeGtq: fee, passphrase, mnemonic: mnemonicImport }),
    onSuccess: () => invalidate(),
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo importar la frase."),
  });

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setError("");
    if (!label.trim()) { setError("Ponle un nombre a la bóveda."); return; }
    if (passphrase.length < 8) { setError("La contraseña de la bóveda debe tener al menos 8 caracteres."); return; }
    if (passphrase !== confirm) { setError("Las contraseñas no coinciden."); return; }
    if (mode === "crear") setup.mutate();
    else {
      if (mnemonicImport.trim().split(/\s+/).length < 12) { setError("Escribe la frase semilla completa (12 o 24 palabras)."); return; }
      imp.mutate();
    }
  };

  if (generated) {
    return (
      <div className="space-y-4 rounded-2xl border border-[var(--gold)] bg-[var(--surface)] p-5">
        <h3 className="font-display text-lg font-bold">Guarda tu frase semilla maestra</h3>
        <p className="text-sm text-[var(--dim)]">
          Se muestra <strong className="text-[var(--text)]">solo esta vez</strong>. De esta frase salen las direcciones de todos los usuarios en las 12 redes.
          Escríbela en papel y guárdala fuera de internet.
        </p>
        <p className="rounded-xl bg-[var(--surface2)] p-4 font-mono text-base leading-relaxed">{generated}</p>
        <div className="flex justify-center"><CopyButton text={generated} label="Copiar frase semilla maestra" /></div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={confirmedBackup} onChange={(e) => setConfirmedBackup(e.target.checked)} />
          Ya guardé mi frase semilla en un lugar seguro.
        </label>
        <button type="button" className={btnPrimary} disabled={!confirmedBackup} onClick={invalidate}>
          Confirmar y empezar a crear usuarios
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex gap-2">
        <button type="button" aria-pressed={mode === "crear"} onClick={() => setMode("crear")}
          className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-medium ${mode === "crear" ? "bg-[var(--accent)] text-black" : "border border-[var(--border)]"}`}>
          Crear frase nueva
        </button>
        <button type="button" aria-pressed={mode === "importar"} onClick={() => setMode("importar")}
          className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-medium ${mode === "importar" ? "bg-[var(--accent)] text-black" : "border border-[var(--border)]"}`}>
          Importar frase existente
        </button>
      </div>
      <div>
        <label htmlFor="c-label" className={labelCls}>Nombre de la bóveda custodial</label>
        <input id="c-label" {...FIELDS.setupCustody.label} className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div>
        <label htmlFor="c-fee" className={labelCls}>Comisión fija de envío y transferencia interna (en GTQ)</label>
        <input id="c-fee" {...FIELDS.setupCustody.feeGtq} inputMode="decimal" className={inputCls} value={fee} onChange={(e) => setFee(e.target.value)} />
        <p className="mt-1 text-xs text-[var(--dim)]">Toda comisión se paga en GTQ. El swap cobra 0.1% fijo.</p>
      </div>
      {mode === "importar" && (
        <div>
          <label htmlFor="c-mnemonic" className={labelCls}>Frase semilla (12 o 24 palabras BIP39)</label>
          <textarea id="c-mnemonic" {...FIELDS.importCustody.mnemonic} className={inputCls} rows={3} value={mnemonicImport} onChange={(e) => setMnemonicImport(e.target.value)} placeholder="palabra palabra palabra…" />
        </div>
      )}
      <div>
        <label htmlFor="c-pass" className={labelCls}>Contraseña de cifrado de la bóveda (mínimo 8 caracteres)</label>
        <input id="c-pass" {...FIELDS.setupCustody.passphrase} type="password" autoComplete="new-password" className={inputCls} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
      </div>
      <div>
        <label htmlFor="c-pass2" className={labelCls}>Confirmar contraseña</label>
        <input id="c-pass2" type="password" autoComplete="new-password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      <p className="text-xs text-[var(--dim)]">
        La contraseña <strong className="text-[var(--text)]">no se guarda</strong>: la necesitas para crear usuarios y para recuperar la frase.
      </p>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      <button type="submit" className={btnPrimary} disabled={setup.isPending || imp.isPending}>
        {setup.isPending || imp.isPending ? "Cifrando y guardando…" : mode === "crear" ? "Crear bóveda y generar frase semilla" : "Importar y cifrar frase semilla"}
      </button>
    </form>
  );
}

function CustodyPanel({ label, feeGtq }: { label: string; feeGtq: string }) {
  const queryClient = useQueryClient();
  const [newLabel, setNewLabel] = useState(label);
  const [newFee, setNewFee] = useState(feeGtq);
  const [passphrase, setPassphrase] = useState("");
  const [recovered, setRecovered] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [savedMsg, setSavedMsg] = useState("");

  const update = useMutation({
    mutationFn: async () => api.updateCustodySettings({ label: newLabel, feeGtq: newFee }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["custody"] }); setSavedMsg("Ajustes guardados."); },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo guardar."),
  });
  const recover = useMutation({
    mutationFn: async () => api.recoverSeed({ passphrase }),
    onSuccess: (d) => { setRecovered(d.mnemonic); setError(""); },
    onError: (e) => { setRecovered(null); setError(e instanceof Error ? e.message : "Contraseña incorrecta."); },
  });

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="text-sm font-semibold">Cómo funciona la custodia</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Una sola frase maestra cifrada (scrypt + AES-256-GCM) deriva una dirección por usuario en cada red.
          Los saldos viven en el libro interno.
        </p>
        <p className="mt-2 text-sm text-[var(--danger)]">
          La frase cifrada vive en la base de datos de esta app, no en un HSM. Sin contraseña ni copia en papel, no se puede recuperar.
        </p>
      </div>

      <form onSubmit={(ev) => { ev.preventDefault(); setError(""); setSavedMsg(""); update.mutate(); }} className="space-y-4">
        <div>
          <label htmlFor="u-label" className={labelCls}>Nombre de la bóveda</label>
          <input id="u-label" {...FIELDS.updateCustodySettings.label} className={inputCls} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        </div>
        <div>
          <label htmlFor="u-fee" className={labelCls}>Comisión fija de envío y transferencia interna (en GTQ)</label>
          <input id="u-fee" {...FIELDS.updateCustodySettings.feeGtq} inputMode="decimal" className={inputCls} value={newFee} onChange={(e) => setNewFee(e.target.value)} />
          <p className="mt-1 text-xs text-[var(--dim)]">El swap cobra 0.1% fijo, en GTQ.</p>
        </div>
        {savedMsg && <p className="text-sm text-[var(--accent-text)]">{savedMsg}</p>}
        <button type="submit" className={btnPrimary} disabled={update.isPending}>{update.isPending ? "Guardando…" : "Guardar ajustes"}</button>
      </form>

      <div className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="text-sm font-semibold">Recuperación de la frase semilla</h3>
        <p className="text-xs text-[var(--dim)]">Solo se muestra si escribes la contraseña correcta de la bóveda. No la compartas con nadie.</p>
        <div>
          <label htmlFor="r-pass" className={labelCls}>Contraseña de la bóveda</label>
          <input id="r-pass" {...FIELDS.recoverSeed.passphrase} type="password" autoComplete="current-password" className={inputCls} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </div>
        <button type="button" className={btnPrimary} disabled={recover.isPending || !passphrase}
          onClick={() => { setError(""); recover.mutate(); }}>
          {recover.isPending ? "Verificando…" : "Ver frase semilla"}
        </button>
        {recovered && (
          <div className="space-y-2">
            <p className="rounded-xl bg-[var(--surface2)] p-4 font-mono text-base leading-relaxed">{recovered}</p>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={recovered} label="Copiar frase semilla recuperada" />
              <button type="button" className={btnGhost} onClick={() => { setRecovered(null); setPassphrase(""); }}>Ocultar frase</button>
            </div>
          </div>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Crossmint admin: API key (encrypted) + per-user Smart Wallets
// ---------------------------------------------------------------------------

function CrossmintPanel({ users }: { users: CustUser[] }) {
  const queryClient = useQueryClient();
  const statusQ = useQuery({ queryKey: ["crossmint"], queryFn: () => api.getCrossmintStatus({}) });
  const status = statusQ.data;
  const [apiKey, setApiKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [signer, setSigner] = useState("");
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [creatingId, setCreatingId] = useState<number | null>(null);

  useEffect(() => {
    if (status && !signer) setSigner(status.serverSignerAddress);
  }, [status, signer]);

  const save = useMutation({
    mutationFn: async () => api.saveCrossmintKey({
      apiKey, passphrase,
      serverSignerAddress: signer.trim() || "84Vx1DJx8RGJizV7gKxLZRcPGTiVofi7Pvn7cjcqTQvy",
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["crossmint"] });
      setApiKey("");
      setMsg("API key guardada cifrada. Los usuarios nuevos ya reciben su wallet de Crossmint al registrarse.");
      setError("");
    },
    onError: (e) => { setMsg(""); setError(e instanceof Error ? e.message : "No se pudo guardar la API key."); },
  });
  const createWallet = useMutation({
    mutationFn: async (userId: number) => api.createUserCrossmintWallet({ userId, passphrase }),
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["crossmint"] });
      setMsg(`Wallet de Crossmint lista: ${d.address}`);
      setError("");
      setCreatingId(null);
    },
    onError: (e) => { setMsg(""); setError(e instanceof Error ? e.message : "No se pudo crear la wallet de Crossmint."); setCreatingId(null); },
  });

  const submitSave = (ev: FormEvent) => {
    ev.preventDefault();
    setError(""); setMsg("");
    if (apiKey.trim().length < 10) { setError("Pega tu API key de servidor de Crossmint."); return; }
    if (!passphrase) { setError("Escribe la contraseña de la bóveda: con ella se cifra la API key."); return; }
    save.mutate();
  };

  const missing = users.filter((u) => !u.crossmintAddress);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="text-sm font-semibold">Crossmint — wallets de los usuarios</h3>
        {statusQ.isPending ? (
          <p className="mt-1 text-sm text-[var(--dim)]">Cargando estado…</p>
        ) : status?.configured ? (
          <p className="mt-1 text-sm text-[var(--dim)]">
            API key <strong className="text-[var(--accent-text)]">guardada cifrada</strong>
            {status.savedAt ? <> desde el {new Date(status.savedAt).toLocaleDateString()}</> : null}.
            {" "}{status.usersWithWallet} de {status.usersTotal} usuarios ya tienen su wallet de Crossmint.
          </p>
        ) : (
          <p className="mt-1 text-sm text-[var(--dim)]">
            Sin API key guardada: los usuarios nuevos solo reciben direcciones derivadas de la frase maestra.
          </p>
        )}
        <p className="mt-2 text-xs text-[var(--dim)]">
          Cada usuario registrado con su correo recibe una Smart Wallet de Solana con server signer.
          Server signer: <span className="break-all">{status?.serverSignerAddress ?? "84Vx1DJx8RGJizV7gKxLZRcPGTiVofi7Pvn7cjcqTQvy"}</span>
        </p>
      </div>

      <form onSubmit={submitSave} className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="text-sm font-semibold">{status?.configured ? "Actualizar API key de Crossmint" : "Guardar API key de Crossmint"}</p>
        <div>
          <label htmlFor="cm-key" className={labelCls}>API key de servidor (producción)</label>
          <input id="cm-key" {...FIELDS.saveCrossmintKey.apiKey} type="password" autoComplete="off" className={inputCls}
            value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk_live_…" />
          <p className="mt-1 text-xs text-[var(--dim)]">Se verifica contra Crossmint y se guarda cifrada con la contraseña de la bóveda. Nunca se muestra.</p>
        </div>
        <div>
          <label htmlFor="cm-signer" className={labelCls}>Dirección pública del server signer</label>
          <input id="cm-signer" {...FIELDS.saveCrossmintKey.serverSignerAddress} className={inputCls}
            value={signer} onChange={(e) => setSigner(e.target.value)} placeholder="84Vx1DJx8RGJizV7gKxLZRcPGTiVofi7Pvn7cjcqTQvy" />
        </div>
        <div>
          <label htmlFor="cm-pass" className={labelCls}>Contraseña de la bóveda</label>
          <input id="cm-pass" {...FIELDS.saveCrossmintKey.passphrase} type="password" autoComplete="current-password" className={inputCls}
            value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          <p className="mt-1 text-xs text-[var(--dim)]">La misma contraseña cifra la frase semilla y la API key; se pide al crear wallets de usuarios.</p>
        </div>
        <button type="submit" className={btnPrimary} disabled={save.isPending}>
          {save.isPending ? "Verificando y guardando…" : "Guardar API key cifrada"}
        </button>
      </form>

      {status?.configured && (
        <div className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-sm font-semibold">Wallets de Crossmint por usuario</p>
          {users.length === 0 ? (
            <p className="text-sm text-[var(--dim)]">Todavía no hay usuarios registrados.</p>
          ) : (
            <ul className="space-y-2">
              {users.map((u) => (
                <li key={u.id} className="rounded-xl bg-[var(--surface2)] px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{u.name}</p>
                      <p className="truncate text-xs text-[var(--dim)]">{u.email}</p>
                    </div>
                    {u.crossmintAddress ? (
                      <span className="shrink-0 rounded-full bg-[var(--gold)] px-2.5 py-0.5 text-xs font-bold text-black">Crossmint ✓</span>
                    ) : (
                      <button type="button" className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-bold text-black"
                        disabled={createWallet.isPending || !passphrase}
                        onClick={() => { setError(""); setMsg(""); setCreatingId(u.id); createWallet.mutate(u.id); }}>
                        {creatingId === u.id && createWallet.isPending ? "Creando…" : "Crear wallet"}
                      </button>
                    )}
                  </div>
                  {u.crossmintAddress && <p className="mt-1 break-all text-xs">{u.crossmintAddress}</p>}
                </li>
              ))}
            </ul>
          )}
          {missing.length > 0 && !passphrase && (
            <p className="text-xs text-[var(--dim)]">Escribe arriba la contraseña de la bóveda para poder crear las wallets pendientes.</p>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      {msg && <p className="text-sm text-[var(--accent-text)]" role="status">{msg}</p>}
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
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [cmNote, setCmNote] = useState("");
  const cmStatus = useQuery({ queryKey: ["crossmint"], queryFn: () => api.getCrossmintStatus({}) });
  const create = useMutation({
    mutationFn: async () => api.createUser({ name, email, passphrase }),
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["custody"] });
      queryClient.invalidateQueries({ queryKey: ["crossmint"] });
      setName(""); setEmail("");
      if (d.crossmintError) {
        setCmNote(`Usuario registrado, pero su wallet de Crossmint no se creó: ${d.crossmintError} Puedes crearla en Perfil → Crossmint.`);
      } else if (d.user.crossmintAddress) {
        setCmNote(`Wallet de Crossmint creada y ligada a su correo: ${d.user.crossmintAddress}`);
      } else {
        setCmNote("");
      }
    },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo crear el usuario."),
  });
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setError(""); setCmNote("");
    if (!name.trim()) { setError("Escribe el nombre del usuario."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Escribe un correo electrónico válido: será el acceso del usuario y quedará ligado para siempre a sus direcciones."); return; }
    if (!passphrase) { setError("Escribe la contraseña de la bóveda para derivar sus direcciones."); return; }
    create.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-sm font-semibold">Registrar usuario con correo electrónico</p>
      <p className="text-xs text-[var(--dim)]">
        Al registrarlo se derivan sus direcciones en las 12 redes. <strong className="text-[var(--text)]">El correo queda ligado a esas direcciones para siempre</strong>: no se puede cambiar ni reusar.
        {cmStatus.data?.configured
          ? <> Además se crea automáticamente su <strong className="text-[var(--text)]">wallet de Crossmint</strong> (Solana, Smart Wallet con server signer), ligada al mismo correo.</>
          : <> Crossmint aún no está configurado: guarda la API key en Perfil → Crossmint para que cada usuario reciba también su wallet de Crossmint.</>}
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
        <label htmlFor="nu-pass" className={labelCls}>Contraseña de la bóveda</label>
        <input id="nu-pass" {...FIELDS.createUser.passphrase} type="password" autoComplete="current-password" className={inputCls} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      {cmNote && <p className="text-sm text-[var(--accent-text)]" role="status">{cmNote}</p>}
      <button type="submit" className={btnPrimary} disabled={create.isPending}>
        {create.isPending ? "Registrando…" : "Registrar usuario"}
      </button>
    </form>
  );
}

function LoginByEmail({ onLogin }: { onLogin: (user: CustUser) => void }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [found, setFound] = useState<CustUser | null>(null);
  const login = useMutation({
    mutationFn: async () => api.findUserByEmail({ email }),
    onSuccess: (d) => {
      if (d.user) { setFound(d.user); setError(""); onLogin(d.user); }
      else { setFound(null); setError("No hay ninguna cuenta registrada con ese correo. Regístrala primero en el formulario de registro."); }
    },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo iniciar sesión."),
  });
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setError(""); setFound(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Escribe un correo electrónico válido."); return; }
    login.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-sm font-semibold">Iniciar sesión con correo electrónico</p>
      <p className="text-xs text-[var(--dim)]">Abre la cuenta ligada a ese correo, con sus direcciones de siempre.</p>
      <div>
        <label htmlFor="li-email" className={labelCls}>Correo electrónico</label>
        <input id="li-email" {...FIELDS.findUserByEmail.email} type="email" autoComplete="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="usuario@correo.com" />
      </div>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      {found && (
        <p className="text-sm text-[var(--accent-text)]">
          Sesión iniciada: {found.name} ({found.email}) · cuenta #{found.accountIndex} · {found.addresses.length} direcciones ligadas a este correo.
        </p>
      )}
      <button type="submit" className={btnPrimary} disabled={login.isPending}>
        {login.isPending ? "Buscando cuenta…" : "Iniciar sesión"}
      </button>
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
    mutationFn: async () => api.creditDeposit({ userId: user.id, network, asset, amount, note }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      setAmount(""); setMsg("Depósito acreditado al libro interno de " + user.name + ".");
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
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: () => api.listContacts({}) });
  const chainQ = useQuery({ queryKey: ["userBalances", user.id], queryFn: () => api.getUserBalances({ userId: user.id }) });

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
    if (balance != null && amt > Number(balance)) { setError(`Saldo interno insuficiente: ${user.name} tiene ${balance} ${asset} en ${net?.name}.`); return; }
    if (gtqBalance != null && Number(fee) > Number(gtqBalance) && asset !== "GTQ") {
      setError(`Necesita ${fee} GTQ para la comisión y tiene ${gtqBalance} GTQ en su libro interno.`);
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
        <p className="text-xs text-[var(--dim)]">Se descuenta del libro interno de {user.name} (cantidad + comisión en GTQ).</p>
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
        {balance != null && <p className="mt-1 text-xs text-[var(--dim)]">Saldo interno disponible: <span className="tnum">{balance} {asset}</span></p>}
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
        <p className="text-sm text-[var(--dim)]">Gas: se requieren al menos $0.50 USD en {nativeSym || "la moneda nativa"} en la dirección derivada.</p>
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
  const pricesQ = useQuery({ queryKey: ["userBalances", user.id], queryFn: () => api.getUserBalances({ userId: user.id }) });
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
    if (bal != null && Number(amount) > Number(bal)) { setError(`Saldo interno insuficiente: tiene ${bal} ${from}.`); return; }
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
        <p className="text-xs text-[var(--dim)]">Se liquida en el libro interno de {user.name}.</p>
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
        <p className="mt-1 text-xs text-[var(--dim)]">Saldo interno: <span className="tnum">{ledgerOf(user, network, from) ?? "0"} {from}</span></p>
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
        <p className="text-sm text-[var(--danger)]">Gas insuficiente: se requieren al menos $0.50 USD en {net?.native} en la dirección derivada para operar en {net?.name} (ahora ≈ {fmtUsd(gasUsdS)}).</p>
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
    if (!solana) { setError("Este usuario no tiene dirección de Solana derivada."); return; }
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

function CoinDetail({ user, coin, networks, onBack, onSend, onReceive, onSwap }: {
  user: CustUser;
  coin: AggCoin;
  networks: Network[];
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

function InternalTransferForm({ users, fromUser, fee, onDone }: {
  users: CustUser[]; fromUser: CustUser; fee: string; onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const others = users.filter((u) => u.id !== fromUser.id);
  const networksQ = useQuery({ queryKey: ["networks"], queryFn: () => api.getNetworks({}) });
  const networks = networksQ.data?.networks ?? [];
  const [toUserId, setToUserId] = useState(others[0]?.id ?? 0);
  const [network, setNetwork] = useState("solana");
  const net = networks.find((n) => n.id === network);
  const [asset, setAsset] = useState("GTQ");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const balance = ledgerOf(fromUser, network, asset);

  const transfer = useMutation({
    mutationFn: async () => api.internalTransfer({
      fromUserId: fromUser.id, toUserId, network, asset, amount, note,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      onDone();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo hacer la transferencia."),
  });

  if (others.length === 0) {
    return <p className="text-sm text-[var(--dim)]">Necesitas al menos dos usuarios. Crea otro en Perfil → Usuarios.</p>;
  }
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setError("");
    if (!toUserId) { setError("Elige el usuario destino."); return; }
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) { setError("Escribe una cantidad válida."); return; }
    if (balance != null && Number(amount) > Number(balance)) { setError(`Saldo interno insuficiente: ${fromUser.name} tiene ${balance} ${asset}.`); return; }
    transfer.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-[var(--dim)]">
        Instantánea, solo en el libro interno. Comisión al remitente: <span className="tnum font-semibold text-[var(--gold)]">{fee} GTQ</span>.
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
        {balance != null && <p className="mt-1 text-xs text-[var(--dim)]">Saldo interno de {fromUser.name}: <span className="tnum">{balance} {asset}</span></p>}
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
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: () => api.listContacts({}) });
  const [name, setName] = useState("");
  const [network, setNetwork] = useState("solana");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const add = useMutation({
    mutationFn: async () => api.addContact({ name, network, address }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["contacts"] }); setName(""); setAddress(""); },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo guardar el contacto."),
  });
  const del = useMutation({
    mutationFn: async (id: number) => api.deleteContact({ id }),
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
    case "internal": return "Transferencia interna";
    case "deposit": return "Depósito";
    case "internal_in": return "Recibido interno";
    case "internal_out": return "Enviado interno";
    case "fee": return "Comisión";
    default: return kind;
  }
}

function TxList({ txs, networks, users }: { txs: Tx[]; networks: Network[]; users: CustUser[] }) {
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

function LedgerList({ entries, networks, users }: { entries: LedgerEntry[]; networks: Network[]; users: CustUser[] }) {
  if (entries.length === 0) return <p className="text-sm text-[var(--dim)]">Este usuario todavía no tiene movimientos en el libro interno.</p>;
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
  const usageQ = useQuery({ queryKey: ["usage", user.id], queryFn: () => api.getMonthlyUsage({ userId: user.id }) });

  useEffect(() => { setPhone(user.phone); }, [user.id, user.phone]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["users"] });
    queryClient.invalidateQueries({ queryKey: ["usage"] });
  };
  const savePhone = useMutation({
    mutationFn: async () => api.updateUserProfile({ userId: user.id, phone }),
    onSuccess: () => { invalidateAll(); setPhoneMsg("Teléfono guardado en el perfil."); },
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo guardar el teléfono."),
  });
  const reqKyc = useMutation({
    mutationFn: async () => api.requestKyc({ userId: user.id }),
    onSuccess: () => invalidateAll(),
    onError: (e) => setError(e instanceof Error ? e.message : "No se pudo registrar la solicitud de KYC."),
  });
  const grant = useMutation({
    mutationFn: async (targetId: number) => api.setKycVerified({ userId: targetId, authorityEmail }),
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
  const [perfilView, setPerfilView] = useState<"menu" | "perfil" | "usuarios" | "acceso" | "custodia" | "crossmint" | "contactos">("menu");
  const [sendMode, setSendMode] = useState<"enviar" | "swap" | "transferir">("enviar");
  const [receiveMode, setReceiveMode] = useState<"recibir" | "qr">("recibir");
  const [justDone, setJustDone] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [syncMsg, setSyncMsg] = useState("");
  const [expandedUser, setExpandedUser] = useState<number | null>(null);

  const networksQ = useQuery({ queryKey: ["networks"], queryFn: () => api.getNetworks({}) });
  const custodyQ = useQuery({ queryKey: ["custody"], queryFn: () => api.getCustodyStatus({}) });
  const usersQ = useQuery({ queryKey: ["users"], queryFn: () => api.listUsers({}) });
  const txQ = useQuery({ queryKey: ["transactions"], queryFn: () => api.listTransactions({ limit: 50 }), refetchInterval: 30000 });

  const networks = useMemo(() => networksQ.data?.networks ?? [], [networksQ.data]);
  const users = useMemo(() => usersQ.data?.users ?? [], [usersQ.data]);
  const custody = custodyQ.data;
  const fee = custody?.feeGtq ?? "1";
  const selected = users.find((u) => u.id === selectedId) ?? users[0] ?? null;

  const balancesQ = useQuery({
    queryKey: ["userBalances", selected?.id],
    queryFn: () => api.getUserBalances({ userId: selected!.id }),
    enabled: selected != null,
    refetchInterval: 30000,
  });
  const ledgerQ = useQuery({
    queryKey: ["ledger", selected?.id],
    queryFn: () => api.listLedgerEntries({ userId: selected!.id, limit: 50 }),
    enabled: selected != null,
    refetchInterval: 30000,
  });

  const sync = useMutation({
    mutationFn: async () => api.syncUserDeposits({ userId: selected!.id }),
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
    if (!custody?.initialized || users.length === 0) return;
    autoSyncMutate();
    const t = setInterval(() => autoSyncMutate(), 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custody?.initialized, users.length, selected?.id]);

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

  const totalGtqLedger = users.reduce((sum, u) => sum + u.ledger.filter((l) => l.asset === "GTQ").reduce((s, l) => s + (Number(l.balance) || 0), 0), 0);
  const loading = networksQ.isPending || custodyQ.isPending || usersQ.isPending;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-28">
        {/* Compact header: solo el saldo total, sin tarjeta de explicación */}
        <header className="pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs text-[var(--dim)]">{custody?.initialized ? custody.label : "Quetzal Wallet"}</p>
              <p className="font-display text-3xl font-extrabold">
                <span className="tnum">{custody?.initialized ? totalGtqLedger.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}</span>{" "}
                <span className="text-[var(--accent-text)]">GTQ</span>
              </p>
              <p className="text-xs text-[var(--dim)]">Saldo interno total · Solana</p>
            </div>
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--accent)] font-display text-lg font-extrabold text-black">Q</span>
          </div>
          {custody?.initialized && (
            <div className="mt-2 flex items-center gap-2">
              <span className="rounded-lg bg-[var(--surface2)] px-2 py-1 text-xs text-[var(--dim)]">Mint {shortAddr(GTQ_MINT)}</span>
              <CopyButton text={GTQ_MINT} label="Copiar contrato de GTQ" />
            </div>
          )}
        </header>

        {/* User selector (compacto, una fila) */}
        {custody?.initialized && users.length > 0 && selected && (
          <div className="mt-3 flex items-center gap-2">
            <select id="user-select" aria-label="Usuario activo" className={`${inputCls} min-w-0 flex-1`} value={selected.id}
              onChange={(e) => { setSelectedId(Number(e.target.value)); setJustDone(false); setSyncMsg(""); setHomeView("saldos"); setPerfilView("menu"); }}>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` · ${u.email}` : ""}</option>)}
            </select>
            <KycBadge status={selected.kycStatus} />
          </div>
        )}

        <section className="mt-4">
          {loading ? (
            <p className="py-10 text-center text-sm text-[var(--dim)]">Cargando tu wallet custodial…</p>
          ) : !custody?.initialized ? (
            <div className="space-y-4">
              <h2 className="font-display text-lg font-bold">Crea tu bóveda custodial</h2>
              <CustodySetup />
            </div>
          ) : users.length === 0 ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <h2 className="font-display text-lg font-bold">Bóveda lista. Crea tu primer usuario</h2>
                <p className="mt-1 text-sm text-[var(--dim)]">Sus direcciones se derivan de la frase maestra en las 12 redes.</p>
              </div>
              <CreateUserForm />
            </div>
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
                networks={networks}
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
                  <p className="text-xs text-[var(--dim)]">Sin GTQ (no tiene precio público)</p>
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
                  <button type="button" className="text-sm font-medium text-[var(--accent-text)]" onClick={() => setHomeView("agregar")}>+ Agregar</button>
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
                                {ledgerTotal !== 0 ? ` · Interno: ${fmtTotal(ledgerTotal)}` : ""}
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
              <p className="px-1 text-xs text-[var(--dim)]">
                Una sola fila por moneda: USDT y USDC muestran su total en todas las redes. Toca una moneda para ver el saldo por red y elegir red al enviar o recibir. Los depósitos se detectan y acreditan solos.
              </p>
            </div>
            )
          ) : tab === "perfil" ? (
            <div className="space-y-4">
              {perfilView !== "menu" && (
                <button type="button" className={btnGhost} onClick={() => setPerfilView("menu")}>← Volver al perfil</button>
              )}
              {perfilView === "menu" ? (
                <ul className="space-y-2">
                  {([
                    ["perfil", "Mi perfil", "Correo, teléfono y KYC"],
                    ["usuarios", "Usuarios", `${users.length} registrados · registrar nuevo`],
                    ["acceso", "Acceso con correo", "Iniciar sesión con otro correo"],
                    ["custodia", "Custodia y frase semilla", "Bóveda, comisión y recuperación"],
                    ["crossmint", "Crossmint", "API key y wallets de los usuarios"],
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
              ) : perfilView === "perfil" ? (
                <ProfilePanel user={selected!} users={users} />
              ) : perfilView === "acceso" ? (
                <LoginByEmail onLogin={(u) => setSelectedId(u.id)} />
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
                        Libro interno: {u.ledger.map((l) => `${l.balance} ${l.asset} (${l.network})`).join(" · ")}
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
                        {u.addresses.map((a) => (
                          <li key={a.network} className="rounded-xl bg-[var(--surface2)] px-3 py-2">
                            <p className="text-xs font-semibold">{networks.find((n) => n.id === a.network)?.name ?? a.network} <span className="font-normal text-[var(--dim)]">· {a.derivationPath}</span></p>
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
              ) : perfilView === "custodia" ? (
                <CustodyPanel label={custody.label ?? ""} feeGtq={fee} />
              ) : perfilView === "crossmint" ? (
                <CrossmintPanel users={users} />
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
                  <p className="text-sm text-[var(--dim)]">Se liquidó en el libro interno de {selected!.name}.</p>
                  <button type="button" className={btnPrimary} onClick={() => { setJustDone(false); setTab("historial"); }}>Ver historial</button>
                </div>
              ) : sendMode === "enviar" ? (
                <SendForm key={`send-${flowKey}`} user={selected!} networks={networks} fee={fee} onDone={() => setJustDone(true)} initialNetwork={flowNetwork} initialAsset={flowAsset} />
              ) : sendMode === "swap" ? (
                <SwapForm key={`swap-${flowKey}`} user={selected!} networks={networks} onDone={() => setJustDone(true)} initialNetwork={flowNetwork} initialAsset={flowAsset} />
              ) : (
                <InternalTransferForm users={users} fromUser={selected!} fee={fee} onDone={() => setJustDone(true)} />
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
                {([["ops", "Operaciones"], ["libro", "Libro interno"]] as const).map(([v, label]) => (
                  <button key={v} type="button" aria-pressed={histView === v} onClick={() => setHistView(v)} className={segCls(histView === v)}>
                    {label}
                  </button>
                ))}
              </div>
              {histView === "ops" ? (
                <TxList txs={txQ.data?.transactions ?? []} networks={networks} users={users} />
              ) : (
                <LedgerList entries={ledgerQ.data?.entries ?? []} networks={networks} users={users} />
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <h2 className="font-display text-lg font-bold">Custodia y frase semilla</h2>
              <CustodyPanel label={custody.label ?? ""} feeGtq={fee} />
            </div>
          )}
        </section>
      </main>

      {/* Bottom menu: Home / Enviar / Recibir / Historial / Perfil */}
      {custody?.initialized && users.length > 0 && (
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
