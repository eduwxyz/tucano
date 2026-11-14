# Company network, proxy and antivirus
> A connector that only fails on one network: a certificate that isn't accepted (a proxy or antivirus inspecting HTTPS), proxy, DNS, firewall, and what to do in each case.

When a connector does not connect, Tucano says why, and **See details**, on the connector's page, shows what the system answered (the code, such as `SELF_SIGNED_CERT_IN_CHAIN`). A quick test: try it on another network (your phone sharing its connection). If it works there, it is the network.

## The server's certificate was not accepted
A company proxy or an antivirus that checks HTTPS (Kaspersky, Avast, ESET, Bitdefender…) opens the connection and signs it again with a root certificate of its own. Tucano trusts the system's root certificates (Keychain on the Mac, the certificate store on Windows), besides its own:
- Antivirus: turn off its HTTPS checking (or "web protection"), or put the connector's address in its exceptions.
- Company: ask IT for the root certificate and install it in the system; on a company computer it is usually already there.
- **Expired or not valid yet**: check the computer's date and time.

## The proxy refused, or asks for a login
Tucano uses the system network settings' proxy (a PAC one included), read when the app opens, or the one in `HTTPS_PROXY` / `HTTP_PROXY`, which comes first. With a login: `HTTPS_PROXY=http://user:password@proxy:port`. A SOCKS proxy is not used. Changed the proxy? Reopen Tucano.

## I could not find the address (DNS)
Check the connector's address. On a VPN or a company network, its DNS may not know the server: try outside the VPN.

## It refused the connection, or the connection dropped in the middle
A network firewall, a proxy or an antivirus may be blocking the address. Ask IT to allow the connector's address (for example `api.githubcopilot.com` for GitHub).

## On a server
On a server (see **servidor**) the same variables: `HTTPS_PROXY`, `NO_PROXY`. The root certificates are the system's (`/etc/ssl`).
