// Errors a person reads: what happened and what to do, in their language. The raw text
// (a CLI's stderr, a system code) stays as the detail, for the log or a "details" fold.
import { L } from "./lang";

// An error already written for people (L('…', '…')): it goes through as it is.
export class UserError extends Error {}

// Our own guard (src/core/safe-fetch.ts) refused an address of the inside: loopback, the LAN, the cloud's metadata.
export class InsideNetworkError extends UserError {}

export interface Friendly {
  text: string;
  detail?: string; // the raw text, when it isn't the headline
}

export interface FriendlyContext {
  engine?: string; // the harness that failed, e.g. "Claude Code"
  doing?: string; // what was being done, for the fallback: "responder", "salvar"
  host?: string; // the server being reached, when the error doesn't say it
}

// Why a connection failed, below the "fetch failed" Node says for all of them: undici puts the
// real reason in `cause` (a TLS code, ENOTFOUND…), sometimes an AggregateError of one per address.
export type NetKind =
  | "tls"
  | "expired"
  | "proxy"
  | "dns"
  | "refused"
  | "reset"
  | "offline"
  | "timeout"
  | "inside";

export interface NetProblem {
  kind: NetKind;
  host?: string;
  status?: number; // a proxy's answer, 407 when it wants a login
  detail: string; // each cause, outermost first: "fetch failed ← unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)"
}

// The error and every cause under it, outermost first (a cycle or a deep chain stops it).
function chain(e: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (x: unknown, depth: number): void => {
    if (x === undefined || x === null || depth > 6 || out.includes(x)) return;
    out.push(x);
    if (typeof x !== "object") return;
    const errors = (x as { errors?: unknown }).errors;
    if (Array.isArray(errors)) for (const y of errors) walk(y, depth + 1);
    walk((x as { cause?: unknown }).cause, depth + 1);
  };
  walk(e, 0);
  return out;
}

const prop = (x: unknown, k: string): string | undefined => {
  const v =
    x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
};

const NET_KINDS: [NetKind, RegExp][] = [
  ["expired", /\bCERT_(HAS_EXPIRED|NOT_YET_VALID)\b|certificate has expired|certificate is not yet valid/i],
  [
    "tls",
    /\b(CERT_\w+|UNABLE_TO_\w+|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_\w+|ERR_SSL_\w+|ERR_OSSL_\w+|HOSTNAME_MISMATCH)\b|self[- ]signed certificate|unable to (verify|get) (the first|local issuer) certificate|certificate (verify failed|chain)|altnames|ssl routines|tlsv1 alert|wrong version number|net::ERR_(CERT_\w+|SSL_\w+)/i,
  ],
  [
    "proxy",
    /\bERR_PROXY_\w+\b|proxy (response|connection|authentication)|tunnel(ing)? (to|connection)|failed to establish tunnel|net::ERR_(PROXY_\w+|TUNNEL_CONNECTION_FAILED)/i,
  ],
  [
    "dns",
    /\b(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NODATA|EAI_NONAME|ENODATA|ESERVFAIL)\b|getaddrinfo|net::ERR_NAME_(NOT_RESOLVED|RESOLUTION_FAILED)/i,
  ],
  ["refused", /\bECONNREFUSED\b|connection refused|net::ERR_CONNECTION_REFUSED/i],
  [
    "offline",
    /\b(ENETUNREACH|EHOSTUNREACH|ENETDOWN|EHOSTDOWN|EADDRNOTAVAIL)\b|network is unreachable|net::ERR_(INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|NETWORK_ACCESS_DENIED)/i,
  ],
  [
    "reset",
    /\b(ECONNRESET|EPIPE|ECONNABORTED|UND_ERR_SOCKET|UND_ERR_CLOSED)\b|socket hang up|other side closed|net::ERR_CONNECTION_(RESET|CLOSED|ABORTED|FAILED)/i,
  ],
  [
    "timeout",
    /\b(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)\b|connect timeout|net::ERR_(TIMED_OUT|CONNECTION_TIMED_OUT)/i,
  ],
];

