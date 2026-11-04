import { afterEach, describe, expect, it } from "vitest";
import { connectError, notAuthorized } from "../src/core/connectors";
import { refused } from "../src/core/telegram";
import {
  firstSentence,
  friendly,
  offline,
  toolLabel,
  UserError,
} from "../src/shared/errors";
import { setLang } from "../src/shared/lang";

afterEach(() => setLang("pt"));

// A system error as Node makes it: a plain Error with a code.
const sys = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code });

describe("errors in people’s words", () => {
  it("says the harness is signed out, and where to sign in again", () => {
    const f = friendly("Invalid API key · Please run /login", {
      engine: "Claude Code",
    });
    expect(f).toEqual({
      text: "O Claude Code saiu da sua conta. Entre de novo em Configurações › Modelos.",
      detail: "Invalid API key · Please run /login",
    });
    expect(
      friendly(
        'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
        { engine: "Codex" }
      ).text
    ).toMatch(/^O Codex saiu da sua conta/);
    setLang("en");
    expect(
      friendly("OAuth token has expired", { engine: "Claude Code" }).text
    ).toBe("Claude Code is signed out. Sign in again in Settings › Models.");
  });

  it("says the plan hit its limit, with when it frees up when the CLI says", () => {
    expect(
      friendly("usage limit reached", { engine: "Claude Code" }).text
    ).toBe(
      "Seu plano do Claude Code chegou no limite. Tente de novo mais tarde."
    );
    expect(
      friendly("You've hit your limit · resets 5pm", { engine: "Claude Code" })
        .text
    ).toBe(
      "Seu plano do Claude Code chegou no limite (libera: 5pm). Tente de novo mais tarde."
    );
    // Claude Code's session limit, and the ways a CLI says when it frees up
    expect(
      friendly("Session limit reached ∙ resets 3pm", { engine: "Claude Code" })
        .text
    ).toBe(
      "Seu plano do Claude Code chegou no limite (libera: 3pm). Tente de novo mais tarde."
    );
    expect(
      friendly(
        "5-hour limit reached. Your limit will reset at 3pm (America/Sao_Paulo)."
      ).text
    ).toBe(
      "Seu plano chegou no limite (libera: 3pm (America/Sao_Paulo)). Tente de novo mais tarde."
    );
    expect(friendly("Rate limit exceeded, try again in 6.5s.").text).toBe(
      "Seu plano chegou no limite (libera: 6.5s). Tente de novo mais tarde."
    );
    expect(friendly("Too many requests, try again later.").text).toBe(
      "Seu plano chegou no limite. Tente de novo mais tarde."
    );
    expect(friendly("429 Too Many Requests").text).toBe(
      "Seu plano chegou no limite. Tente de novo mais tarde."
    );
  });

  it("tells no internet, a slow answer, a missing command and a busy database apart", () => {
    expect(
      friendly(sys("getaddrinfo ENOTFOUND api.anthropic.com", "ENOTFOUND")).text
    ).toMatch(/^Sem conexão com a internet/);
    expect(friendly(new TypeError("fetch failed")).text).toMatch(
      /^Sem conexão com a internet/
    );
    expect(friendly("Request timed out").text).toMatch(/^Demorou demais/);
    expect(friendly(sys("spawn npx ENOENT", "ENOENT"))).toEqual({
      text: "O comando `npx` não foi encontrado. Instale o Node.js (nodejs.org) e tente de novo.",
      detail: "spawn npx ENOENT",
    });
    expect(friendly(sys("spawn uvx ENOENT", "ENOENT")).text).toBe(
      "O comando `uvx` não foi encontrado. Confira se ele está instalado."
    );
    expect(friendly(sys("database is locked", "SQLITE_BUSY")).text).toBe(
      "O Tucano está ocupado salvando. Tente de novo em instantes."
    );
    expect(
      friendly('API Error: 529 {"type":"overloaded_error"}', {
        engine: "Claude Code",
      }).text
    ).toMatch(/^O serviço do Claude Code está fora do ar ou sobrecarregado/);
  });

  it("says a reply got too long for one message, and what to do", () => {
    const f = friendly(
      "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
      { engine: "Claude Code" }
    );
    expect(f.text).toContain("A resposta ficou longa demais pra uma mensagem só");
    expect(f.text).toContain("32.000 tokens");
    expect(f.text).toContain("Peça em partes");
    expect(f.detail).toContain("CLAUDE_CODE_MAX_OUTPUT_TOKENS"); // the CLI's own words, folded under it
  });

  it("lets an error written for people through as it is", () => {
    expect(friendly(new UserError("O token do bot não vale mais."))).toEqual({
      text: "O token do bot não vale mais.",
    });
    expect(
      friendly(new Error("Essa página mudou desde que foi aberta."))
    ).toEqual({ text: "Essa página mudou desde que foi aberta." });
    // Not even a pattern touches it: it was meant as it is.
    expect(friendly(new UserError("Request timed out at the gate"))).toEqual({
      text: "Request timed out at the gate",
    });
  });

  it("turns a bug into what to do, with the raw text as the detail", () => {
    const f = friendly(
      new TypeError("Cannot read properties of undefined (reading 'id')"),
      { doing: "responder" }
    );
    expect(f).toEqual({
      text: "Algo deu errado ao responder. Tente de novo; se continuar, reinicie o Tucano.",
      detail: "Cannot read properties of undefined (reading 'id')",
    });
    setLang("en");
    expect(
      friendly(new RangeError("Invalid array length"), { doing: "saving" }).text
    ).toBe(
      "Something went wrong while saving. Try again; if it keeps happening, restart Tucano."
    );
  });

  it('says which file the system refused, instead of "restart"', () => {
    const fs = (message: string, code: string, path: string): Error =>
      Object.assign(new Error(message), { code, path });
    expect(
      friendly(
        fs(
          "EACCES: permission denied, open '/x/notas.md'",
          "EACCES",
          "/x/notas.md"
        )
      )
    ).toEqual({
      text: "Sem permissão pra acessar `/x/notas.md`. Confira as permissões e tente de novo.",
      detail: "EACCES: permission denied, open '/x/notas.md'",
    });
    expect(
      friendly(
        fs(
          "ENOENT: no such file or directory, open '/x/a.md'",
          "ENOENT",
          "/x/a.md"
        )
      ).text
    ).toBe("Não achei `/x/a.md`. Ele pode ter sido movido ou apagado.");
    expect(
      friendly(sys("ENOSPC: no space left on device, write", "ENOSPC")).text
    ).toBe("O disco está cheio. Libere espaço e tente de novo.");
  });

  it("reads a status code only where the text says it is one, not in a stack trace", () => {
    const crash =
      "O Gemini CLI saiu sem resposta (código 1).\nTypeError: x is not a function\n    at run (/usr/lib/node_modules/@google/gemini-cli/dist/index.js:503:17)\n    at main (index.js:401:3)\n    at next (index.js:429:9)";
    expect(friendly(crash, { engine: "Gemini CLI" }).text).toBe(
      "O Gemini CLI saiu sem resposta (código 1)."
    );
    expect(
      friendly("Request failed with status code 503", { engine: "Gemini CLI" })
        .text
    ).toMatch(/^O serviço do Gemini CLI está fora do ar/);
    expect(friendly("HTTP 401: invalid token").text).toMatch(
      /^O serviço recusou o login/
    );
    expect(friendly("[API Error: got status: 429]").text).toMatch(
      /chegou no limite/
    );
  });

  it("knows the updater's offline, in Chromium's words", () => {
    expect(offline(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe(true);
    expect(offline(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(true);
    expect(offline(new Error("net::ERR_CONNECTION_TIMED_OUT"))).toBe(true);
  });

  it("keeps an engine's headline and folds its stderr", () => {
    expect(
      friendly(
        "O Codex saiu sem resposta (código 1).\nthread panicked at src/main.rs\nnote: run with RUST_BACKTRACE=1"
      )
    ).toEqual({
      text: "O Codex saiu sem resposta (código 1).",
      detail: "thread panicked at src/main.rs\nnote: run with RUST_BACKTRACE=1",
    });
    // The stderr says why: that wins over the headline.
    expect(
      friendly(
        "O Claude Code saiu sem resposta (código 1).\nError: Invalid API key · Please run /login",
        { engine: "Claude Code" }
      ).text
    ).toMatch(/saiu da sua conta/);
  });

  it("keeps the first sentence for a notification, and says tools as people do", () => {
    expect(
      firstSentence(
        "O Claude Code saiu da sua conta. Entre de novo em Configurações › Modelos."
      )
    ).toBe("O Claude Code saiu da sua conta.");
    expect(
      firstSentence(
        "O comando `npx` não foi encontrado. Instale o Node.js (nodejs.org) e tente de novo."
      )
    ).toBe("O comando `npx` não foi encontrado.");
    expect(firstSentence("boom")).toBe("boom.");
    expect(toolLabel("send_email")).toBe("send email");
    expect(toolLabel("createIssue")).toBe("create issue");
    expect(offline(new TypeError("fetch failed"))).toBe(true);
    expect(
      offline(
        new Error("Cannot find latest-mac.yml in the latest release artifacts")
      )
    ).toBe(false);
  });
});

describe("connectors and Telegram, in what to do", () => {
  it("says to install Node.js, or to check the command, instead of the SDK error", () => {
    expect(connectError(sys("spawn npx ENOENT", "ENOENT"))).toBe(
      "O comando `npx` não foi encontrado. Instale o Node.js (nodejs.org) e tente de novo."
    );
    expect(connectError(new Error("MCP error -32000: Connection closed"))).toBe(
      "O servidor fechou logo ao abrir. Confira o comando e os argumentos do conector."
    );
    expect(connectError(new Error("Servidor respondeu 500"))).toBe(
      "Servidor respondeu 500"
    );
  });

  it("says the person declined, and how to try again", () => {
    expect(
      notAuthorized(new URL("http://127.0.0.1/cb?error=access_denied"))
    ).toBe(
      "Você recusou o acesso na página do serviço. Tente de novo e clique em Permitir."
    );
    expect(
      notAuthorized(
        new URL(
          "http://127.0.0.1/cb?error=invalid_scope&error_description=bad+scope"
        )
      )
    ).toBe("Autorização não concluída: bad scope. Tente de novo pelo app.");
  });

  it("says what Telegram's refusal means", () => {
    expect(refused(401, "Unauthorized").message).toBe(
      "O token do bot não vale mais. Cole um novo do @BotFather."
    );
    expect(
      refused(409, "Conflict: terminated by other getUpdates request").message
    ).toBe(
      "Outro app está lendo este bot (outro Tucano ou um webhook). Feche o outro ou troque o token."
    );
    expect(refused(400, "Bad Request: chat not found").message).toBe(
      "O Telegram recusou: Bad Request: chat not found."
    );
  });
});
