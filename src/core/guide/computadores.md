# Computador, pastas, GitHub e navegador
> Onde um agente roda comandos (Linux isolado ou este computador), pastas emprestadas, serviços no ar e o navegador do agente.

## O computador do agente
Na página do agente, aba **Ferramentas** › **Computador**:
- **Nenhum**: só conversa, web e navegador.
- **Linux isolado**: um computador só dele, separado do seu, num contêiner do Docker. Instala e roda o que precisar sem pedir. A pasta de trabalho é `/work`. Precisa do Docker aberto (Docker Desktop no Mac e no Windows). Liga sozinho quando ele precisar; há **Ligar agora**, **Reiniciar** e **Apagar computador** (apaga tudo, inclusive `/work`).
- **Este computador**: os comandos rodam direto no seu computador, como você. É preciso confirmar em **Liberar o computador pra ele**. Os comandos começam na pasta dele (**Abrir pasta dele**). Não precisa do Docker nem de pastas emprestadas: ele alcança as suas pastas direto. Na barra lateral, o agente ganha a marca "no seu computador".

Com computador, o agente cria arquivos, roda comandos e sobe sites e apps pra você ver.

## Serviços
Um site ou app que o agente sobe aparece com a **porta** e o estado (**no ar** ou **parado**): **Abrir** mostra ao lado, **Parar** derruba. **Parar serviços** para todos. Se um serviço parou, peça pro agente subir de novo.

## Pastas do seu computador
Em **Pastas do seu computador**, **Emprestar pasta…** dá ao agente a pasta de um projeto. Pra cada uma: **Só ler** ou **Pode mudar**, e **Devolver**. Ele mexe nos arquivos de verdade, então use git pra poder desfazer. Emprestar ou devolver reinicia o computador do agente: os serviços param, o que ele instalou fica.

## GitHub
Pra publicar no GitHub (criar uma branch, mandar arquivos, abrir uma PR), o agente usa o **conector do GitHub** (em **Conectores**) com **Ler e escrever**, com as permissões e aprovações de qualquer conector. No **Linux isolado** não há credenciais: `git push` não funciona nele. Em **Este computador**, `git push` roda com as credenciais do git que você já tem. Se um agente disser que "a sessão é só leitura", confira se ele tem **Ler e escrever** no GitHub e se **Subir commits (push)** ou **Abrir pull request** não estão em **Nunca**.

## O navegador do agente
Na aba **Ferramentas**, **Navegador**: um Chrome só dele, com logins separados dos seus. Ele abre páginas, clica, preenche e lê como uma pessoa. Um clique que compra, publica, envia ou apaga pede sua aprovação.
- Você acompanha no painel **Navegador de …**. Pra entrar numa conta, resolver um código ou captcha: **Assumir**, faça o que precisa e **Devolver**.
- **Abrir o navegador dele** abre a janela pra você entrar nas contas antes.
- **Apagar logins** tira os logins, cookies e histórico dele.
- Em **Configurações › Agentes** › **Navegador dos agentes**: achar o que clicar **Só pelo texto da página** (de graça) ou com o Jev, da TypeSafe (manda a lista de elementos, às vezes o print, pra TypeSafe).

## Quando dá errado
- **sem Docker** / "Precisa do Docker aberto": abra o Docker Desktop e clique em **Verificar de novo**.
- **não ligou**: tente ligar de novo; se continuar, **Apagar computador** e começar do zero.
