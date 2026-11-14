# Phone (iPhone and Telegram)
> The Tucano app on the iPhone, over the home Wi-Fi; or approvals, questions and the end of routines in your Telegram, with a bot of your own.

## Your iPhone
The Tucano app for the iPhone signs in as you on this computer: your conversations, approvals and the agents' questions. It works on the home Wi-Fi, with the computer on.
1. In **Settings › Phone**, the **Your iPhone** card, click **Connect my iPhone**.
2. Keep the iPhone on the same Wi-Fi. In the Tucano app, tap the QR code icon and point it at the code. It is good for one use, for 10 minutes.
3. When the iPhone asks for access to the local network, tap **Allow**. If the computer asks whether Tucano may accept connections, allow it (on Windows, on private networks; on Linux with a firewall, open the port the card shows).

It stays on after you close and open the app, until **Turn off**. Only devices on the home network get an answer, and the QR carries this computer's certificate fingerprint: another device on the Wi-Fi cannot pass for it. Away from home the iPhone cannot reach the computer; for that, Tucano on a server, or Tucano Pro.

## Telegram
With a Telegram bot of your own you decide approvals, answer the agents' questions (just reply to the message) and get the end of routines from anywhere. It is what a routine asking for approval at night needs. The app fetches the messages from Telegram, so nothing has to reach your computer.

## Turning it on
1. In **Settings › Phone**, the **Phone (Telegram)** card.
2. In Telegram, open @BotFather, send `/newbot` and pick a name. It answers with a token.
3. Paste the token into **Bot token** and **Save**.
4. Open your bot in Telegram and send the code the app shows (`/start <code>`). Only whoever sends that code keeps the bot.
5. Done: the card reads **Paired with this computer**.

## What it sends
The text of approvals and questions (tool, arguments, reason) and the routines' answers. A high-risk action asks for two taps to approve. The token stays in the system keychain.

## Changing or removing it
- **Change bot**: another token.
- **Disconnect this chat**: the bot stops sending to that chat.
- **Remove bot**: takes the token out.

## Workspaces
Telegram lives in the default workspace: two workspaces cannot use the same token. In the others, the card shows a link to switch to the default.

## When it goes wrong
"The Telegram did not answer": check the internet, or change the bot's token. If another app reads the same bot, Telegram refuses: use a bot only for Tucano.