// The error and its causes in one line, for "details": "fetch failed ← self-signed certificate in
// certificate chain (SELF_SIGNED_CERT_IN_CHAIN)".
export function causeText(e: unknown): string {
  const lines: string[] = [];
  for (const x of chain(e)) {
    const text = x instanceof Error ? x.message.trim() : typeof x === "string" ? x.trim() : "";
    const code = prop(x, "code");
    const line = code && /\D/.test(code) && !text.includes(code) ? `${text} (${code})`.trim() : text;
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines.join(" ← ");
}

// What went wrong on the network, from the error and its causes; undefined when nothing says.
export function netProblem(e: unknown): NetProblem | undefined {
  const all = chain(e);
  const detail = causeText(e);
  const inside = all.some((x) => x instanceof InsideNetworkError);
  const kind = inside
    ? "inside"
    : NET_KINDS.find(([, re]) => re.test(detail))?.[0];
  if (!kind) return undefined;
  // A proxy that wants a login answers 407, in a property or in its text ("Proxy response (407)").
  const login =
    kind === "proxy" &&
    (all.some((x) => prop(x, "statusCode") === "407" || prop(x, "status") === "407") || /\b407\b/.test(detail));
  const host =
    all.map((x) => prop(x, "hostname") ?? prop(x, "host")).find(Boolean) ??
    /\b(?:ENOTFOUND|EAI_AGAIN)\s+([\w.-]+\.[a-z]{2,})/i.exec(detail)?.[1];
  return {
    kind,
    detail,
    ...(host ? { host } : {}),
    ...(login ? { status: 407 } : {}),
  };
}

// A network problem in people's words: what happened and what to do about it.
export function netText(p: NetProblem, host?: string): string {
  const at = p.host ?? host;
  const of = at ? ` (${at})` : "";
  switch (p.kind) {
    case "tls":
      return L(
        `O certificado do servidor${of} não foi aceito. Numa rede de empresa, um proxy ou antivírus que inspeciona HTTPS troca o certificado no caminho: instale no sistema o certificado raiz dele (a TI tem; o Tucano confia nos certificados do sistema) ou desligue a inspeção de HTTPS do antivírus. Fora disso, tente em outra rede.`,
        `The server's certificate${of} wasn't accepted. On a company network, a proxy or antivirus that inspects HTTPS swaps the certificate on the way: install its root certificate in the system (IT has it; Tucano trusts the system's certificates) or turn off the antivirus's HTTPS scanning. Otherwise, try another network.`
      );
    case "expired":
      return L(
        `O certificado do servidor${of} está vencido ou ainda não vale. Confira a data e a hora do computador; numa rede de empresa, um proxy ou antivírus que inspeciona HTTPS pode estar no meio.`,
        `The server's certificate${of} has expired or isn't valid yet. Check the computer's date and time; on a company network, a proxy or antivirus that inspects HTTPS may be in the way.`
      );
    case "proxy":
      return p.status === 407
        ? L(
            "O proxy da rede pede login e recusou a conexão. Coloque o usuário e a senha no endereço do proxy (HTTPS_PROXY=http://usuário:senha@proxy:porta) ou peça à TI pra liberar o endereço.",
            "The network's proxy asks for a sign-in and refused the connection. Put the user and password in the proxy's address (HTTPS_PROXY=http://user:password@proxy:port) or ask IT to allow the address."
          )
        : L(
            "O proxy da rede recusou a conexão ou não respondeu. Confira o proxy do sistema (ou HTTPS_PROXY) com a TI.",
            "The network's proxy refused the connection or didn't answer. Check the system's proxy (or HTTPS_PROXY) with IT."
          );
    case "dns":
      return L(
        `Não achei o endereço${of} na rede (DNS). Confira se ele está certo e se há internet; numa rede de empresa ou VPN, o DNS dela pode não conhecer esse endereço.`,
        `Couldn't find the address${of} on the network (DNS). Check that it's right and that there's internet; on a company network or VPN, its DNS may not know that address.`
      );
    case "refused":
      return L(
        `O servidor${of} recusou a conexão. Confira o endereço; numa rede de empresa, um firewall pode estar bloqueando.`,
        `The server${of} refused the connection. Check the address; on a company network, a firewall may be blocking it.`
      );
    case "reset":
      return L(
        `A conexão com o servidor${of} caiu no meio. Numa rede de empresa, um firewall, proxy ou antivírus pode estar cortando; tente de novo ou em outra rede.`,
        `The connection to the server${of} dropped midway. On a company network, a firewall, proxy or antivirus may be cutting it; try again or on another network.`
      );
    case "offline":
      return L(
        "Sem conexão com a internet. Confira a rede e tente de novo.",
        "No internet connection. Check the network and try again."
      );
    case "timeout":
      return L(
        "Demorou demais pra responder. Confira a internet e tente de novo.",
        "It took too long to answer. Check the internet and try again."
      );
    case "inside":
      return L(
        "Esse endereço aponta pra rede interna desta máquina, e o Tucano não acessa ela por aqui.",
        "That address points into this machine's internal network, and Tucano doesn't reach it from here."
      );
  }
}

// A status code counts only when the text says it is one: "API Error: 503", "HTTP 401",
// "status 429". A bare number can be a line in a stack trace (index.js:503:17).
const status = (codes: string): string =>
  `(?:API Error|HTTP(?:\\/\\d(?:\\.\\d)?)?|status(?: code)?|code)[\\s:=]*(?:${codes})\\b`;
const AUTH = new RegExp(
  `${status(
    "401"
  )}|\\b401 Unauthorized|authentication_error|invalid[ _-]?(x-)?api[ _-]?key|run \`?\\/login|not (logged|signed) in|log ?in again|oauth token has expired|token (has )?expired|invalid authentication credentials|\\bunauthorized\\b`,
  "i"
);
// The plan ran out. The engines share it: a reserve model takes over on the same words.
export const OUT_OF_QUOTA = new RegExp(
  `usage limit|hit your (?:[\\w-]+ ){0,2}limit|limit reached|limit_reached|quota|resource_exhausted|rate.?limit|too many requests|${status(
    "429"
  )}|insufficient_quota|credit balance is too low|out of (extra )?usage`,
  "i"
);
// No network, as Node says it (ENOTFOUND…) and as Chromium does, for the updater (net::ERR_…).
const OFFLINE =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|getaddrinfo|fetch failed|network (error|is unreachable)|socket hang up|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|ADDRESS_UNREACHABLE|CONNECTION_(REFUSED|RESET|CLOSED|FAILED|ABORTED)|PROXY_CONNECTION_FAILED)/i;
const SLOW =
  /ETIMEDOUT|\btimed? ?out\b|due to timeout|net::ERR_(TIMED_OUT|CONNECTION_TIMED_OUT)/i;
