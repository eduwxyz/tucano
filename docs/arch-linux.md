# Arch Linux e CachyOS com Niri

Este guia mostra como executar o Tucano em distribuições da família Arch Linux e repetir a validação em uma sessão Niri/Wayland. O teste registrado abaixo foi feito no CachyOS. Ele cobre o código-fonte e uma inicialização básica do Electron; a instalação por AppImage e a integração completa com o desktop ainda precisam de teste.

## Instalação por AppImage

Baixe o AppImage da arquitetura correspondente na [página de releases](https://github.com/eduwxyz/tucano/releases). Para x86_64, o arquivo da versão 0.2.0 se chama `tucano-linux-x86_64.AppImage`; para ARM64, `tucano-linux-arm64.AppImage`.

Na pasta do download, para x86_64:

```bash
chmod +x tucano-linux-x86_64.AppImage
./tucano-linux-x86_64.AppImage
```

Se houver erro relacionado a FUSE, verifique se `fuse2` está instalado (`pacman -Q fuse2`). O pacote está disponível nos repositórios do Arch Linux. Não execute o aplicativo como root nem desative o sandbox para contornar uma falha de inicialização.

O `install.sh` também seleciona AppImage em sistemas sem apt/dpkg e cria uma entrada no menu de aplicativos. No Arch, não use o pacote `.deb`. O procedimento de instalação e atualização do AppImage não foi executado nesta validação.

## Ambiente da validação

Validação realizada em 30/10/2026, no código da versão 0.2.0 com o suporte a Ghostty desta contribuição:

| Componente | Versão ou valor observado |
|---|---|
| Distribuição | CachyOS, rolling, `ID_LIKE=arch` |
| Arquitetura | x86_64 |
| Sessão | `XDG_SESSION_TYPE=wayland`, `XDG_CURRENT_DESKTOP=niri` |
| Niri | 26.04 |
| Ghostty | 1.3.1-arch2.2 |
| Kitty | 0.49.2 |
| Alacritty | 0.17.0 (94e7c887) |
| Node.js | 24.16.0 |
| npm | 11.16.0 |
| Electron | 44.8.0 |
| FUSE | `fuse2` 2.9.9-6 instalado, AppImage não testado |

Para registrar outro ambiente, use `cat /etc/os-release`, `uname -m`, `niri --version`, `ghostty --version`, `kitty --version`, `alacritty --version`, `node --version` e `npm --version`. Registre também o tipo de sessão e o desktop, sem publicar o conteúdo completo das variáveis de ambiente.

## Verificações executadas

No checkout, com Node.js 24 ou posterior:

```bash
npm ci
npm test -- test/platform.test.ts
npm run typecheck
npm test
npm run build
```

Resultados observados:

| Verificação | Resultado |
|---|---|
| Testes de plataforma | 22 aprovados, 6 ignorados por plataforma |
| Typecheck | Aprovado |
| Suíte completa | 32 arquivos aprovados; 261 testes aprovados, 14 ignorados |
| Build | Aprovado |
| Abertura real do Ghostty pelo retorno de `terminalCommand` | Comando executado e marcador em arquivo temporário confirmado |
| Abertura real do Kitty pelo retorno de `terminalCommand` | Comando executado e marcador em arquivo temporário confirmado |
| Abertura real do Alacritty pelo retorno de `terminalCommand` | Comando executado e marcador em arquivo temporário confirmado |
| Electron com `--ozone-platform=wayland` | Janela visível, `.sidebar` presente e nenhum evento `pageerror` observado no teste básico |
| API de notificações | `Notification.isSupported()` retornou `true`; entrega de notificação não testada |
| Chaveiro do Electron | `isEncryptionAvailable()` retornou `false`, backend `basic_text` |

Os testes ignorados não contam como funcionalidades verificadas. Não houve autenticação real nem consumo de tokens: a inicialização usou `TUCANO_FAKE_ENGINES=1` e dados temporários. O teste gráfico não cobre todos os fluxos da interface.

### Ghostty, Kitty e Alacritty

No Linux, Ghostty e Alacritty aceitam `-e` seguido do programa e seus argumentos; Kitty recebe o programa diretamente. O Tucano passa `sh`, `-c` e o comando de login como argumentos separados e mantém o shell aberto após o comando, como nos demais terminais Linux. Terminais de desktop já priorizados continuam tendo preferência quando também estão instalados.

O suporte a Kitty e Alacritty já existia. Esta contribuição adiciona Ghostty e testes de regressão para os três terminais, incluindo caminhos de executável com espaços e a prioridade dos terminais de desktop. A seleção segue a ordem da lista do Tucano; ela não consulta qual terminal foi configurado como padrão na sessão.

Para repetir a execução real do comando produzido pelo Tucano em cada um dos três terminais instalados, rode na raiz do checkout:

```bash
node --input-type=module <<'NODE'
import { terminalCommand } from './src/core/platform.ts'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const bin of ['ghostty', 'kitty', 'alacritty']) {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-terminal-'))
  try {
    const marker = join(dir, 'result')
    const terminal = terminalCommand(`printf '%s' 'ok' > '${marker}'`, 'linux', candidate => candidate === bin)
    if (!terminal) throw new Error(`${bin} was not selected`)
    const result = spawnSync(terminal.bin, terminal.args, {
      env: { ...process.env, SHELL: '/bin/true' },
      timeout: 15000
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${bin} exited with ${result.status}: ${result.stderr}`)
    if (readFileSync(marker, 'utf8') !== 'ok') throw new Error(`${bin} marker check failed`)
    console.log(`${bin} check passed`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
NODE
```

`SHELL=/bin/true` vale somente para o processo do teste e fecha a janela após a execução. A preservação do shell interativo está coberta pela composição dos argumentos no teste unitário; a interação manual com esse shell e o login OAuth ainda precisam de validação.

## Verificações pendentes no desktop

Depois de `npm run build`, abra uma instância separada com dados temporários e agentes simulados. Feche o aplicativo pelo menu de saída antes de remover a pasta temporária:

```bash
validation_data=$(mktemp -d)
TUCANO_DATA="$validation_data" TUCANO_FAKE_ENGINES=1 \
  ./node_modules/.bin/electron . --ozone-platform=wayland
rm -r -- "$validation_data"
```

| Área | O que verificar |
|---|---|
| Chaveiro | Confirmar um serviço Secret Service ou KWallet disponível e desbloqueado na sessão; verificar que o Electron seleciona um backend seguro antes de testar o armazenamento de uma credencial descartável |
| Bandeja do Noctalia | Confirmar ícone visível, reabertura após fechar a janela e saída pelo menu da bandeja |
| Notificações | Confirmar entrega, clique e retorno à conversa |
| Terminais e autenticação | Pedir o login pela interface, concluir o fluxo com um harness e verificar o retorno ao Tucano; repetir com cada terminal a validar |
| Autostart | Com uma instalação persistente, ativar a opção e conferir `~/.config/autostart/tucano.desktop` (ou o diretório de `XDG_CONFIG_HOME`); depois testar um novo login na sessão |
| AppImage | Conferir abertura, menu de aplicativos, recursos empacotados e atualização |

A instalação de `gnome-keyring` estava presente no ambiente testado, mas isso não bastou para disponibilizar criptografia ao Electron. O Tucano recusa gravar credenciais com `basic_text` ou sem criptografia disponível. Não force esse backend para contornar a proteção e não use credenciais reais enquanto o chaveiro não estiver funcional.

O Tucano grava uma entrada XDG para autostart no Linux. A execução dessa entrada depende da configuração da sessão Niri. Não ative autostart a partir do checkout ou da instância temporária acima: o executável de desenvolvimento não representa uma instalação persistente.

Ao reportar um resultado, inclua versão ou commit do Tucano, distribuição, compositor, terminal, forma de instalação, etapas executadas e resultado esperado/observado. Não inclua tokens, credenciais ou logs sem revisão.
