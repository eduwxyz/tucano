# Quando algo dá errado
> Diagnóstico dos problemas comuns: agente que não responde, motor sem login, conector pedindo login ou falhando, Docker desligado, limites, rotina que não rodou, aprovação expirada, notificação que não chega.

## O agente não responde
1. Os agentes estão pausados? O botão no topo da barra lateral mostra o ▶ (**Retomar os agentes deste workspace**) e a conversa mostra a nota de pausa. Clique pra retomar.
2. O motor dele está pronto? **Configurações › Modelos**: **Falta entrar** pede **Entrar**; **Não instalado** pede **Instalar**. Uma conta extra que não entrou deixa o agente sem responder.
3. Ele bateu o limite do mês? **Uso e limites** mostra "Bateu o limite". Suba o limite na página dele.
4. Num canal, ninguém foi escolhido? Chame com @handle, ou confira se ele está no canal e se o **Papel** descreve o que faz.
5. Arquivado? Agentes arquivados não respondem. **Arquivados** › **Reativar**.

## A resposta falhou ou parou
- O passo com falha mostra o motivo; **Tentar de novo** repete.
- "Interrompido: o app fechou no meio da resposta": **Tentar de novo**.
- Pausou no teto da resposta: **Continuar**, ou suba o **Limite por resposta**.
- Cortada por loop ou por ficar travada: reformule o pedido em partes menores.
- A assinatura acabou (Claude, ChatGPT…): espere a janela zerar (**Uso e limites** mostra quando) ou dê ao agente um **Modelo reserva**.

## Conector
- **precisa autorizar**: **Autorizar no navegador** na página do conector.
- **não conectou**: **Conectar de novo**; se continuar, confira o endereço e o login (token novo em **Token (substitui o atual)**).
- O agente não vê a ferramenta: o nível do agente pro conector (**Ler** só mostra as de leitura), a ferramenta ligada na página do conector, e **Atualizar ferramentas**.
- Não conecta só numa rede (empresa, proxy, antivírus): a mensagem diz o motivo; veja **rede**.

## Computador do agente
- **sem Docker**: abra o Docker Desktop e **Verificar de novo**.
- **não ligou**: **Reiniciar**; se continuar, **Apagar computador**.
- Um serviço parou: peça pro agente subir de novo.

## Rotina que não rodou
- O app estava fechado por mais de 12 h depois do horário, ou estava no **Horário de silêncio**, ou os agentes estavam pausados.
- O agente foi arquivado (as rotinas dele desligam) ou a rotina está desligada.
- Uma rotina de conector só dispara com item novo; **Testar agora** mostra o que ela vê.
- Ficou esperando aprovação: decida em **Aprovações**.

## Aprovação
- Expirou: nada aconteceu. Peça de novo ao agente. O prazo fica em **Configurações › Agentes** › **Limites** › **Expiração de aprovações**.
- Aprovou e não viu o resultado: ele chega numa nova mensagem do agente.

## Notificação que não chega
- **Configurações › Geral › Notificações** › **Testar notificações** mostra os cartões. No Mac, o Tucano só aparece em Ajustes do Sistema › Notificações depois do primeiro aviso.
- No Mac: Ajustes do Sistema › Notificações › Tucano permitido, e nenhum modo Foco ligado.
- A conversa aberta na tela não avisa.
- Servidor: avisa pelo app do computador conectado a ele em **Configurações › Servidores**. O navegador só avisa por HTTPS. Veja **servidor**.

## Microfone (ditado)
- "O microfone está bloqueado": libere o Tucano nas configurações de privacidade do sistema (no Mac, Ajustes do Sistema › Privacidade e Segurança › Microfone).
- "Não chegou som do microfone": confira qual microfone está em uso nas configurações de som do sistema.

## Apps do computador
"Falta a permissão de Acessibilidade": libere o Tucano em Ajustes › Privacidade e Segurança › Acessibilidade (no Mac).
