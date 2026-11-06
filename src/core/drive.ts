// src/core/drive.ts
// Backup do banco do Tucano para o Google Drive (issue #81)
// Cliente OAuth 2.0 + Drive API v3. Nenhuma credencial é gravada aqui.
//
// Fluxo:
//  1. connect(): PKCE + loopback 127.0.0.1, obtém access_token + refresh_token
//  2. upload(dbFile): upload resumable do .db para a pasta "Tucano Backups"
//  3. pruneDriveBackups(): mantém no máximo 7 backups no Drive
//  4. status(): último upload, erro, conectado?
//
// Tokens são guardados via Secrets (safeStorage do Electron) em
// `backup:gdrive:oauth_tokens`, nunca em variável de ambiente nem em repo.

import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import type { Secrets } from './secrets.ts'

const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const FOLDER_NAME = 'Tucano Backups'
const KEEP_DRIVE_BACKUPS = 7
const STATE_KEY = 'backup:gdrive:oauth_tokens'
const STATUS_KEY = 'backup:gdrive:status'
const PKCE_VERIFIER_KEY = 'backup:gdrive:pkce_verifier'
const PKCE_STATE_KEY = 'backup:gdrive:pkce_state'

type OpenUrl = (url: string) => Promise<void>

export interface DriveTokens {
  access_token: string
  refresh_token: string
  expires_at: number // epoch ms
}

export interface DriveStatus {
  connected: boolean
  lastUpload?: string // ISO
  lastError?: string
  folderId?: string
}

interface TokenPayload {
  access_token: string
  refresh_token?: string
  expires_in: number
}

interface FileMeta {
  id: string
  name: string
  createdTime: string
  size?: string
}

export class DriveBackup {
  private secrets: Secrets
  private clientId: string
  private clientSecret: string
  private openUrl: OpenUrl
  private port: number

  constructor(secrets: Secrets, clientId: string, clientSecret: string, openUrl: OpenUrl, port = 0) {
    this.secrets = secrets
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.openUrl = openUrl
    this.port = port
  }

  /* ---------- estado ---------- */

  async isConnected(): Promise<boolean> {
    const t = await this.secrets.getJson<DriveTokens>(STATE_KEY)
    return Boolean(t && t.access_token && t.refresh_token && t.expires_at > Date.now() + 60_000)
  }

  async status(): Promise<DriveStatus> {
    const connected = await this.isConnected()
    if (!connected) return { connected: false }
    const last = await this.secrets.getJson<{ lastUpload?: string; lastError?: string; folderId?: string }>(
      'backup:gdrive:status'
    )
    return {
      connected: true,
      lastUpload: last?.lastUpload,
      lastError: last?.lastError,
      folderId: last?.folderId,
    }
  }

  async setStatus(patch: Partial<DriveStatus>): Promise<void> {
    const cur = (await this.secrets.getJson<Record<string, unknown>>('backup:gdrive:status')) ?? {}
    await this.secrets.setJson('backup:gdrive:status', { ...cur, ...patch })
  }

  /* ---------- OAuth ---------- */

  private pkce(): { verifier: string; challenge: string } {
    const verifier = bufferToBase64url(randomBytes(32))
    const challenge = sha256(verifier)
    return { verifier, challenge }
  }

