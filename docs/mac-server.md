# Tucano server on your Mac

One Tucano, always on, on your Mac. Your Mac, your Windows PC and (next) your iPhone all open the same agents, channels and conversations. Tailscale connects them over a private network with HTTPS, without opening any port to the internet.

Everything below runs in the Mac's **Terminal**.

## 1. Tools (once)

```bash
# Homebrew, if `brew` doesn't exist yet
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install node@24 git
brew link --overwrite --force node@24
node -v   # v24.x

# Claude Code on the Mac: the server's agents run with it (sign in when it asks)
curl -fsSL https://claude.ai/install.sh | bash
claude    # sign in, then /exit

# Tailscale: the private network between your devices
brew install --cask tailscale
open -a Tailscale   # sign in to your account (the same one you'll use on Windows and the iPhone)
```

## 2. Tucano from the fork (once)

```bash
git clone -b visant/build https://github.com/pedrojaques99/tucano.git ~/tucano-server
cd ~/tucano-server
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci   # the server doesn't need Electron
npm run build
```

## 3. Bring the Windows data (once, optional)

Copy `tucano-para-mac.db` (it's in the Windows PC's Downloads) to the Mac's Downloads, via AirDrop, Drive or a USB stick. Then:

```bash
mkdir -p ~/.tucano-server
cp ~/Downloads/tucano-para-mac.db ~/.tucano-server/tucano.db
```

Agents, skills, channels, conversations, routines and memories come along. **Connector logins and keys don't**: they were encrypted with the Windows key. On the server, each connector asks you to authorize it again.

## 4. Turn it on

```bash
cd ~/tucano-server
npm run server
```

Leave this window open: Tucano is running. To keep it on by itself, see step 7.

## 5. HTTPS on the private network (in another Terminal window)

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 7337
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status   # shows https://<your-mac>.<your-tailnet>.ts.net
```

Copy that `https://…ts.net` address. Stop the server (Ctrl+C in the first window) and start it again with it:

```bash
cd ~/tucano-server
TUCANO_URL=https://<your-mac>.<your-tailnet>.ts.net TUCANO_TRUST_PROXY=1 npm run server
```

## 6. Connect the apps

In another window, create a link valid for one day:

```bash
cd ~/tucano-server
TUCANO_URL=https://<your-mac>.<your-tailnet>.ts.net npm run server -- pair 1440
```

It prints a `tucano://connect?...` link and an `https://...?code=...` link.

- **Desktop app (Mac and Windows):** Settings › Servers › Connect to a server › paste the `tucano://connect…` link. On Windows, Tailscale has to be installed and signed in to the same account.
- **Browser:** open the `https://…?code=…` link.
- **iPhone (next step):** the same `tucano://connect…` link, with Tailscale on the phone.

Each link works once. Run `pair` again for each device.

## 7. Keep it on by itself (optional)

Save this as `~/Library/LaunchAgents/sh.tucano.server.plist` (replace `YOU` with your Mac user and the address):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>sh.tucano.server</string>
  <key>WorkingDirectory</key><string>/Users/YOU/tucano-server</string>
  <key>ProgramArguments</key><array><string>/opt/homebrew/bin/npm</string><string>run</string><string>server</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/Users/YOU/.local/bin</string>
    <key>TUCANO_URL</key><string>https://your-mac.your-tailnet.ts.net</string>
    <key>TUCANO_TRUST_PROXY</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/tucano-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/tucano-server.log</string>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/sh.tucano.server.plist
tail -f /tmp/tucano-server.log    # Ctrl+C to stop watching
```

For it to stay reachable, the Mac can't sleep: System Settings › Battery (or Energy) › prevent sleep when the display is off.

## Updating

```bash
cd ~/tucano-server && git pull && npm ci && npm run build
launchctl kickstart -k gui/$(id -u)/sh.tucano.server   # or Ctrl+C and `npm run server` again
```

## Good to know

- Server mode is **experimental** in Tucano.
- The agents run commands **on the Mac**, with your user.
- Don't run the Tucano desktop app on the Mac against the same folder (`~/.tucano-server`). The desktop app has its own data and connects to the server under Settings › Servers, which is how it should be.