const MISSING = /spawn (\S+) ENOENT/i;
const DOWN = new RegExp(
  `overloaded|internal server error|service unavailable|bad gateway|gateway timeout|${status(
    "5\\d\\d"
  )}|\\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)`,
  "i"
);
const BUSY = /SQLITE_BUSY|database is locked/i;
// When the plan frees up again, as the CLI said it: "resets 5pm", "will reset at 3pm",
// "try again in 6.5s". Up to the end of the sentence; "try again later" says no time.
const RESETS =
  /(?:will reset|resets|try again)(?: at| in| on)?\s+(?!later\b)([^·∙\n]{1,40}?)(?:\.(?=\s|$)|[·∙\n]|$)/i;

const message = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
// Not ours: a bug (TypeError…), a library's own error, or a system code (ENOENT, SQLITE_…).
// A plain Error in this code base is written with L() and reads fine.
const unexpected = (e: unknown): boolean =>
  e instanceof Error
    ? e.constructor !== Error || "code" in e
    : typeof e !== "string";

// The raw text, mapped to what a person can do about it. An engine's error comes as a
// string, "headline\nstderr": the stderr goes to the detail.
export function friendly(e: unknown, ctx: FriendlyContext = {}): Friendly {
  const raw = message(e).trim();
  if (e instanceof UserError) return { text: raw };
  const who = ctx.engine;
  const mapped = (text: string): Friendly => ({ text, detail: raw });
  if (AUTH.test(raw))
    return mapped(
      who
        ? L(
            `O ${who} saiu da sua conta. Entre de novo em Configurações › Modelos.`,
            `${who} is signed out. Sign in again in Settings › Models.`
          )
        : L(
            "O serviço recusou o login. Entre de novo e tente outra vez.",
            "The service refused the sign-in. Sign in again and try once more."
          )
    );
  if (OUT_OF_QUOTA.test(raw)) {
    const when = RESETS.exec(raw)?.[1]?.trim();
    const plan = who
      ? L(`Seu plano do ${who}`, `Your ${who} plan`)
      : L("Seu plano", "Your plan");
    // The time goes in the first sentence: a notification keeps only that one.
    return mapped(
      `${L(`${plan} chegou no limite`, `${plan} hit its limit`)}${
        when ? ` (${L("libera", "resets")}: ${when})` : ""
      }. ${L("Tente de novo mais tarde.", "Try again later.")}`
    );
  }
  const missing = MISSING.exec(raw)?.[1];
  if (missing) {
    const node = /^(npx|npm|node)(\.cmd|\.exe)?$/i.test(missing);
    const uv = /^uvx?(\.exe)?$/i.test(missing);
    return mapped(
      uv
        ? L(
            `O comando \`${missing}\` não foi encontrado. Instale o uv (docs.astral.sh/uv) e tente de novo.`,
            `The \`${missing}\` command wasn't found. Install uv (docs.astral.sh/uv) and try again.`
          )
        : node
        ? L(
            `O comando \`${missing}\` não foi encontrado. Instale o Node.js (nodejs.org) e tente de novo.`,
            `The \`${missing}\` command wasn't found. Install Node.js (nodejs.org) and try again.`
          )
        : L(
            `O comando \`${missing}\` não foi encontrado. Confira se ele está instalado.`,
            `The \`${missing}\` command wasn't found. Check that it's installed.`
          )
    );
  }
  // The network, by what's under "fetch failed": a certificate, a proxy, the DNS… Only the
  // causes' detail goes under "details", not a stack.
  const net = netProblem(e);
  if (net)
    return {
      text: netText(net, ctx.host),
      detail: net.detail || raw,
    };
  // "fetch failed" and nothing under it that says why: the server wasn't reached, no more is known.
  if (/^fetch failed$/i.test(raw))
    return {
      text: ctx.host
        ? L(
            `Não consegui chegar ao servidor (${ctx.host}). Confira a rede e tente de novo.`,
            `Couldn't reach the server (${ctx.host}). Check the network and try again.`
          )
        : L(
            "Não consegui chegar ao servidor. Confira a rede e tente de novo.",
            "Couldn't reach the server. Check the network and try again."
          ),
      detail: causeText(e) || raw,
    };
  if (OFFLINE.test(raw))
    return mapped(
      L(
        "Sem conexão com a internet, ou o serviço não respondeu. Confira a rede e tente de novo.",
        "No internet connection, or the service didn't answer. Check the network and try again."
      )
    );
  if (SLOW.test(raw))
    return mapped(
      L(
        "Demorou demais pra responder. Confira a internet e tente de novo.",
        "It took too long to answer. Check the internet and try again."
      )
    );
  if (DOWN.test(raw))
    return mapped(
      who
        ? L(
            `O serviço do ${who} está fora do ar ou sobrecarregado agora. Tente de novo em alguns minutos.`,
            `${who}'s service is down or overloaded right now. Try again in a few minutes.`
          )
        : L(
            "O serviço está fora do ar ou sobrecarregado agora. Tente de novo em alguns minutos.",
            "The service is down or overloaded right now. Try again in a few minutes."
          )
    );
  if (BUSY.test(raw))
    return mapped(
      L(
        "O Tucano está ocupado salvando. Tente de novo em instantes.",
        "Tucano is busy saving. Try again in a moment."
      )
    );
  // A file the system wouldn't open, said with the file: the generic "restart" wouldn't help.
  const code =
    e instanceof Error && "code" in e
      ? String((e as { code: unknown }).code)
      : "";
  const file =
    e instanceof Error &&
    "path" in e &&
    typeof (e as { path: unknown }).path === "string"
      ? `\`${(e as { path: string }).path}\``
      : "";
  if (code === "EACCES" || code === "EPERM")
    return mapped(
      file
        ? L(
            `Sem permissão pra acessar ${file}. Confira as permissões e tente de novo.`,
            `No permission to access ${file}. Check the permissions and try again.`
          )
        : L(
            "Sem permissão pra acessar esse arquivo. Confira as permissões e tente de novo.",
            "No permission to access that file. Check the permissions and try again."
          )
    );
  if (code === "ENOENT")
    return mapped(
      file
        ? L(
            `Não achei ${file}. Ele pode ter sido movido ou apagado.`,
            `Couldn't find ${file}. It may have been moved or deleted.`
          )
        : L(
            "Não achei esse arquivo. Ele pode ter sido movido ou apagado.",
            "Couldn't find that file. It may have been moved or deleted."
          )
    );
  if (code === "ENOSPC")
    return mapped(
      L(
        "O disco está cheio. Libere espaço e tente de novo.",
        "The disk is full. Free up some space and try again."
      )
    );
  if (code === "EBUSY")
    return mapped(
      L(
        "O arquivo está aberto em outro programa. Feche ele e tente de novo.",
        "The file is open in another program. Close it and try again."
      )
    );
  if (unexpected(e) || !raw) {
    const doing = ctx.doing ? L(` ao ${ctx.doing}`, ` while ${ctx.doing}`) : "";
    return {
      text: L(
        `Algo deu errado${doing}. Tente de novo; se continuar, reinicie o Tucano.`,
        `Something went wrong${doing}. Try again; if it keeps happening, restart Tucano.`
      ),
      detail: raw || undefined,
    };
  }
  if (typeof e !== "string") return { text: raw };
  const [head = "", ...rest] = raw.split("\n");
  return rest.length
    ? { text: head.trim(), detail: rest.join("\n").trim() }
    : { text: raw };
}