  private startLoopbackServer(): Promise<{ port: number; waitForCallback: () => Promise<{ code: string; state: string }> }> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url || '', `http://localhost:${this.port}`)
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        if (error || !code || !state) {
          res.end('<h1>Falha na autorização</h1><p>Feche esta janela e tente novamente.</p>')
          return
        }
        res.end('<h1>Autorizado!</h1><p>Você pode fechar esta janela.</p>')
        server.close()
        callbackResolve({ code, state })
      })
      let callbackResolve: (v: { code: string; state: string }) => void = () => {}
      const waitForCallback = (): Promise<{ code: string; state: string }> =>
        new Promise((res) => {
          callbackResolve = res
        })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo
        this.port = addr.port
        resolve({ port: addr.port, waitForCallback })
      })
      server.on('error', reject)
    })
  }

  async connect(): Promise<void> {
    const { verifier, challenge } = this.pkce()
    const state = bufferToBase64url(randomBytes(16))
    await this.secrets.set(PKCE_VERIFIER_KEY, verifier)
    await this.secrets.set(PKCE_STATE_KEY, state)

    // Inicia servidor loopback para capturar o callback do Google
    const { port, waitForCallback } = await this.startLoopbackServer()
    const redirectUri = `http://127.0.0.1:${port}`
    const authUrl =
      `${AUTH_URL}?` +
      `client_id=${encodeURIComponent(this.clientId)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent(SCOPE)}&` +
      `code_challenge=${encodeURIComponent(challenge)}&` +
      `code_challenge_method=S256&` +
      `access_type=offline&` +
      `prompt=consent&` +
      `state=${encodeURIComponent(state)}`

    // Abre o navegador do sistema (main process já tem shell.openExternal disponível)
    await this.openUrl(authUrl)

    const { code: finalCode, state: finalState } = await waitForCallback()
    if (finalState !== state) throw new Error('state mismatch — possível CSRF')

    const verifierStored = await this.secrets.get(PKCE_VERIFIER_KEY)
    if (verifierStored !== verifier) throw new Error('verifier mismatch')

    const payload = await exchangeCodeForTokens(
      finalCode,
      verifier,
      redirectUri,
      this.clientId,
      this.clientSecret
    )
    await this.secrets.setJson(STATE_KEY, {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token ?? '',
      expires_at: Date.now() + payload.expires_in * 1000 - 60_000,
    })
    await this.setStatus({ lastError: undefined })
  }

  /* ---------- Drive API ---------- */

  private async accessToken(): Promise<string> {
    const t = await this.secrets.getJson<DriveTokens>(STATE_KEY)
    if (!t) throw new Error('Drive não conectado')
    if (t.expires_at <= Date.now() + 60_000) {
      return await this.refreshAccessToken(t.refresh_token)
    }
    return t.access_token
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) throw new Error(`refresh falhou: ${res.status}`)
    const data = await (await res.json()) as TokenPayload
    const t = await this.secrets.getJson<DriveTokens>(STATE_KEY)
    await this.secrets.setJson(STATE_KEY, {
      ...t,
      access_token: data.access_token,
      expires_at: Date.now() + data.expires_in * 1000 - 60_000,
    })
    return data.access_token
  }

  private async findOrCreateFolder(token: string): Promise<string> {
    // procura pasta existente
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.folder'+and+name='${encodeURIComponent(FOLDER_NAME)}'+and+trashed=false&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!listRes.ok) throw new Error(`list folders: ${listRes.status}`)
    const data = await (await listRes.json()) as { files: Array<{ id: string }> }
    if (data.files.length > 0) return data.files[0]!.id

    // cria
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    })
    if (!createRes.ok) throw new Error(`create folder: ${createRes.status}`)
    const created = await (await createRes.json()) as { id: string }
    return created.id
  }

  async upload(dbFilePath: string): Promise<string> {
    const token = await this.accessToken()
    const folderId = await this.findOrCreateFolder(token)
    const stat = statSync(dbFilePath)
    const fileName = `tucano-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.db`

    // Inicia upload resumable
    const initRes = await fetch(DRIVE_UPLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(stat.size),
      },
      body: JSON.stringify({ name: fileName, parents: [folderId] }),
    })
    if (!initRes.ok) throw new Error(`init upload: ${initRes.status}`)
    const uploadUrl = initRes.headers.get('Location')
    if (!uploadUrl) throw new Error('Location header ausente no init de upload')

    // Lê o arquivo inteiro (backups SQLite são pequenos; se crescer, mudar para stream)
    const fileBuffer = readFileSync(dbFilePath)
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stat.size),
      },
      body: fileBuffer as unknown as BodyInit,
    })
    if (!putRes.ok) throw new Error(`upload PUT: ${putRes.status}`)

    await this.setStatus({ lastUpload: new Date().toISOString(), lastError: undefined, folderId })
    await this.pruneDriveBackups(token, folderId)
    return fileName
  }

  private async pruneDriveBackups(token: string, folderId: string): Promise<void> {
    const listRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType!='application/vnd.google-apps.folder'+and+trashed=false&orderBy=createdTime&fields=files(id,name,createdTime)&pageSize=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!listRes.ok) return
    const data = await (await listRes.json()) as { files: FileMeta[] }
    const toDelete = data.files.slice(0, Math.max(0, data.files.length - KEEP_DRIVE_BACKUPS))
    for (const f of toDelete) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    }
  }

  async disconnect(): Promise<void> {
    const t = await this.secrets.getJson<DriveTokens>(STATE_KEY)
    if (t?.refresh_token) {
      try {
        await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            token: t.refresh_token,
            // revoke usa 'token' não 'refresh_token'? Doc: revoke aceita token ou refresh_token
          }),
        })
      } catch {
        // ignora falha de revogação
      }
    }
    await this.secrets.setJson(STATE_KEY, null as unknown as DriveTokens)
    await this.setStatus({ connected: false, folderId: undefined })
  }
}

/* ---------- auxiliares ---------- */

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url')
}

function bufferToBase64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<TokenPayload> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`troca de code falhou (${res.status}): ${txt}`)
  }
  return (await res.json()) as TokenPayload
}

declare function openUrl(url: string): Promise<void>
// implementado pelo caller (main process do Electron: shell.openExternal)
