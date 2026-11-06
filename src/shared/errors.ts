// Errors a person reads: what happened and what to do, in their language. The raw text
// (a CLI's stderr, a system code) stays as the detail, for the log or a "details" fold.
import { L } from "./lang";

// An error already written for people (L('…', '…')): it goes through as it is.
export class UserError extends Error {}

export interface Friendly {
  text: string;
  detail?: string; // the raw text, when it isn't the headline
}

export interface FriendlyContext {
  engine?: string; // the harness that failed, e.g. "Claude Code"
  doing?: string; // what was being done, for the fallback: "responder", "salvar"
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