// No internet (or the other side didn't answer), as opposed to a refusal or a bug.
export const offline = (e: unknown): boolean =>
  OFFLINE.test(message(e)) || SLOW.test(message(e));

// The first sentence, for a notification: "O Claude Code saiu da sua conta."
export function firstSentence(text: string): string {
  const s = (/^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim())?.[0] ?? text.trim())
    .split("\n")[0]!
    .trim();
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

// A tool's name as a person says it: send_email → "send email".
export const toolLabel = (name: string): string =>
  name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();

// What a caller reads of an error. The owner (it's their machine) gets it as `friendly` says; anyone
// else never a path on the machine nor a system's raw text (a code, a stack): those stay in the
// core's log. An error written for people goes through, less any path in it.
export function errorFor(e: unknown, owner: boolean): string {
  const f = friendly(e);
  if (owner) return f.text;
  const ours =
    e instanceof UserError ||
    typeof e === "string" ||
    (e instanceof Error && e.constructor === Error && !("code" in e));
  return ours
    ? withoutPaths(f.text)
    : L(
        "Algo deu errado. Tente de novo; se continuar, avise quem cuida deste Tucano.",
        "Something went wrong. Try again; if it keeps happening, tell whoever runs this Tucano."
      );
}

// "/srv/tucano/x", "~/x", "C:\x": a place on the machine, said as "…".
const withoutPaths = (text: string): string =>
  text.replace(/(^|[\s"'`(=])(?:~?\/|[A-Za-z]:[\\/])[^\s"'`)]*/g, "$1…");
