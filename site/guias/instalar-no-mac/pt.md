---
slug: como-instalar-o-tucano-no-mac
titulo: Como instalar o Tucano no Mac?
descricao: Baixe o .dmg, arraste o Tucano pra Aplicativos e siga a configuração da primeira abertura. Funciona em Mac com chip Apple ou Intel.
atualizado: 2026-11-15
grupo: Começar
ordem: 1
howto: sim
faq:
  - pergunta: O Tucano funciona em Mac Intel?
    resposta: Sim. Em Mac com chip Apple, use o tucano-mac-arm64.dmg; em Mac Intel, o tucano-mac-x64.dmg. O Tucano foi testado no macOS 26 com chip Apple.
  - pergunta: Preciso de chave de API pra usar o Tucano?
    resposta: Não. Os agentes usam o Claude Code, o Codex, o Cursor, o Grok, o Cline, o Hermes, o OpenCode ou o Pi já instalados no seu Mac, com o login que você já tem. O Tucano nunca vê a sua senha.
  - pergunta: O macOS mostra um aviso ao abrir o Tucano?
    resposta: Não. O app é assinado e notarizado pela Apple, então abre sem aviso.
  - pergunta: Como atualizo o Tucano?
    resposta: Ele se atualiza sozinho. Baixa a versão nova em segundo plano e mostra Reiniciar na barra lateral quando ela está pronta; se você não clicar, ela entra na próxima vez que fechar o app.
---
Pra instalar o Tucano no Mac, instale antes um harness, como o Claude Code, e faça login nele. Depois baixe o `.dmg` do Tucano, abra e arraste o app pra **Aplicativos**. Na primeira abertura, o próprio Tucano faz a configuração com você e termina com o seu primeiro agente trabalhando num canal.

## O que você precisa

- Um Mac com chip Apple ou Intel. O Tucano foi testado no macOS 26, com chip Apple.
- Pelo menos um harness instalado e com login feito: Claude Code, Codex, Cursor CLI, Grok, Cline, Hermes, OpenCode ou Pi.
- Opcional: o [Docker Desktop](https://www.docker.com/products/docker-desktop/), pra dar aos agentes um computador Linux isolado, e o Google Chrome, pro navegador deles. Sem o Chrome, o app usa o navegador embutido.

## 1. Instale um harness

O harness é o programa com que os agentes pensam. O Claude Code é o mais rápido de instalar. No Terminal:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude auth login
```

Prefere o Codex? Rode `npm install -g @openai/codex`. O login dele é feito dentro do Tucano.

## 2. Baixe e instale o Tucano

Baixe o [tucano-mac-arm64.dmg](https://github.com/eduwxyz/tucano/releases/latest/download/tucano-mac-arm64.dmg), abra e arraste o Tucano pra **Aplicativos**. Num Mac Intel, baixe o [tucano-mac-x64.dmg](https://github.com/eduwxyz/tucano/releases/latest/download/tucano-mac-x64.dmg).

O app é assinado e notarizado pela Apple, então abre sem aviso.

## 3. Faça a configuração da primeira abertura

Escolha o idioma (português ou inglês) na primeira tela. Depois, em poucos passos: o seu nome; quais harnesses os agentes podem usar, cada um com um botão **Testar agora**; os modelos que roteiam os canais e cuidam da memória; o que todo agente deve saber sobre você; as suas ferramentas e skills (opcionais); e o primeiro agente, de um modelo pronto ou do zero. No fim, você cai num canal `#geral` com o seu agente já trabalhando.

Na primeira vez que o Tucano guardar uma senha de conector, o macOS pergunta se ele pode usar as **Chaves**: clique em **Sempre Permitir**.

## Instalar pelo Terminal

Se preferir, um comando baixa a última versão, coloca o Tucano em **Aplicativos** e abre:

```bash
curl -fsSL https://github.com/eduwxyz/tucano/releases/latest/download/install.sh | sh
```

## Atualizar

A partir da versão 0.1.2, o Tucano se atualiza sozinho. Ele baixa a versão nova em segundo plano e mostra **Reiniciar** na barra lateral quando ela está pronta. Se você não reiniciar, ela entra na próxima vez que fechar o app.

## Desinstalar

1. Feche o Tucano (⌘Q) e apague `/Applications/Tucano.app`.
2. Pra apagar também os seus dados, rode `rm -rf ~/Library/Application\ Support/Tucano` no Terminal.
3. Se usou o computador Linux dos agentes, apague os containers `tucano-*` no Docker Desktop.
4. Se quiser, apague o item **Tucano Safe Storage** no app Acesso às Chaves.
