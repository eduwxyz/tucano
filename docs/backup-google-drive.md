# Backup para o Google Drive

O Tucano pode enviar uma cópia do banco de dados (`.db`) para o Google Drive automaticamente, mantendo os 7 backups mais recentes. O backup local continua funcionando normalmente — o upload para o Drive é best-effort: se falhar, o backup local não é afetado e o erro fica visível nas configurações.

## Como funciona

- Uma vez por dia (ou quando você clica em "Fazer backup agora"), o Tucano faz `VACUUM INTO` do banco SQLite e envia a cópia para o Google Drive.
- Os backups ficam numa pasta chamada "Tucano Backups" no seu Google Drive.
- Só os 7 backups mais recentes são mantidos no Drive; os mais antigos são removidos automaticamente.
- O banco contém segredos cifrados com a chave do keychain do seu computador (conectores OAuth etc.). Esses segredos **não** são restauráveis em outra máquina — você precisará reconfigurar os conectores.

## Configuração

### 1. Criar projeto no Google Cloud Console

1. Acesse https://console.cloud.google.com/
2. Crie um novo projeto (ex.: "Tucano Backup")
3. Ative a **Google Drive API** (biblioteca → buscar "Google Drive API" → Ativar)
4. Configure a **tela de consentimento OAuth**:
   - Tipo: Externo (ou Interno, se for organização)
   - Escopos: adicione `https://www.googleapis.com/auth/drive.file`
   - Adicione seu e-mail como usuário de teste
5. Crie credenciais → ID do cliente OAuth → tipo **Aplicativo para computador (Desktop app)**
   - Anote o **Client ID** e o **Client Secret**

### 2. Configurar no Tucano

Defina as variáveis de ambiente antes de iniciar o Tucano:

```
TUCANO_GDRIVE_CLIENT_ID=seu-client-id
TUCANO_GDRIVE_CLIENT_SECRET=seu-client-secret
```

Ou preencha direto nas configurações do app: **Configurações → Backup → Conectar ao Google Drive**.

Após conectar, o navegador será aberto para você autorizar o acesso ao Google Drive. O `refresh_token` é armazenado cifrado no keychain do seu computador (mesmo mecanismo usado pelos tokens de conector).

## Como usar

Abra **Configurações → Backup** no Tucano. Você verá:

- Status da conexão (conectado/desconectado)
- Data/hora do último upload
- Eventual erro no último upload
- Botão "Fazer upload agora" para forçar um upload imediato
- Botão "Desconectar" para remover o acesso

O backup automático roda uma vez por dia (na inicialização e a cada hora, verificando se já passou 24h desde o último).

## Custos

- **API do Google Drive:** grátis dentro das cotas (1 milhão de quota units/min por projeto; um backup consome ~200 units/dia)
- **Armazenamento:** conta na cota da sua conta Google (15 GB grátis compartilhado com Gmail/Fotos)
  - Um backup de 50 MB × 7 retenção = ~350 MB (cabe no grátis)
  - Um backup de 1 GB × 7 = ~7 GB (ainda cabe no grátis)

## Limitações

- Enquanto o app OAuth estiver em modo "Testing", o `refresh_token` expira em 7 dias. Para uso duradouro, publique o app em produção no Google Cloud Console.
- O backup não inclui arquivos fora do banco (pasta `computers/` de cada agente, arquivos mostrados por agentes).
- Tokens de conector não são restauráveis em outra máquina (cifrados com o keychain local).

## Segurança

- Nenhuma credencial é gravada no repositório do Tucano.
- O `refresh_token` é cifrado com `safeStorage` do Electron (keychain do SO).
- O upload usa OAuth 2.0 com PKCE (fluxo para aplicativos desktop públicos).
- Considere usar uma conta Google dedicada para backups, em vez da sua conta pessoal.
