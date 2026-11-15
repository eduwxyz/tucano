# Como escrever um guia

Cada guia é uma pasta aqui em `site/guias/` com dois arquivos: `pt.md` (português) e `en.md` (inglês). O `build.mjs` transforma cada um numa página, monta o índice (`/guias/` e `/en/guides/`), põe no `sitemap.xml` e no `llms.txt`, e acrescenta os dados estruturados (Article, BreadcrumbList, FAQ e, se for passo a passo, HowTo). Páginas de referência ("o que é um conector") vão do mesmo jeito em `site/docs/`, que sai em `/docs/` e `/en/docs/`.

O nome da pasta é só pra gente achar o guia (ex.: `instalar-no-mac`); o endereço vem do `slug` de cada arquivo. Veja o exemplo em [`instalar-no-mac/`](instalar-no-mac/).

## O arquivo

```markdown
---
slug: como-instalar-o-tucano-no-mac
titulo: Como instalar o Tucano no Mac?
descricao: Uma ou duas frases, até 170 caracteres. Aparece no Google e no índice.
atualizado: 2026-11-15
grupo: Começar
ordem: 1
howto: sim
faq:
  - pergunta: O Tucano funciona em Mac Intel?
    resposta: Sim. ...
  - pergunta: Outra pergunta?
    resposta: Outra resposta.
---
O primeiro parágrafo responde a pergunta do título, direto, em 2 a 4 frases.
É o trecho que buscadores e IAs mais citam.

## O que você precisa

- um item
- outro item

## 1. Primeiro passo

Texto do passo.
```

## Os campos

| Campo | Obrigatório | O que é |
|---|---|---|
| `slug` | sim | O fim do endereço: só minúsculas, números e hífens, sem acento. Em português no `pt.md` e em inglês no `en.md`. Não mude depois de publicado (quebra os links). |
| `titulo` | sim | A pergunta que a página responde, terminando em `?`. Vira o título da página e o da busca. |
| `descricao` | sim | Até 170 caracteres. |
| `atualizado` | sim | A data da última revisão, `AAAA-MM-DD`, a mesma nos dois arquivos. Vai pro sitemap e pros dados estruturados. |
| `grupo` | sim | O grupo do índice, na língua do arquivo (ex.: `Começar` / `Getting started`). Guias do mesmo grupo se linkam no fim da página. |
| `ordem` | não | A posição no índice (menor primeiro). Sem ela, vai pro fim, em ordem alfabética. |
| `howto` | não | `sim` num passo a passo: os passos são os títulos `##` que começam com número (`## 1. …`, `## 2. …`), pelo menos dois. |
| `faq` | não | Perguntas e respostas, em texto simples (sem Markdown). O mesmo número nos dois arquivos. Aparecem no fim da página. |
| `publicado` | não | A data da primeira publicação, se for diferente de `atualizado`. |

As chaves são as mesmas (em português) nos dois arquivos; só os valores mudam de língua. Se um valor tiver `: ` no meio, ponha entre aspas.

## O texto (Markdown)

- Títulos `##` e `###`. Sem `#`: o título da página é o `titulo`.
- Parágrafos, listas com `-` e numeradas com `1.`, `**negrito**`, `*itálico*`, `` `código` ``, `[link](/guias/outro-guia/)`.
- Blocos de código com três crases (` ```bash `).
- Tabelas com `| a | b |` e a linha `|---|---|` embaixo do cabeçalho.
- Uma nota destacada com `> ` no começo da linha.
- Links pra outras páginas do site sem o domínio: `/guias/...` no `pt.md`, `/en/guides/...` no `en.md`.
- Um link só pode começar com `/`, `#`, `https://`, `http://` ou `mailto:`. Qualquer outro (como `javascript:` ou `data:`) para o build.
- `ordem` é um número inteiro. Arquivos salvos no Windows (quebra de linha CRLF) funcionam.

Só fatos que dá pra conferir (README, CHANGELOG, o app). Se algo mudar no app, atualize o guia e a data.

## Conferir

```bash
cd site && node build.mjs          # para com uma mensagem clara se faltar campo ou tiver erro
cd dist && python3 -m http.server   # e abra http://localhost:8000/guias/
node --test site/*.test.mjs         # da raiz do repositório
```

Um guia novo é um pull request só de texto. Publicar o site (`npx wrangler deploy`) é com o OK do Eduardo.
